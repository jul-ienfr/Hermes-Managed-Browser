"""Deterministic managed-flow replay helpers.

The goal here is deliberately narrower than the Node.js self-healing layer: run
recorded browser steps exactly, without asking an LLM to rediscover anything.
Local healing can be layered on top later, but this module must remain safe and
predictable.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from camofox.core.config import config
from camofox.core.session import SessionState, TabState, create_server_owned_tab, find_tab, with_tab_lock
from camofox.core.utils import validate_url
from camofox.domain.actions import human_click, human_press, human_scroll, human_type
from camofox.domain.snapshot import build_snapshot, window_snapshot


class ReplayError(RuntimeError):
    """Raised when a managed flow cannot be replayed exactly."""


def _step_action(step: dict[str, Any]) -> str:
    action = step.get("action") or step.get("type") or step.get("op")
    if not isinstance(action, str) or not action.strip():
        raise ReplayError(f"Replay step is missing action/type/op: {step!r}")
    return action.strip().lower().replace("_", "-")


def _step_params(step: dict[str, Any]) -> dict[str, Any]:
    params = step.get("params")
    if isinstance(params, dict):
        merged = {k: v for k, v in step.items() if k not in {"params"}}
        merged.update(params)
        return merged
    return step


def _first_tab(session: SessionState) -> tuple[str, TabState] | None:
    for group in session.tab_groups.values():
        for tab_id, tab_state in group.items():
            return tab_id, tab_state
    return None


async def resolve_replay_tab(
    session: SessionState,
    *,
    user_id: str,
    tab_id: str | None = None,
    session_key: str = "default",
) -> tuple[str, TabState]:
    """Resolve the target tab for replay, creating one if necessary."""
    if tab_id:
        found = find_tab(session, tab_id)
        if found is None:
            raise ReplayError(f"Tab '{tab_id}' not found")
        return tab_id, found["tab_state"]

    existing = _first_tab(session)
    if existing is not None:
        return existing

    # Do not pass ``about:blank`` here: the initial page may still be finishing
    # its implicit about:blank load, and an explicit goto can race with the
    # first replay navigate step on real browsers.
    created = await create_server_owned_tab(session, user_id=user_id, session_key=session_key)
    return created["tab_id"], created["tab_state"]


def _selector_for_ref(tab_state: TabState, ref_or_selector: str | None) -> str:
    if not ref_or_selector:
        raise ReplayError("Replay step requires a ref or selector")
    ref_info = tab_state.refs.get(ref_or_selector)
    if isinstance(ref_info, dict) and ref_info.get("selector"):
        return str(ref_info["selector"])
    return str(ref_or_selector)


_PLACEHOLDER_RE = re.compile(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}|^\$\{([a-zA-Z0-9_.-]+)\}$")


def _resolve_placeholders(value: Any, substitutions: dict[str, Any], *, field: str) -> Any:
    """Resolve Node-style runtime placeholders in replay step fields.

    Supports both ``{{name}}`` embedded placeholders and the older exact
    ``${name}`` form used by the first Python replay implementation.  Missing
    parameters fail closed instead of replaying literal placeholder text.
    """
    if not isinstance(value, str):
        return value

    missing: list[str] = []

    def repl(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2) or ""
        if name not in substitutions or substitutions.get(name) in (None, ""):
            missing.append(name)
            return match.group(0)
        return str(substitutions[name])

    resolved = _PLACEHOLDER_RE.sub(repl, value)
    if missing:
        raise ReplayError(f"Replay step requires parameter(s) for {field}: {', '.join(sorted(set(missing)))}")
    return resolved


def _step_kind(step: dict[str, Any]) -> str:
    kind = step.get("kind") or step.get("action") or step.get("type") or step.get("op")
    return str(kind or "").strip().lower().replace("_", "-")


def _split_upload_paths(value: Any) -> list[str]:
    """Normalize Node-compatible file_upload path fields.

    Node accepted path/paths/files as either strings or arrays, with comma-separated
    strings expanded.  Keep the same shape so exported flows replay identically.
    """
    if value is None:
        return []
    raw_items = value if isinstance(value, list) else [value]
    paths: list[str] = []
    for item in raw_items:
        if item is None:
            continue
        for part in str(item).split(","):
            path = part.strip()
            if path:
                paths.append(path)
    return paths


def _is_redacted_value(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return value.strip().upper() in {"[REDACTED]", "__REDACTED__", "<REDACTED>", "REDACTED"}


def _is_redacted_type_step(action: str, step: dict[str, Any]) -> bool:
    if action not in {"type", "fill"}:
        return False
    return bool(
        step.get("text_redacted") is True
        or step.get("textRedacted") is True
        or _is_redacted_value(step.get("text"))
        or _is_redacted_value(step.get("value"))
    )


def _candidate_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _same(a: Any, b: Any) -> bool:
    left = _candidate_text(a)
    right = _candidate_text(b)
    return bool(left and left == right)


def _includes_either(a: Any, b: Any) -> bool:
    left = _candidate_text(a)
    right = _candidate_text(b)
    return bool(left and right and (left in right or right in left))


def _score_target_candidate(saved: dict[str, Any], candidate: dict[str, Any]) -> int:
    score = 0
    if _same(saved.get("role"), candidate.get("role")):
        score += 25
    if _same(saved.get("name"), candidate.get("name")):
        score += 35
    elif _includes_either(saved.get("name"), candidate.get("name")):
        score += 20
    if _same(saved.get("text"), candidate.get("text") or candidate.get("name")):
        score += 20
    elif _includes_either(saved.get("text"), candidate.get("text") or candidate.get("name")):
        score += 10

    saved_attrs = saved.get("attributes") if isinstance(saved.get("attributes"), dict) else {}
    cand_attrs = candidate.get("attributes") if isinstance(candidate.get("attributes"), dict) else {}
    for attr in ("id", "name", "placeholder", "aria-label", "href", "data-testid", "data-test", "data-cy"):
        if _same(saved_attrs.get(attr), cand_attrs.get(attr)):
            score += 15

    saved_index = saved.get("index")
    cand_index = candidate.get("index")
    if isinstance(saved_index, int) and isinstance(cand_index, int):
        distance = abs(saved_index - cand_index)
        if distance == 0:
            score += 8
        elif distance <= 3:
            score += 4
    return min(score, 100)


def _find_best_target_candidate(saved: dict[str, Any], candidates: list[dict[str, Any]], *, threshold: int = 60) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_score = -1
    for candidate in candidates:
        score = _score_target_candidate(saved, candidate)
        if score > best_score:
            best = {**candidate, "score": score}
            best_score = score
    return best if best is not None and best_score >= threshold else None


async def _refresh_refs(tab_state: TabState) -> None:
    yaml, refs = await build_snapshot(tab_state.page)
    tab_state.refs.clear()
    tab_state.refs.update(refs)
    tab_state.last_snapshot = yaml
    tab_state.last_snapshot_url = tab_state.page.url


def _live_candidates(tab_state: TabState) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for index, (ref, node) in enumerate(tab_state.refs.items()):
        if not isinstance(node, dict):
            continue
        candidates.append({"ref": ref, "index": index, **node})
    return candidates


async def _resolve_selector_for_step(
    tab_state: TabState,
    step: dict[str, Any],
    *,
    allow_repair: bool,
    repair_mode: str,
) -> tuple[str, dict[str, Any] | None]:
    ref_or_selector = step.get("ref") or step.get("selector")
    try:
        selector = _selector_for_ref(tab_state, ref_or_selector)
    except ReplayError:
        selector = ""

    if selector:
        locator = tab_state.page.locator(selector)
        try:
            if await locator.count() > 0:
                return selector, None
        except Exception:
            if not allow_repair:
                return selector, None

    if not allow_repair or not isinstance(step.get("target_summary"), dict):
        if selector:
            return selector, None
        raise ReplayError("Replay step requires a ref or selector")

    await _refresh_refs(tab_state)
    repaired = _find_best_target_candidate(step["target_summary"], _live_candidates(tab_state))
    if not repaired or not repaired.get("ref"):
        if selector:
            return selector, None
        raise ReplayError("Replay step target could not be repaired from target_summary")

    repaired_selector = _selector_for_ref(tab_state, str(repaired["ref"]))
    return repaired_selector, {
        "mode": "repaired",
        "original_ref": step.get("ref"),
        "repaired_ref": repaired.get("ref"),
        "score": repaired.get("score"),
        "candidate": repaired,
        "llm_used": False,
        "repair_mode": repair_mode,
    }


async def replay_flow_steps(
    session: SessionState,
    *,
    user_id: str,
    flow: list[dict[str, Any]],
    tab_id: str | None = None,
    params: dict[str, Any] | None = None,
    session_key: str = "default",
    timeout_ms: int | None = None,
    allow_repair: bool = True,
    repair_mode: str = "target_summary",
) -> dict[str, Any]:
    """Execute recorded flow steps against a Playwright session.

    Supported exact actions: navigate/goto/open, click, type/fill, press,
    scroll, wait/sleep, evaluate/console-eval, snapshot.  When a recorded
    ref/selector no longer resolves, a conservative local repair pass can use
    ``target_summary`` metadata against a fresh DOM snapshot.  This mirrors the
    first non-LLM layer of the Node.js self-healing replay, but never calls an
    LLM and fails closed on redacted secrets or missing runtime parameters.
    """
    resolved_tab_id, tab_state = await resolve_replay_tab(
        session, user_id=user_id, tab_id=tab_id, session_key=session_key
    )
    results: list[dict[str, Any]] = []
    substitutions = params or {}

    async def _run() -> dict[str, Any]:
        nonlocal resolved_tab_id, tab_state
        for index, raw_step in enumerate(flow):
            if not isinstance(raw_step, dict):
                raise ReplayError(f"Replay step {index} is not an object")
            action = _step_action(raw_step)
            step = _step_params(raw_step)
            action = _step_kind(step) or action
            if _is_redacted_type_step(action, step):
                raise ReplayError(f"Replay step {index} requires secret text and cannot replay redacted input")

            if action in {"navigate", "goto", "open"}:
                url = _resolve_placeholders(step.get("url") or step.get("target"), substitutions, field="url")
                if not isinstance(url, str) or not url:
                    raise ReplayError(f"Replay step {index} requires url")
                url_error = validate_url(url)
                if url_error:
                    raise ReplayError(url_error)
                await tab_state.page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms or config.navigate_timeout_ms)
                tab_state.visited_urls.add(url)
                tab_state.last_requested_url = url
                results.append({"index": index, "action": action, "ok": True, "url": url})

            elif action == "click":
                selector, repair = await _resolve_selector_for_step(
                    tab_state,
                    step,
                    allow_repair=allow_repair,
                    repair_mode=repair_mode,
                )
                await human_click(tab_state.page, selector)
                tab_state.tool_calls += 1
                result = {"index": index, "action": action, "ok": True, "selector": selector}
                if repair:
                    result.update(repair)
                results.append(result)

            elif action in {"type", "fill"}:
                selector, repair = await _resolve_selector_for_step(
                    tab_state,
                    step,
                    allow_repair=allow_repair,
                    repair_mode=repair_mode,
                )
                text = _resolve_placeholders(step.get("text") if step.get("text") is not None else step.get("value", ""), substitutions, field="text")
                await human_type(tab_state.page, selector, str(text))
                tab_state.tool_calls += 1
                result = {"index": index, "action": action, "ok": True, "selector": selector, "chars": len(str(text))}
                if repair:
                    result.update(repair)
                results.append(result)

            elif action in {"file-upload", "fileupload"}:
                selector, repair = await _resolve_selector_for_step(
                    tab_state,
                    step,
                    allow_repair=allow_repair,
                    repair_mode=repair_mode,
                )
                raw_paths = step.get("paths") if step.get("paths") is not None else step.get("path")
                if raw_paths is None:
                    raw_paths = step.get("files")
                paths = [
                    _resolve_placeholders(path, substitutions, field="paths")
                    for path in _split_upload_paths(raw_paths)
                ]
                if not paths:
                    raise ReplayError(f"Replay step {index} requires paths for file_upload")
                locator = tab_state.page.locator(selector)
                if not hasattr(locator, "set_input_files"):
                    raise ReplayError(f"Replay step {index} requires locator.set_input_files support")
                await locator.set_input_files(paths, timeout=timeout_ms or config.handler_timeout_ms)
                tab_state.tool_calls += 1
                result = {"index": index, "action": action, "ok": True, "selector": selector, "uploaded": len(paths), "paths": paths}
                if repair:
                    result.update(repair)
                results.append(result)

            elif action == "press":
                key = step.get("key")
                if not isinstance(key, str) or not key:
                    raise ReplayError(f"Replay step {index} requires key")
                await human_press(tab_state.page, key)
                tab_state.tool_calls += 1
                results.append({"index": index, "action": action, "ok": True, "key": key})

            elif action == "scroll":
                direction = str(step.get("direction") or "down")
                await human_scroll(tab_state.page, direction=direction)
                tab_state.tool_calls += 1
                results.append({"index": index, "action": action, "ok": True, "direction": direction})

            elif action in {"wait", "sleep"}:
                timeout = step.get("timeout") or step.get("timeout_ms") or step.get("ms") or 1000
                wait_timeout_ms = max(0, int(timeout))
                await asyncio.sleep(wait_timeout_ms / 1000.0)
                results.append({"index": index, "action": action, "ok": True, "timeout_ms": wait_timeout_ms})

            elif action in {"refresh", "reload"}:
                if hasattr(tab_state.page, "reload"):
                    await tab_state.page.reload(wait_until="domcontentloaded", timeout=timeout_ms or config.navigate_timeout_ms)
                else:
                    await tab_state.page.goto(tab_state.page.url, wait_until="domcontentloaded", timeout=timeout_ms or config.navigate_timeout_ms)
                tab_state.last_requested_url = tab_state.page.url
                results.append({"index": index, "action": action, "ok": True, "url": tab_state.page.url})

            elif action in {"back", "go-back", "go_back"}:
                if not hasattr(tab_state.page, "go_back"):
                    raise ReplayError(f"Replay step {index} requires page.go_back support")
                await tab_state.page.go_back(wait_until="domcontentloaded", timeout=timeout_ms or config.navigate_timeout_ms)
                tab_state.last_requested_url = tab_state.page.url
                results.append({"index": index, "action": action, "ok": True, "url": tab_state.page.url})

            elif action in {"forward", "go-forward", "go_forward"}:
                if not hasattr(tab_state.page, "go_forward"):
                    raise ReplayError(f"Replay step {index} requires page.go_forward support")
                await tab_state.page.go_forward(wait_until="domcontentloaded", timeout=timeout_ms or config.navigate_timeout_ms)
                tab_state.last_requested_url = tab_state.page.url
                results.append({"index": index, "action": action, "ok": True, "url": tab_state.page.url})

            elif action in {"evaluate", "eval", "console-eval"}:
                expression = step.get("expression") or step.get("script")
                if not isinstance(expression, str) or not expression:
                    raise ReplayError(f"Replay step {index} requires expression")
                if step.get("replay_safe") is False or step.get("replaySafe") is False:
                    raise ReplayError(f"Replay step {index} evaluate is marked replay-unsafe")
                value = await tab_state.page.evaluate(expression)
                results.append({"index": index, "action": action, "ok": True, "result": value})

            elif action == "snapshot":
                yaml, refs = await build_snapshot(tab_state.page)
                tab_state.refs.update(refs)
                tab_state.last_snapshot = yaml
                tab_state.last_snapshot_url = tab_state.page.url
                windowed = window_snapshot(yaml)
                results.append({
                    "index": index,
                    "action": action,
                    "ok": True,
                    "snapshot": windowed["text"],
                    "truncated": windowed["truncated"],
                    "has_more": windowed["has_more"],
                })

            else:
                raise ReplayError(f"Unsupported replay action '{action}' at step {index}")

        return {
            "ok": True,
            "executed": True,
            "tab_id": resolved_tab_id,
            "tabId": resolved_tab_id,
            "url": tab_state.page.url,
            "results": results,
            "step_count": len(flow),
        }

    return await with_tab_lock(resolved_tab_id, _run)
