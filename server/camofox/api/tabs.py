"""Tab routes — CRUD + all tab actions."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.browser import ensure_browser
from camofox.core.engines import normalize_engine, make_browser_key
from camofox.core.session import (
    get_session,
    find_tab,
    get_tab_group,
    destroy_tab,
    recycle_oldest_tab,
    create_server_owned_tab,
    with_tab_lock,
    handle_route_error,
    TabLockTimeoutError,
    TabDestroyedError,
    sessions as all_sessions,
    get_total_tab_count,
)
from camofox.core.utils import normalize_user_id, validate_url, safe_page_close
from camofox.domain.actions import human_click, human_type, human_scroll, human_press
from camofox.domain.memory_store import load_flow, record_flow
from camofox.domain.snapshot import build_snapshot, window_snapshot, compact_snapshot

log = logging.getLogger("camofox.api.tabs")
router = APIRouter()
AUTO_HISTORY_FLOW_ID = "browser-actions"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class TabOpenRequest(BaseModel):
    userId: str
    url: str | None = None
    engine: str | None = None
    profileDir: str | None = None


class NavigateRequest(BaseModel):
    userId: str
    url: str
    tabId: str | None = None
    engine: str | None = None


class ClickRequest(BaseModel):
    userId: str
    ref: str
    tabId: str | None = None
    engine: str | None = None


class TypeRequest(BaseModel):
    userId: str
    ref: str
    text: str
    tabId: str | None = None
    engine: str | None = None


class PressRequest(BaseModel):
    userId: str
    key: str
    tabId: str | None = None
    engine: str | None = None


class ScrollRequest(BaseModel):
    userId: str
    direction: str = "down"
    tabId: str | None = None
    engine: str | None = None


class EvaluateRequest(BaseModel):
    userId: str
    expression: str
    tabId: str | None = None
    engine: str | None = None


class WaitRequest(BaseModel):
    userId: str
    timeout: int = 5000
    tabId: str | None = None
    engine: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_tab(user_id: str, tab_id: str | None = None, engine: str | None = None) -> tuple[Any, Any, str, Any]:
    """Resolve a tab by *tab_id* or fall back to the first tab for *user_id*.

    Returns ``(session, tab_state, resolved_tab_id, found_dict)``.
    Raises ``HTTPException`` if no tab can be found.
    """
    if tab_id:
        session = None
        # Walk all sessions to find the tab
        for uid, sess in all_sessions.items():
            found = find_tab(sess, tab_id)
            if found is not None:
                session = sess
                break
        if session is None or found is None:
            raise HTTPException(404, {"error": f"Tab {tab_id} not found"})
        return session, found["tab_state"], tab_id, found

    # No tabId: get the first available tab for this user
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    session = all_sessions.get(make_browser_key(normalized_engine, uid))
    if session is None:
        raise HTTPException(404, {"error": f"No session found for user {user_id}"})
    for group_key, group in session.tab_groups.items():
        for tid, ts in group.items():
            return session, ts, tid, {
                "tab_state": ts,
                "list_item_id": tid,
                "group": group_key,
            }
    raise HTTPException(404, {"error": "No tabs found for user"})


def _target_summary_from_ref(tab_state: Any, ref: str | None) -> dict[str, Any] | None:
    """Return a compact, replay-oriented target summary for a recorded ref."""
    if not ref:
        return None
    ref_info = tab_state.refs.get(ref) if getattr(tab_state, "refs", None) else None
    if not isinstance(ref_info, dict):
        return None
    summary: dict[str, Any] = {}
    for key in ("role", "name", "text", "selector", "value"):
        value = ref_info.get(key)
        if value not in (None, ""):
            summary[key] = value
    attrs = ref_info.get("attributes")
    if isinstance(attrs, dict):
        stable_attrs = {
            str(k): v
            for k, v in attrs.items()
            if k in {"id", "name", "placeholder", "aria-label", "href", "data-testid", "data-test", "data-cy", "type"}
            and v not in (None, "")
        }
        if stable_attrs:
            summary["attributes"] = stable_attrs
    return summary or None


def _looks_sensitive_target(target_summary: dict[str, Any] | None) -> bool:
    if not target_summary:
        return False
    haystack: list[str] = []
    for key in ("name", "text", "selector", "value"):
        value = target_summary.get(key)
        if isinstance(value, str):
            haystack.append(value)
    attrs = target_summary.get("attributes")
    if isinstance(attrs, dict):
        haystack.extend(str(v) for v in attrs.values() if v is not None)
    lowered = " ".join(haystack).lower()
    return any(marker in lowered for marker in ("password", "passwd", "pwd", "secret", "token", "api-key", "api_key", "authorization"))


def _record_successful_tab_action(
    session: Any,
    tab_state: Any,
    user_id: str,
    tab_id: str,
    action: dict[str, Any],
) -> None:
    """Persist successful browser actions without letting recording break the route."""
    try:
        clean_action = {k: v for k, v in action.items() if v is not None}
        clean_action.setdefault("kind", clean_action.get("action"))
        clean_action["tab_id"] = tab_id
        if clean_action.get("ref") and not clean_action.get("target_summary"):
            clean_action["target_summary"] = _target_summary_from_ref(tab_state, clean_action.get("ref"))
        if not clean_action.get("target_summary") and clean_action.get("selector"):
            clean_action["target_summary"] = {"selector": clean_action.get("selector")}
        if clean_action.get("action") in {"type", "fill"} and _looks_sensitive_target(clean_action.get("target_summary")):
            clean_action["text"] = "[REDACTED]"
            clean_action["text_redacted"] = True
            clean_action.pop("chars", None)

        tab_state.agent_history_steps.append(clean_action)
        existing = load_flow(user_id, AUTO_HISTORY_FLOW_ID, profile_dir=session.profile_dir)
        flow = list(existing.get("flow", [])) if isinstance(existing, dict) and isinstance(existing.get("flow"), list) else []
        flow.append(clean_action)
        record_flow(
            user_id,
            flow,
            flow_id=AUTO_HISTORY_FLOW_ID,
            metadata={"source": "auto-record", "engine": session.engine, "tabId": tab_id},
            profile_dir=session.profile_dir,
        )
    except Exception as err:  # pragma: no cover - defensive best-effort hook
        log.warning("agent history auto-record failed", extra={"error": str(err), "action": action.get("action")})


# ---------------------------------------------------------------------------
# List / open tabs
# ---------------------------------------------------------------------------


@router.get("/tabs")
async def get_tabs(userId: str | None = Query(None), engine: str | None = Query(None)):
    """List all tabs. Optionally filter by userId."""
    try:
        if userId:
            uid = normalize_user_id(userId)
            normalized_engine = normalize_engine(engine or config.default_engine)
            session = all_sessions.get(make_browser_key(normalized_engine, uid))
            if session is None:
                return {"tabs": [], "total": 0}
            tabs_list = []
            for session_key, group in session.tab_groups.items():
                for tab_id, tab_state in group.items():
                    tabs_list.append(
                        {
                            "tabId": tab_id,
                            "sessionKey": session_key,
                            "url": tab_state.last_requested_url,
                            "visitedUrls": list(tab_state.visited_urls)[-5:],
                            "toolCalls": tab_state.tool_calls,
                            "engine": session.engine,
                        }
                    )
            return {"tabs": tabs_list, "total": len(tabs_list)}

        # List all tabs across all users
        all_tabs = []
        for uid, sess in all_sessions.items():
            for session_key, group in sess.tab_groups.items():
                for tab_id, ts in group.items():
                    all_tabs.append(
                        {
                            "userId": uid.split(":", 1)[1] if ":" in uid else uid,
                            "engine": sess.engine,
                            "tabId": tab_id,
                            "sessionKey": session_key,
                            "url": ts.last_requested_url,
                        }
                    )
        return {"tabs": all_tabs, "total": len(all_tabs)}
    except Exception as err:
        status, error_body = await handle_route_error(err)
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs")
@router.post("/tabs/open")
async def open_tab(body: TabOpenRequest):
    """Create a new tab, optionally navigating to a URL.

    Both ``POST /tabs`` (legacy) and ``POST /tabs/open`` are supported.
    """
    uid = normalize_user_id(body.userId)
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    try:
        # Ensure browser + session exist
        await ensure_browser(uid, profile_dir=body.profileDir, engine=normalized_engine)
        session = await get_session(uid, profile_dir=body.profileDir, engine=normalized_engine)

        # Check limits and recycle if needed
        if get_total_tab_count() >= config.max_tabs_global:
            recycled = await recycle_oldest_tab(session, user_id=uid)
            if recycled:
                log.info("Recycled oldest tab to stay under global limit")

        tab_result = await create_server_owned_tab(
            session, user_id=uid, session_key="default", url=body.url
        )
        return {
            "ok": True,
            "tabId": tab_result["tab_id"],
            "url": body.url or "about:blank",
            "engine": normalized_engine,
        }
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------


@router.post("/tabs/{tabId}/navigate")
async def navigate_tab(tabId: str, body: NavigateRequest):
    """Navigate a tab to a URL."""
    uid = normalize_user_id(body.userId)
    url_error = validate_url(body.url)
    if url_error:
        raise HTTPException(400, {"error": url_error})
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _navigate():
            await tab_state.page.goto(
                body.url,
                timeout=config.navigate_timeout_ms,
                wait_until="domcontentloaded",
            )
            tab_state.visited_urls.add(body.url)
            tab_state.last_requested_url = body.url
            _record_successful_tab_action(
                session,
                tab_state,
                uid,
                resolved_tab_id,
                {"action": "navigate", "url": body.url, "result": {"url": body.url}},
            )
            return {"ok": True, "url": body.url}

        return await with_tab_lock(resolved_tab_id, _navigate)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Actions: click, type, press, scroll
# ---------------------------------------------------------------------------


@router.post("/tabs/{tabId}/click")
async def click_tab(tabId: str, body: ClickRequest):
    """Click an element by ref."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _click():
            ref_info = tab_state.refs.get(body.ref)
            if ref_info:
                selector = ref_info.get("selector")
                if selector:
                    element = await tab_state.page.query_selector(selector)
                    if element:
                        await human_click(tab_state.page, selector)
                        tab_state.tool_calls += 1
                        _record_successful_tab_action(
                            session,
                            tab_state,
                            uid,
                            resolved_tab_id,
                            {"action": "click", "ref": body.ref, "selector": selector},
                        )
                        return {"ok": True, "ref": body.ref}
            # Fallback: try using the ref as a selector directly
            await human_click(tab_state.page, body.ref)
            tab_state.tool_calls += 1
            _record_successful_tab_action(
                session,
                tab_state,
                uid,
                resolved_tab_id,
                {"action": "click", "ref": body.ref, "selector": body.ref},
            )
            return {"ok": True, "ref": body.ref}

        return await with_tab_lock(resolved_tab_id, _click)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/type")
async def type_tab(tabId: str, body: TypeRequest):
    """Type text into an element by ref."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _type():
            ref_info = tab_state.refs.get(body.ref)
            if ref_info:
                selector = ref_info.get("selector")
                if selector:
                    await human_type(tab_state.page, selector, body.text)
                    tab_state.tool_calls += 1
                    _record_successful_tab_action(
                        session,
                        tab_state,
                        uid,
                        resolved_tab_id,
                        {"action": "type", "ref": body.ref, "selector": selector, "text": body.text, "chars": len(body.text)},
                    )
                    return {"ok": True, "ref": body.ref, "chars": len(body.text)}
            # Fallback: try using the ref as a selector directly
            await human_type(tab_state.page, body.ref, body.text)
            tab_state.tool_calls += 1
            _record_successful_tab_action(
                session,
                tab_state,
                uid,
                resolved_tab_id,
                {"action": "type", "ref": body.ref, "selector": body.ref, "text": body.text, "chars": len(body.text)},
            )
            return {"ok": True, "ref": body.ref, "chars": len(body.text)}

        return await with_tab_lock(resolved_tab_id, _type)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/press")
async def press_tab(tabId: str, body: PressRequest):
    """Press a keyboard key."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _press():
            await human_press(tab_state.page, body.key)
            tab_state.tool_calls += 1
            _record_successful_tab_action(
                session,
                tab_state,
                uid,
                resolved_tab_id,
                {"action": "press", "key": body.key},
            )
            return {"ok": True, "key": body.key}

        return await with_tab_lock(resolved_tab_id, _press)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/scroll")
async def scroll_tab(tabId: str, body: ScrollRequest):
    """Scroll the page in a direction."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _scroll():
            await human_scroll(tab_state.page, direction=body.direction)
            tab_state.tool_calls += 1
            _record_successful_tab_action(
                session,
                tab_state,
                uid,
                resolved_tab_id,
                {"action": "scroll", "direction": body.direction},
            )
            return {"ok": True, "direction": body.direction}

        return await with_tab_lock(resolved_tab_id, _scroll)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Snapshot / screenshot / page data
# ---------------------------------------------------------------------------


@router.get("/tabs/{tabId}/snapshot")
async def snapshot_tab(tabId: str, userId: str | None = Query(None)):
    """Get accessibility tree snapshot of a tab."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            userId or "", tabId
        )

        async def _snapshot():
            yaml, refs = await build_snapshot(tab_state.page)
            tab_state.refs.update(refs)
            tab_state.last_snapshot = yaml
            tab_state.last_snapshot_url = tab_state.page.url

            # Window to stay under limits
            windowed = window_snapshot(yaml)
            return {
                "snapshot": windowed["text"],
                "truncated": windowed["truncated"],
                "has_more": windowed["has_more"],
                "refs": refs,
                "url": tab_state.page.url,
            }

        return await with_tab_lock(resolved_tab_id, _snapshot)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


@router.get("/tabs/{tabId}/screenshot")
async def screenshot_tab(tabId: str, userId: str | None = Query(None)):
    """Take a screenshot of the tab."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            userId or "", tabId
        )

        async def _screenshot():
            import tempfile
            import os

            screenshot_path = os.path.join(
                tempfile.gettempdir(), f"camofox-{tabId}.png"
            )
            await tab_state.page.screenshot(
                path=screenshot_path, full_page=False
            )
            return {"path": screenshot_path, "url": tab_state.page.url}

        return await with_tab_lock(resolved_tab_id, _screenshot)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


@router.get("/tabs/{tabId}/images")
async def get_tab_images(tabId: str):
    """Get all image URLs on the page."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab("", tabId)

        async def _images():
            urls = await tab_state.page.evaluate(
                """() => {
                    return Array.from(document.querySelectorAll('img[src]')).map(i => i.src);
                }"""
            )
            return {"images": urls, "count": len(urls)}

        return await with_tab_lock(resolved_tab_id, _images)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


@router.get("/tabs/{tabId}/links")
async def get_tab_links(tabId: str):
    """Get all links on the page."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab("", tabId)

        async def _links():
            urls = await tab_state.page.evaluate(
                """() => {
                    return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
                }"""
            )
            return {"links": list(set(urls)), "count": len(set(urls))}

        return await with_tab_lock(resolved_tab_id, _links)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Diagnostics & stats
# ---------------------------------------------------------------------------


@router.get("/tabs/{tabId}/diagnostics")
async def get_tab_diagnostics(tabId: str):
    """Get console logs and JS errors for a tab."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab("", tabId)
        return {
            "consoleMessages": tab_state.console_messages[-50:],
            "jsErrors": tab_state.js_errors[-20:],
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


@router.get("/tabs/{tabId}/stats")
async def get_tab_stats(tabId: str):
    """Get statistics for a tab."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab("", tabId)
        return {
            "tabId": tabId,
            "url": tab_state.page.url if tab_state.page else None,
            "toolCalls": tab_state.tool_calls,
            "visitedUrls": list(tab_state.visited_urls)[-10:],
            "consecutiveTimeouts": tab_state.consecutive_timeouts,
            "keepAlive": tab_state.keep_alive,
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


@router.get("/tabs/{tabId}/downloads")
async def get_tab_downloads(tabId: str):
    """Get download history for a tab."""
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab("", tabId)
        return {"downloads": tab_state.downloads[-20:]}
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, tab_id=tabId)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# History navigation: back / forward / refresh / wait / evaluate
# ---------------------------------------------------------------------------


@router.post("/tabs/{tabId}/back")
async def back_tab(tabId: str, body: dict):
    """Go back in tab history."""
    uid = normalize_user_id(body.get("userId", ""))
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.get("userId", ""), tabId, body.get("engine")
        )

        async def _back():
            await tab_state.page.go_back()
            tab_state.tool_calls += 1
            return {"ok": True, "url": tab_state.page.url}

        return await with_tab_lock(resolved_tab_id, _back)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/forward")
async def forward_tab(tabId: str, body: dict):
    """Go forward in tab history."""
    uid = normalize_user_id(body.get("userId", ""))
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.get("userId", ""), tabId, body.get("engine")
        )

        async def _forward():
            await tab_state.page.go_forward()
            tab_state.tool_calls += 1
            return {"ok": True, "url": tab_state.page.url}

        return await with_tab_lock(resolved_tab_id, _forward)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/refresh")
async def refresh_tab(tabId: str, body: dict):
    """Refresh the current page."""
    uid = normalize_user_id(body.get("userId", ""))
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.get("userId", ""), tabId, body.get("engine")
        )

        async def _refresh():
            await tab_state.page.reload()
            tab_state.tool_calls += 1
            return {"ok": True, "url": tab_state.page.url}

        return await with_tab_lock(resolved_tab_id, _refresh)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/wait")
async def wait_tab(tabId: str, body: WaitRequest):
    """Wait for a specified duration."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _wait():
            await asyncio.sleep(body.timeout / 1000.0)
            return {"ok": True}

        return await with_tab_lock(resolved_tab_id, _wait)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/tabs/{tabId}/evaluate")
async def evaluate_tab(tabId: str, body: EvaluateRequest):
    """Evaluate JavaScript in the page context."""
    uid = normalize_user_id(body.userId)
    try:
        session, tab_state, resolved_tab_id, found = _resolve_tab(
            body.userId, tabId, body.engine
        )

        async def _evaluate():
            result = await tab_state.page.evaluate(body.expression)
            tab_state.tool_calls += 1
            return {"result": result}

        return await with_tab_lock(resolved_tab_id, _evaluate)
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(
            err, user_id=uid, tab_id=tabId
        )
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Delete tabs
# ---------------------------------------------------------------------------


@router.delete("/tabs/{tabId}")
async def delete_tab(tabId: str):
    """Close a single tab."""
    try:
        # Find which session owns this tab
        target_session = None
        for uid, sess in all_sessions.items():
            found = find_tab(sess, tabId)
            if found is not None:
                target_session = sess
                break
        if target_session is None:
            raise HTTPException(404, {"error": f"Tab {tabId} not found"})
        await destroy_tab(
            target_session, tabId, reason="user_request"
        )
        return {"ok": True, "tabId": tabId}
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err)
        raise HTTPException(status_code=status, detail=error_body)


@router.delete("/tabs/group/{listItemId}")
async def delete_tab_group(listItemId: str):
    """Close all tabs in a group (listItemId = session_key)."""
    closed_count = 0
    for uid, sess in all_sessions.items():
        group = sess.tab_groups.get(listItemId, {})
        for tab_id in list(group.keys()):
            await destroy_tab(
                sess, tab_id, reason="group_close", user_id=uid
            )
            closed_count += 1
    return {"ok": True, "closed": closed_count}
