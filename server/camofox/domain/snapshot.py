"""
Accessibility tree snapshot system — building, filtering, windowing, and
annotating accessibility YAML snapshots for AI agent consumption.

**Important:** Playwright Python 1.59.0 does **not** have
``page.accessibility.snapshot()``.  This module uses DOM traversal via
``page.evaluate()`` instead, producing the same pipe-delimited YAML
format as the Node.js ``lib/snapshot.js``.

Usage
-----
.. code-block:: python

    yaml, refs = await build_snapshot(page)
    win = window_snapshot(yaml, offset=0)
    compact = compact_snapshot(yaml)
    filtered = filter_snapshot_dialog_artifacts(yaml)
    meta = build_dom_metadata(element_dict)
    safe = safe_node_metadata(ax_node)
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

log = logging.getLogger("camofox.snapshot")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# ~20K tokens (matches Node.js MAX_SNAPSHOT_CHARS)
MAX_SNAPSHOT_CHARS = 80000

# Keep the last ~5K chars so pagination / navigation refs are always
# visible in every chunk (matches Node.js SNAPSHOT_TAIL_CHARS).
SNAPSHOT_TAIL_CHARS = 5000

# Roles that get element refs (e1, e2, …) — the agent can click/type
# by referring to these IDs.  ``combobox`` is excluded to avoid
# accidentally triggering date-pickers.
INTERACTIVE_ROLES: list[str] = [
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "menuitem",
    "tab",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    # "combobox" — intentionally excluded
]

# Roles considered "actionable" for the compact_snapshot filter.
# This is a superset of INTERACTIVE_ROLES and includes heading etc.
ACTIONABLE_ROLES: list[str] = [
    "heading",
    "link",
    "button",
    "textbox",
    "checkbox",
    "radio",
    "menuitem",
    "tab",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "combobox",
    "listbox",
    "option",
    "treeitem",
    "menuitemcheckbox",
    "menuitemradio",
    "alert",
    "status",
    "paragraph",
    "text",
]

# Names matching these patterns are skipped (e.g. date pickers)
SKIP_PATTERNS: list[re.Pattern] = [
    re.compile(r"date", re.IGNORECASE),
    re.compile(r"calendar", re.IGNORECASE),
    re.compile(r"picker", re.IGNORECASE),
    re.compile(r"datepicker", re.IGNORECASE),
]

# Cookie / consent keywords that trigger dialog artifact filtering
COOKIE_KEYWORDS: list[str] = [
    "cookie",
    "cookies",
    "consent",
    "consentement",
    "rgpd",
    "privacy",
    "confidentialité",
]

# Attribute names considered safe for inclusion in DOM metadata
SAFE_ATTRIBUTE_NAMES: set[str] = {
    "id",
    "class",
    "name",
    "type",
    "placeholder",
    "aria-label",
    "title",
    "href",
    "data-testid",
    "data-test",
    "data-cy",
}

# Patterns that indicate sensitive values that should be redacted
SENSITIVE_TEXT_PATTERN: re.Pattern = re.compile(
    r"\b(password|passcode|secret|token|api[-_ ]?key|authorization|auth|"
    r"credential|credit card|card number|cvv|ssn)\b",
    re.IGNORECASE,
)

# Maximum number of nodes to include in a single snapshot
MAX_SNAPSHOT_NODES: int = 500

# ---------------------------------------------------------------------------
# DOM traversal JavaScript (used by build_snapshot via page.evaluate)
# ---------------------------------------------------------------------------

_DOM_TRAVERSAL_JS: str = """\
() => {
  const MAX_NODES = 500;
  const nodes = [];
  const seenElements = new WeakSet();
  let nodeIndex = 0;

  function getTag(el) {
    return (el.tagName || '').toLowerCase();
  }

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = getTag(el);
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number' || type === 'range') return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'img') return 'img';
    if (tag === 'menuitem') return 'menuitem';
    return tag;
  }

  function getText(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const title = el.getAttribute('title');
    if (title) return title;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const ph = el.getAttribute('placeholder');
      if (ph) return ph;
      if (el.value) return el.value;
    }
    if (el.tagName === 'SELECT') {
      const sel = el.options[el.selectedIndex];
      if (sel) return sel.text;
    }
    if (el.tagName === 'IMG') {
      return el.getAttribute('alt') || '';
    }
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    return text.substring(0, 160);
  }

  function getDescription(el) {
    const desc = el.getAttribute('aria-description');
    if (desc) return desc;
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const ref = document.getElementById(describedBy);
      if (ref) return (ref.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 160);
    }
    return '';
  }

  function getValue(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el.value || '';
    }
    if (el.tagName === 'SELECT') {
      return el.value || '';
    }
    return '';
  }

  function getChecked(el) {
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      return el.checked ? 'true' : 'false';
    }
    const ariaChecked = el.getAttribute('aria-checked');
    return ariaChecked !== null ? ariaChecked : null;
  }

  function getExpanded(el) {
    const ariaExpanded = el.getAttribute('aria-expanded');
    return ariaExpanded !== null ? ariaExpanded : null;
  }

  function getKeyShortcuts(el) {
    return el.getAttribute('accesskey') || el.getAttribute('aria-keyshortcuts') || '';
  }

  function isInteractive(el) {
    const role = getRole(el);
    const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch']);
    if (interactiveRoles.has(role)) return true;
    if (el.tagName === 'A' && el.href) return true;
    if (el.tagName === 'BUTTON') return true;
    if (el.tagName === 'INPUT' && !['hidden', 'submit', 'reset'].includes(el.type)) return true;
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function shouldSkip(el) {
    const tag = getTag(el);
    if (['script', 'style', 'noscript', 'head', 'meta', 'link', 'br', 'hr'].includes(tag)) return true;
    if (tag === 'svg') return true;
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    // Only skip zero-size for non-replaced elements (inline/empty)
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && tag !== 'img' && tag !== 'input' && tag !== 'select' && tag !== 'textarea') return true;
    return false;
  }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    // Build a minimal unique selector from tag + nth-child
    const tag = getTag(el);
    const parent = el.parentElement;
    if (!parent) return tag;
    let nth = 1;
    for (const child of parent.children) {
      if (child === el) break;
      if (getTag(child) === tag) nth++;
    }
    return tag + ':nth-child(' + nth + ')';
  }

  function walk(el, depth) {
    if (nodeIndex >= MAX_NODES) return;
    if (shouldSkip(el)) return;
    if (seenElements.has(el)) return;
    seenElements.add(el);

    const tag = getTag(el);
    const role = getRole(el);
    const name = getText(el);
    const description = getDescription(el);
    const value = getValue(el);
    const checked = getChecked(el);
    const expanded = getExpanded(el);
    const keyShortcuts = getKeyShortcuts(el);
    const inter = isInteractive(el);

    // Skip truly empty anonymous containers that aren't interactive
    if (!role && !name && !value && !inter && tag !== 'img' && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      // Still walk children, but don't record this node
      for (const child of el.children) walk(child, depth + 1);
      return;
    }

    nodeIndex++;
    nodes.push({
      index: nodeIndex,
      tag: tag,
      role: role,
      name: name.substring(0, 160),
      description: description,
      value: value,
      checked: checked,
      expanded: expanded,
      keyShortcuts: keyShortcuts,
      depth: depth,
      interactive: inter,
      selector: buildSelector(el),
    });

    for (const child of el.children) {
      walk(child, depth + 1);
    }
  }

  const root = document.body || document.documentElement;
  if (root) walk(root, 0);
  return nodes;
}
"""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _normalize_tag_name(value: Any) -> str:
    """Extract and normalise an HTML tag name from an arbitrary value."""
    raw = str(value or "").strip().lower()
    m = re.match(r"[a-z][a-z0-9-]*", raw)
    return m.group(0) if m else ""


def _safe_text(value: Any, *, preserve_case: bool = False) -> str:
    """Sanitise and truncate a text value (160 characters maximum).

    Strips whitespace, replaces runs of whitespace with a single space,
    lower-cases (unless *preserve_case* is ``True``), and truncates to
    160 characters.  Returns ``""`` if the text matches the
    :data:`SENSITIVE_TEXT_PATTERN`.
    """
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text or SENSITIVE_TEXT_PATTERN.search(text):
        return ""
    if preserve_case:
        return text[:160]
    return text.lower()[:160]


def _safe_attributes(attributes: dict[str, Any] | None = None) -> dict[str, str]:
    """Pick known-safe attributes and redact sensitive values.

    Only keeps attribute names in :data:`SAFE_ATTRIBUTE_NAMES`.
    Truncates all values to 160 characters.
    """
    picked: dict[str, str] = {}
    for raw_name, raw_value in (attributes or {}).items():
        name = str(raw_name or "").lower()
        if name not in SAFE_ATTRIBUTE_NAMES:
            continue
        if raw_value is None:
            continue
        value = str(raw_value)
        if SENSITIVE_TEXT_PATTERN.search(value):
            continue
        picked[name] = value[:160]
    return picked


def _compact_object(obj: dict[str, Any]) -> dict[str, Any]:
    """Remove keys whose values are ``None``, empty lists, or empty dicts."""
    result: dict[str, Any] = {}
    for key, value in obj.items():
        if value is None:
            continue
        if isinstance(value, (list, dict)) and not value:
            continue
        if value == "":
            continue
        result[key] = value
    return result


def _is_interactive_role(role: str) -> bool:
    """Return ``True`` if *role* (lower-case) is interactive."""
    return role.lower() in INTERACTIVE_ROLES


def _should_skip_name(name: str) -> bool:
    """Return ``True`` if *name* matches any skip pattern."""
    return any(p.search(name) for p in SKIP_PATTERNS)


# ---------------------------------------------------------------------------
# build_snapshot  —  walk DOM via page.evaluate and produce YAML + refs
# ---------------------------------------------------------------------------


async def build_snapshot(page) -> tuple[str, dict[str, Any]]:
    """Build a full YAML snapshot from the page's DOM tree.

    Since Playwright Python does not expose
    ``page.accessibility.snapshot()``, this function uses
    ``page.evaluate()`` to run a DOM traversal in the browser context.

    The traversal collects every visible, non-hidden element in document
    order with its tag, inferred ARIA role, text content, and ARIA
    attributes.  The result is formatted as pipe-delimited YAML-comment
    lines — the same format as the Node.js ``lib/snapshot.js``.

    Parameters
    ----------
    page
        A Playwright ``Page`` instance.

    Returns
    -------
    (yaml_text, refs)
        *yaml_text* is a string where each line looks like::

            {indent}#{idx}|{tag}|{role}|{name}|{description}|{checked}|{value}|{keyShortcuts}|{expanded}|{ref_id}

        *refs* is a dict mapping ref IDs (``e1``, ``e2``, …) to metadata
        dicts with keys ``role``, ``name``, ``nth`` (zero-based occurrence
        count), ``tag``, and ``selector`` (a CSS selector usable for
        clicking/typing on that element).
    """
    nodes = await page.evaluate(_DOM_TRAVERSAL_JS)
    if not nodes:
        return "", {}

    lines: list[str] = []
    refs: dict[str, dict[str, Any]] = {}
    seen_counts: dict[str, int] = {}  # "role:name" -> occurrence count
    ref_counter: int = 1

    for node in nodes:
        depth = node.get("depth", 0)
        idx = node.get("index", 0)
        tag = node.get("tag", "")
        role = node.get("role", "").lower()
        name = _safe_text(node.get("name", ""))
        description = _safe_text(node.get("description", ""))
        raw_checked = node.get("checked")
        checked = str(raw_checked) if raw_checked is not None else ""
        raw_value = node.get("value", "")
        value = _safe_text(str(raw_value)) if raw_value else ""
        key_shortcuts = node.get("keyShortcuts", "")
        raw_expanded = node.get("expanded")
        expanded = str(raw_expanded) if raw_expanded is not None else ""
        interactive = node.get("interactive", False)
        selector = node.get("selector", "")

        indent = "  " * depth
        idx_str = str(idx)

        # Build the pipe-delimited fields
        fields = [
            idx_str,
            tag or "",
            role,
            name or "",
            description or "",
            checked,
            value or "",
            key_shortcuts,
            expanded,
        ]

        # Assign a ref ID for interactive elements
        ref_id = ""
        if interactive and _is_interactive_role(role) and not _should_skip_name(name):
            key = f"{role}:{name}"
            nth = seen_counts.get(key, 0)
            seen_counts[key] = nth + 1
            ref_id = f"e{ref_counter}"
            ref_counter += 1
            refs[ref_id] = {
                "role": role,
                "name": name,
                "nth": nth,
                "tag": tag,
                "selector": selector,
            }

        line = f"{indent}#{'|'.join(fields)}"
        if ref_id:
            line += f"|{ref_id}"
        lines.append(line)

    return "\n".join(lines), refs


# ---------------------------------------------------------------------------
# window_snapshot  —  paginate a large YAML snapshot
# ---------------------------------------------------------------------------


def window_snapshot(yaml: str, offset: int = 0) -> dict[str, Any]:
    """Window the YAML snapshot for paginated reading.

    If the full *yaml* text fits within ``MAX_SNAPSHOT_CHARS``, it is
    returned unchanged.  Otherwise a chunk from *offset* is returned
    together with the last ``SNAPSHOT_TAIL_CHARS`` characters (so that
    pagination / navigation links at the bottom of the page are always
    visible).

    Parameters
    ----------
    yaml
        The full snapshot YAML text.
    offset
        Character offset into the YAML for the start of the chunk
        (default 0).

    Returns
    -------
    dict
        With keys ``text``, ``truncated``, ``total_chars``, ``offset``,
        ``has_more``, ``next_offset``.
    """
    if not yaml:
        return {
            "text": "",
            "truncated": False,
            "total_chars": 0,
            "offset": 0,
            "has_more": False,
            "next_offset": None,
        }

    total = len(yaml)
    if total <= MAX_SNAPSHOT_CHARS:
        return {
            "text": yaml,
            "truncated": False,
            "total_chars": total,
            "offset": 0,
            "has_more": False,
            "next_offset": None,
        }

    content_budget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200  # room for marker
    tail = yaml[-SNAPSHOT_TAIL_CHARS:]
    clamped_offset = max(0, min(offset, total - SNAPSHOT_TAIL_CHARS))
    chunk = yaml[clamped_offset : clamped_offset + content_budget]
    chunk_end = clamped_offset + content_budget
    has_more = chunk_end < total - SNAPSHOT_TAIL_CHARS

    if has_more:
        marker = (
            f"\n[... truncated at char {chunk_end} of {total}. "
            f"Call snapshot with offset={chunk_end} to see more. "
            f"Pagination links below. ...]\n"
        )
    else:
        marker = "\n"

    return {
        "text": chunk + marker + tail,
        "truncated": True,
        "total_chars": total,
        "offset": clamped_offset,
        "has_more": has_more,
        "next_offset": chunk_end if has_more else None,
    }


# ---------------------------------------------------------------------------
# compact_snapshot  —  keep only interactive / actionable lines
# ---------------------------------------------------------------------------


def compact_snapshot(yaml: str) -> str:
    """Filter the YAML snapshot to only actionable element types.

    Strips out non-interactive / non-actionable lines, keeping those
    that match roles in :data:`ACTIONABLE_ROLES` or contain element
    ref markers (``[e\\d+]``).

    This is useful when the agent only cares about clickable or
    interactable elements.
    """
    if not yaml:
        return ""

    lines = yaml.split("\n")
    kept: list[str] = []
    ref_pattern = re.compile(r"\|e\d+$")
    role_pattern = re.compile(
        r"^\s*#\d+\|[^|]*\|("
        + "|".join(re.escape(r) for r in ACTIONABLE_ROLES)
        + r")\|",
        re.IGNORECASE,
    )

    for line in lines:
        if ref_pattern.search(line) or role_pattern.match(line):
            kept.append(line)

    return "\n".join(kept)


# ---------------------------------------------------------------------------
# filter_snapshot_dialog_artifacts  —  strip cookie/consent banners
# ---------------------------------------------------------------------------


def filter_snapshot_dialog_artifacts(
    yaml: str,
    accepted_dialog_names: Optional[list[str]] = None,
    cookie_banner_keywords: Optional[list[str]] = None,
) -> str:
    """Strip cookie / consent dialog entries from the snapshot.

    Scans the *yaml* for cookie/consent-related keywords.  If any are
    found, dialog blocks whose names are not in *accepted_dialog_names*
    are removed from the output.  Dialog names are matched
    case-insensitively.

    Parameters
    ----------
    yaml
        The snapshot YAML text.
    accepted_dialog_names
        List of dialog names that should be *kept* even when cookie
        signals are present (e.g. ``["Se connecter"]``).
    cookie_banner_keywords
        Additional keywords to detect cookie banners (merged with
        :data:`COOKIE_KEYWORDS`).

    Returns
    -------
    str
        Filtered YAML text.
    """
    if not yaml or not isinstance(yaml, str):
        return yaml or ""

    confirmed = set(
        str(n or "").strip().lower()
        for n in (accepted_dialog_names or [])
        if n
    )
    extra_keywords = [str(v or "").lower() for v in (cookie_banner_keywords or [])]
    cookie_signals = COOKIE_KEYWORDS + extra_keywords
    lower_yaml = yaml.lower()
    has_cookie_signal = any(kw and kw in lower_yaml for kw in cookie_signals)
    if not has_cookie_signal:
        return yaml

    lines = yaml.split("\n")
    kept: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Match a dialog line in our pipe-delimited format.
        # Names may be quoted (Node.js accessibility tree) or bare (DOM).
        match = re.match(
            r"^(\s*)#\d+\|[^|]*\|dialog\|\"?([^\"|]+)\"?\|",
            line,
            re.IGNORECASE,
        )
        if not match:
            kept.append(line)
            i += 1
            continue

        indent_str = match.group(1)
        raw_name = match.group(2).strip().lower()
        if raw_name in confirmed:
            kept.append(line)
            i += 1
            continue

        # Skip this dialog block and all its children
        indent_len = len(indent_str)
        i += 1
        while i < len(lines):
            child = lines[i]
            if not child.strip():
                i += 1
                continue
            child_indent = len(child) - len(child.lstrip())
            if child_indent <= indent_len:
                break
            i += 1
        # i now points to the first line after the dialog block

    return "\n".join(kept)


# ---------------------------------------------------------------------------
# build_dom_metadata  —  safe DOM metadata from a Playwright element
# ---------------------------------------------------------------------------


def _element_text(element: Any) -> str:
    """Extract display text from an element-like object."""
    if element is None:
        return ""
    if isinstance(element, dict):
        for key in ("innerText", "textContent", "name", "label", "axName"):
            val = element.get(key)
            if val:
                return str(val)
    else:
        for attr in ("innerText", "textContent", "name", "label", "axName"):
            try:
                val = getattr(element, attr, None)
                if val:
                    return str(val)
            except (AttributeError, TypeError):
                pass
    return ""


def _attributes_from_element(element: Any) -> dict[str, str]:
    """Extract attributes from a Playwright element or element dict."""
    if element is None:
        return {}
    if isinstance(element, dict):
        attrs = element.get("attributes", {})
        return attrs if isinstance(attrs, dict) else {}
    return {}


def _related_element_metadata(
    element: Any,
    *,
    include_text: bool = True,
    preserve_case: bool = False,
) -> dict[str, Any]:
    """Build a compact metadata dict for a related (parent/sibling) element."""
    if element is None:
        return {}
    tag = _normalize_tag_name(
        _resolve_attr(element, ("tag", "tagName", "nodeName"))
    )
    result: dict[str, Any] = {}
    if tag:
        result["tag"] = tag
    if include_text:
        text = _safe_text(_element_text(element), preserve_case=preserve_case)
        if text:
            result["text"] = text
    attrs = _safe_attributes(_attributes_from_element(element))
    if attrs:
        result["attributes"] = attrs
    return _compact_object(result)


def _resolve_attr(element: Any, names: tuple[str, ...]) -> Any:
    """Try to get an attribute by any of *names* from an element."""
    for name in names:
        try:
            if isinstance(element, dict):
                val = element.get(name)
            else:
                val = getattr(element, name, None)
            if val is not None:
                return val
        except (AttributeError, TypeError):
            pass
    return None


def _tag_path_for_element(element: Any) -> list[str]:
    """Build a tag path from document root to *element* (max 32 entries)."""
    path: list[str] = []
    cursor = element
    guard = 0
    while cursor is not None and guard < 32:
        tag = _normalize_tag_name(
            _resolve_attr(cursor, ("tag", "tagName", "nodeName"))
        )
        if tag:
            path.insert(0, tag)
        cursor = _resolve_attr(cursor, ("parentElement", "parent"))
        guard += 1
    return path


def _sibling_tags_for_element(element: Any) -> list[dict[str, Any]]:
    """Return metadata for siblings of *element* (maximum 8)."""
    parent = _resolve_attr(element, ("parentElement", "parent"))
    siblings: list[Any] = []

    if parent is not None:
        children = _resolve_attr(parent, ("children", "childNodes"))
        if isinstance(children, (list, tuple)):
            siblings = [
                c for c in children if c is not None and c is not element
            ][:8]
            if siblings:
                return [
                    _related_element_metadata(s, include_text=False)
                    for s in siblings
                    if _related_element_metadata(s, include_text=False)
                ]

    # Fallback: adjacent siblings
    for attr in ("previousElementSibling", "nextElementSibling"):
        sib = _resolve_attr(element, (attr,))
        if sib is not None:
            siblings.append(sib)
    return [
        _related_element_metadata(s, include_text=False)
        for s in siblings
        if _related_element_metadata(s, include_text=False)
    ]


def _child_index(element: Any) -> Optional[int]:
    """Return the child index of *element* within its parent."""
    parent = _resolve_attr(element, ("parentElement", "parent"))
    if parent is None:
        return None
    children = _resolve_attr(parent, ("children", "childNodes"))
    if not isinstance(children, (list, tuple)):
        return None
    try:
        idx = list(children).index(element)
        return idx if idx >= 0 else None
    except (ValueError, IndexError):
        return None


def _is_hidden_or_sensitive(element: Any) -> bool:
    """Return ``True`` if *element* should be excluded as hidden or sensitive."""
    tag = _normalize_tag_name(_resolve_attr(element, ("tag", "tagName", "nodeName")))
    attrs = _attributes_from_element(element)
    input_type = str(
        _resolve_attr(element, ("type",)) or attrs.get("type", "")
    ).lower()
    if tag == "input" and input_type == "hidden":
        return True
    if attrs.get("hidden") is not None or attrs.get("aria-hidden") == "true":
        return True
    return False


def build_dom_metadata(node: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Build safe DOM metadata from a Playwright element or element dict.

    Extracts:
    * ``tag`` — normalised HTML tag name
    * ``text`` — display text (sanitised, max 160 chars)
    * ``attributes`` — safe attributes only (id, class, name, type, …)
    * ``parent`` — related-element metadata for the parent
    * ``siblings`` — related-element metadata up to 8 siblings
    * ``path`` — tag path from root
    * ``depth`` — path depth
    * ``index`` — child index within parent
    * ``nearby_text`` — surrounding text snippets (max 6)

    Redacts any value matching password/secret/token patterns and
    truncates all values to 160 characters.
    """
    if node is None:
        node = {}
    if _is_hidden_or_sensitive(node):
        return {}

    tag = _normalize_tag_name(
        node.get("tag") or node.get("tagName") or node.get("nodeName", "")
    )
    text = _safe_text(
        node.get("text")
        or node.get("innerText")
        or node.get("textContent")
        or node.get("name")
        or node.get("axName")
        or node.get("label"),
        preserve_case=True,
    )
    attrs = _safe_attributes(node.get("attributes") or {})

    # Parent metadata
    parent = None
    try:
        parent_node = node.get("parent")
        if parent_node:
            parent = _related_element_metadata(parent_node, preserve_case=True)
    except Exception:
        pass

    # Siblings metadata
    siblings = None
    try:
        sib_list = node.get("siblings", [])
        if isinstance(sib_list, list) and sib_list:
            siblings = [
                _related_element_metadata(s, preserve_case=True)
                for s in sib_list
            ]
            siblings = [s for s in siblings if s][:8] or None
    except Exception:
        pass

    # Tag path
    path = None
    try:
        path_list = node.get("path", [])
        if isinstance(path_list, list) and path_list:
            path = [_normalize_tag_name(p) for p in path_list if _normalize_tag_name(p)]
            path = path or None
    except Exception:
        pass

    depth = node["depth"] if isinstance(node.get("depth"), int) else None
    index = node["index"] if isinstance(node.get("index"), int) else None

    # Nearby text
    nearby_text = None
    try:
        nearby = node.get("nearbyText", [])
        if isinstance(nearby, list) and nearby:
            nearby_text = [
                _safe_text(t, preserve_case=True)
                for t in nearby
                if _safe_text(t, preserve_case=True)
            ]
            nearby_text = nearby_text[:6] or None
    except Exception:
        pass

    return _compact_object({
        "tag": tag or None,
        "text": text or None,
        "attributes": attrs or None,
        "parent": parent,
        "siblings": siblings,
        "path": path,
        "depth": depth,
        "index": index,
        "nearby_text": nearby_text,
    })


# ---------------------------------------------------------------------------
# safe_node_metadata  —  extract safe metadata from an accessibility node dict
# ---------------------------------------------------------------------------


def safe_node_metadata(json_node: dict[str, Any]) -> dict[str, Any]:
    """Extract safe metadata from an accessibility node dict.

    Similar to :func:`build_dom_metadata` but works on raw
    accessibility-tree node dicts (from
    ``page.accessibility.snapshot()``) rather than Playwright element
    handles.

    Returns a compact dict with keys:
    ``tag``, ``text``, ``attributes``, ``role``, ``name``,
    ``value``, ``description``, ``checked``, ``expanded``.
    """
    if not json_node or _is_hidden_or_sensitive(json_node):
        return {}

    tag = _normalize_tag_name(
        json_node.get("tag") or json_node.get("tagName") or json_node.get("nodeName", "")
    )
    text = _safe_text(
        json_node.get("text")
        or json_node.get("name")
        or json_node.get("label")
        or json_node.get("value"),
        preserve_case=True,
    )
    attrs = _safe_attributes(json_node.get("attributes") or {})

    return _compact_object({
        "tag": tag or None,
        "text": text or None,
        "attributes": attrs or None,
        "role": (json_node.get("role") or "").lower() or None,
        "name": _safe_text(json_node.get("name", ""), preserve_case=True) or None,
        "value": _safe_text(str(json_node.get("value", "")), preserve_case=True) or None,
        "description": _safe_text(json_node.get("description", ""), preserve_case=True) or None,
        "checked": json_node.get("checked"),
        "expanded": json_node.get("expanded"),
    })


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "MAX_SNAPSHOT_CHARS",
    "SNAPSHOT_TAIL_CHARS",
    "INTERACTIVE_ROLES",
    "ACTIONABLE_ROLES",
    "COOKIE_KEYWORDS",
    "build_snapshot",
    "window_snapshot",
    "compact_snapshot",
    "filter_snapshot_dialog_artifacts",
    "build_dom_metadata",
    "safe_node_metadata",
]
