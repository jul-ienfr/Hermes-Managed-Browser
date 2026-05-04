/**
 * Snapshot windowing — truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 */

const MAX_SNAPSHOT_CHARS = 80000;  // ~20K tokens
const SNAPSHOT_TAIL_CHARS = 5000;  // keep last ~5K for pagination/nav links
const COOKIE_KEYWORDS = [
  'cookie', 'cookies', 'consent', 'consentement', 'rgpd', 'privacy', 'confidentialité'
];

function filterSnapshotDialogArtifacts(yaml, options = {}) {
  if (!yaml || typeof yaml !== 'string') return yaml || '';

  const confirmedDialogNames = new Set(
    (options.confirmedDialogNames || [])
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const cookieBannerKeywords = (options.cookieBannerKeywords || [])
    .map((value) => String(value || '').toLowerCase());
  const cookieSignals = [...COOKIE_KEYWORDS, ...cookieBannerKeywords];
  const lowerYaml = yaml.toLowerCase();
  const hasCookieSignal = cookieSignals.some((keyword) => keyword && lowerYaml.includes(keyword));
  if (!hasCookieSignal) return yaml;

  const lines = yaml.split('\n');
  const kept = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(\s*)-\s+dialog\s+"([^"]+)"(.*)$/);
    if (!match) {
      kept.push(line);
      continue;
    }

    const [, indent, rawName] = match;
    const name = rawName.trim().toLowerCase();
    if (confirmedDialogNames.has(name)) {
      kept.push(line);
      continue;
    }

    const indentLen = indent.length;
    let j = i + 1;
    while (j < lines.length) {
      const child = lines[j];
      if (!child.trim()) {
        j += 1;
        continue;
      }
      const childIndent = child.match(/^(\s*)/)?.[1]?.length || 0;
      if (childIndent <= indentLen) break;
      j += 1;
    }
    i = j - 1;
  }

  return kept.join('\n');
}

/**
 * Return a window of the snapshot YAML.
 *  offset=0 (default): head chunk + tail (pagination/nav).
 *  offset=N: chars N..N+budget from the full snapshot.
 *  Always appends pagination tail so nav refs are available in every chunk.
 */
function compactSnapshot(yaml) {
  yaml = filterSnapshotDialogArtifacts(yaml);
  if (!yaml) return '';

  const lines = yaml.split('\n');
  const kept = [];
  for (const line of lines) {
    if (/\[e\d+\]/.test(line) || /^\s*-\s+(heading|link|button|textbox|checkbox|radio|menuitem|tab|searchbox|slider|spinbutton|switch|alert|status|paragraph|text)\b/.test(line)) {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function windowSnapshot(yaml, offset = 0) {
  yaml = filterSnapshotDialogArtifacts(yaml);
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0, hasMore: false, nextOffset: null };
  const total = yaml.length;
  if (total <= MAX_SNAPSHOT_CHARS) return { text: yaml, truncated: false, totalChars: total, offset: 0, hasMore: false, nextOffset: null };

  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200; // room for marker
  const tail = yaml.slice(-SNAPSHOT_TAIL_CHARS);
  const clampedOffset = Math.min(Math.max(0, offset), total - SNAPSHOT_TAIL_CHARS);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - SNAPSHOT_TAIL_CHARS;

  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';

  return {
    text: chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null
  };
}

const SAFE_ATTRIBUTE_NAMES = new Set([
  'id',
  'class',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'title',
  'href',
  'data-testid',
  'data-test',
  'data-cy',
]);

const SENSITIVE_TEXT_PATTERN = /\b(password|passcode|secret|token|api[-_ ]?key|authorization|auth|credential|credit card|card number|cvv|ssn)\b/i;

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === 'object') return Object.keys(value).length > 0;
      return value !== undefined && value !== null && value !== '';
    })
  );
}

function normalizeTagName(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/[a-z][a-z0-9-]*/);
  return match ? match[0] : '';
}

function safeText(value, { preserveCase = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || SENSITIVE_TEXT_PATTERN.test(text)) return '';
  return preserveCase ? text.slice(0, 160) : text.toLowerCase().slice(0, 160);
}

function safeAttributes(attributes = {}) {
  const picked = {};
  for (const [rawName, rawValue] of Object.entries(attributes || {})) {
    const name = String(rawName || '').toLowerCase();
    if (!SAFE_ATTRIBUTE_NAMES.has(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    if (SENSITIVE_TEXT_PATTERN.test(value)) continue;
    picked[name] = value.slice(0, 160);
  }
  return picked;
}

function attributesFromElement(element) {
  if (!element?.attributes) return {};
  if (typeof element.getAttribute === 'function') {
    const result = {};
    for (const attr of Array.from(element.attributes || [])) {
      if (attr?.name) result[attr.name] = element.getAttribute(attr.name);
    }
    return result;
  }
  return element.attributes;
}

function elementText(element) {
  return element?.innerText || element?.textContent || element?.name || element?.axName || element?.label || '';
}

function relatedElementMetadata(element, { includeText = true, preserveCase = false } = {}) {
  if (!element) return {};
  return compactObject({
    tag: normalizeTagName(element.tag || element.tagName || element.nodeName),
    text: includeText ? safeText(element.text || elementText(element), { preserveCase }) : undefined,
    attributes: safeAttributes(element.attributes || attributesFromElement(element)),
  });
}

function tagPathForElement(element) {
  const path = [];
  let cursor = element;
  let guard = 0;
  while (cursor && guard < 32) {
    const tag = normalizeTagName(cursor.tag || cursor.tagName || cursor.nodeName);
    if (tag) path.unshift(tag);
    cursor = cursor.parentElement || null;
    guard += 1;
  }
  return path;
}

function siblingTagsForElement(element) {
  const parent = element?.parentElement;
  if (parent?.children) {
    return Array.from(parent.children)
      .filter((child) => child && child !== element)
      .slice(0, 8)
      .map((child) => relatedElementMetadata(child, { includeText: false }))
      .filter((entry) => Object.keys(entry).length > 0);
  }
  return [element?.previousElementSibling, element?.nextElementSibling]
    .filter(Boolean)
    .map((sibling) => relatedElementMetadata(sibling, { includeText: false }))
    .filter((entry) => Object.keys(entry).length > 0);
}

function childIndex(element) {
  const parent = element?.parentElement;
  if (!parent?.children) return undefined;
  const index = Array.from(parent.children).indexOf(element);
  return index >= 0 ? index : undefined;
}

function isHiddenOrSensitiveElement(element) {
  const tag = normalizeTagName(element?.tag || element?.tagName || element?.nodeName);
  const attrs = element?.attributes || attributesFromElement(element);
  const type = String(element?.type || attrs?.type || '').toLowerCase();
  if (tag === 'input' && type === 'hidden') return true;
  if (attrs?.hidden !== undefined || attrs?.['aria-hidden'] === 'true') return true;
  if (typeof element?.closest === 'function' && element.closest('[hidden], [aria-hidden="true"]')) return true;
  return false;
}

function buildDomMetadata(node = {}) {
  if (isHiddenOrSensitiveElement(node)) return {};
  const tag = normalizeTagName(node.tag || node.tagName || node.nodeName);
  return compactObject({
    tag,
    text: safeText(node.text || node.innerText || node.textContent || node.name || node.axName || node.label, { preserveCase: true }),
    attributes: safeAttributes(node.attributes || attributesFromElement(node)),
    parent: node.parent ? relatedElementMetadata(node.parent, { preserveCase: true }) : undefined,
    siblings: Array.isArray(node.siblings)
      ? node.siblings.map((sibling) => relatedElementMetadata(sibling, { preserveCase: true })).filter((entry) => Object.keys(entry).length > 0)
      : undefined,
    path: Array.isArray(node.path) ? node.path.map(normalizeTagName).filter(Boolean) : undefined,
    depth: Number.isInteger(node.depth) ? node.depth : undefined,
    index: Number.isInteger(node.index) ? node.index : undefined,
    nearbyText: Array.isArray(node.nearbyText) ? node.nearbyText.map((text) => safeText(text, { preserveCase: true })).filter(Boolean).slice(0, 6) : undefined,
  });
}

function safeNodeMetadataFromElement(element) {
  if (!element || isHiddenOrSensitiveElement(element)) return {};
  const path = tagPathForElement(element);
  const parent = element.parentElement ? relatedElementMetadata(element.parentElement, { preserveCase: true }) : undefined;
  const nearbyText = [
    element.previousElementSibling && elementText(element.previousElementSibling),
    element.nextElementSibling && elementText(element.nextElementSibling),
    element.parentElement && elementText(element.parentElement),
  ].map((text) => safeText(text, { preserveCase: true })).filter(Boolean).slice(0, 6);

  return compactObject({
    tag: normalizeTagName(element.tagName || element.nodeName),
    text: safeText(elementText(element), { preserveCase: true }),
    attributes: safeAttributes(attributesFromElement(element)),
    parent,
    siblings: siblingTagsForElement(element),
    path,
    depth: path.length > 0 ? path.length - 1 : undefined,
    index: childIndex(element),
    nearbyText,
  });
}

export {
  windowSnapshot,
  compactSnapshot,
  filterSnapshotDialogArtifacts,
  buildDomMetadata,
  safeNodeMetadataFromElement,
  MAX_SNAPSHOT_CHARS,
  SNAPSHOT_TAIL_CHARS,
};
