"""
Legacy Node.js API compatibility router.

Translates the Node.js camofox-browser API calls (using ``profile`` + ``site``)
into the Python server's native API (using ``userId``).

Mapped endpoints:
  POST /profile/status   → check if a browser entry exists for this profile
  POST /navigate         → start session + open tab + navigate to URL
  POST /console/eval     → evaluate JS in the current tab of a profile
  POST /storage/checkpoint → save storage state for a profile
  POST /file-upload      → upload file(s) to a file input
  POST /managed/cli/snapshot → take an accessibility snapshot
  POST /flow/run         → run a memorised flow (stub)
  POST /flow/list        → list available flows (stub)
  POST /flow/inspect     → inspect a flow (stub)
  POST /notifications/*  → notification management (stub)
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.browser import ensure_browser
from camofox.core.engines import normalize_engine, make_browser_key
from camofox.core.session import (
    get_session,
    get_total_tab_count,
    handle_route_error,
    sessions as all_sessions,
)
from camofox.core.utils import normalize_user_id
from camofox.domain.snapshot import build_snapshot, window_snapshot

log = logging.getLogger("camofox.api.legacy")
router = APIRouter()


# ---------------------------------------------------------------------------
# Request models (Node.js API shape)
# ---------------------------------------------------------------------------


class ProfileSiteRequest(BaseModel):
    profile: str
    site: str
    engine: str | None = None


class NavigateRequest(ProfileSiteRequest):
    url: str


class ConsoleEvalRequest(ProfileSiteRequest):
    expression: str
    tab_id: str | None = None


class SnapshotRequest(ProfileSiteRequest):
    tab_id: str | None = None


class FileUploadRequest(ProfileSiteRequest):
    selector: str
    paths: list[str]
    tab_id: str | None = None


class StorageCheckpointRequest(ProfileSiteRequest):
    reason: str


class FlowRunRequest(ProfileSiteRequest):
    flow: str
    params: dict[str, Any] = {}
    allow_llm_repair: bool = False


class FlowInspectRequest(ProfileSiteRequest):
    flow: str


class NotificationsRequest(ProfileSiteRequest):
    origin: str | None = None


class NotificationsEnableRequest(ProfileSiteRequest):
    origin: str | None = None
    confirm: bool = False


class NotificationsListRequest(ProfileSiteRequest):
    origin: str | None = None
    limit: int | None = None


class NotificationsWatchRequest(ProfileSiteRequest):
    origin: str | None = None
    state_path: str | None = None
    interval_seconds: int | float | None = None
    once: bool = False
    max_cycles: int | None = None
    limit: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_user_id(profile: str) -> str:
    """Map a Node.js profile name to a Python userId."""
    return normalize_user_id(profile)


def _session_key(user_id: str, engine: str | None = None) -> str:
    return make_browser_key(normalize_engine(engine), user_id)


def _first_tab_info(user_id: str, engine: str | None = None) -> dict | None:
    """Return info about the first tab for a user, or None."""
    session = all_sessions.get(_session_key(user_id, engine))
    if session is None:
        return None
    for group_key, group in session.tab_groups.items():
        for tid, ts in group.items():
            return {
                "tab_id": tid,
                "tabId": tid,
                "url": ts.last_requested_url or ts.page.url if ts.page else None,
                "sessionKey": group_key,
            }
    return None


# ---------------------------------------------------------------------------
# Navigate
# ---------------------------------------------------------------------------


@router.post("/navigate")
async def post_navigate(body: NavigateRequest):
    """Navigate a profile's browser to a URL.

    Follows the Node.js behaviour:
    - If no session exists, starts one (including opening a first tab).
    - If a session exists but has no tabs, opens a tab and navigates.
    - If a tab already exists for this profile, returns HTTP 409 (conflict)
      with the current tab_id so the caller can use console/eval on it.
    """
    uid = _to_user_id(body.profile)
    engine = normalize_engine(body.engine)
    try:
        existing_tab = _first_tab_info(uid, engine)
        if existing_tab:
            # Tab already exists — Node.js returns 409
            raise HTTPException(
                status_code=409,
                detail={
                    "success": False,
                    "reason": "Tab already exists — use console/eval on the existing tab",
                    "tab_id": existing_tab["tab_id"],
                    "tabId": existing_tab["tab_id"],
                    "result": existing_tab,
                },
            )

        # No existing tab: start browser + open tab + navigate
        await ensure_browser(uid, engine=engine)
        session = await get_session(uid, engine=engine)

        from camofox.core.session import create_server_owned_tab
        from camofox.core.config import config

        if get_total_tab_count() >= config.max_tabs_global:
            from camofox.core.session import recycle_oldest_tab

            recycled = await recycle_oldest_tab(session, user_id=uid)
            if recycled:
                log.info("Recycled oldest tab to stay under global limit")

        tab_result = await create_server_owned_tab(
            session, user_id=uid, session_key="default", url=body.url
        )

        return {
            "success": True,
            "result": {
                "tab_id": tab_result["tab_id"],
                "tabId": tab_result["tab_id"],
                "url": body.url,
                "profile": body.profile,
                "site": body.site,
            },
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Console eval
# ---------------------------------------------------------------------------


@router.post("/console/eval")
async def post_console_eval(body: ConsoleEvalRequest):
    """Evaluate JavaScript in the current tab of a profile."""
    uid = _to_user_id(body.profile)
    try:
        session = all_sessions.get(_session_key(uid, body.engine))
        if session is None:
            raise HTTPException(
                status_code=404,
                detail={"error": f"No session found for profile '{body.profile}'"},
            )

        # Resolve tab: if tab_id provided, use it; otherwise use first tab
        if body.tab_id:
            from camofox.core.session import find_tab

            found = find_tab(session, body.tab_id)
            if found is None:
                raise HTTPException(
                    status_code=404,
                    detail={"error": f"Tab '{body.tab_id}' not found for profile '{body.profile}'"},
                )
            page = found["tab_state"].page
        else:
            tab_info = _first_tab_info(uid, body.engine)
            if tab_info is None:
                raise HTTPException(
                    status_code=404,
                    detail={"error": f"No tabs available for profile '{body.profile}'"},
                )
            found = None
            for group_key, group in session.tab_groups.items():
                for tid, ts in group.items():
                    if tid == tab_info["tab_id"]:
                        found = {"tab_state": ts}
                        page = ts.page
                        break
                    page = ts.page
                    break
                if found:
                    break
            else:
                raise HTTPException(
                    status_code=404,
                    detail={"error": f"No tabs available for profile '{body.profile}'"},
                )

        result_value = await page.evaluate(body.expression)

        # Build response matching Node.js shape
        return {
            "success": True,
            "result": result_value,
            "raw": {
                "result": result_value,
                "success": True,
            },
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------


@router.post("/managed/cli/snapshot")
async def post_cli_snapshot(body: SnapshotRequest):
    """Take an accessibility snapshot of a profile's current tab."""
    uid = _to_user_id(body.profile)
    try:
        session = all_sessions.get(_session_key(uid, body.engine))
        if session is None:
            raise HTTPException(404, {"error": f"No session for profile '{body.profile}'"})

        if body.tab_id:
            from camofox.core.session import find_tab

            found = find_tab(session, body.tab_id)
            if found is None:
                raise HTTPException(404, {"error": f"Tab '{body.tab_id}' not found"})
            page = found["tab_state"].page
            refs = {}
        else:
            tab_info = _first_tab_info(uid, body.engine)
            if tab_info is None:
                raise HTTPException(404, {"error": f"No tabs for profile '{body.profile}'"})
            for gk, group in session.tab_groups.items():
                for tid, ts in group.items():
                    if tid == tab_info["tab_id"]:
                        page = ts.page
                        refs = ts.refs
                        break
                    page = ts.page
                    refs = {}
                    break
                else:
                    continue
                break
            else:
                raise HTTPException(404, {"error": "Tab not found"})

        yaml, new_refs = await build_snapshot(page)
        refs.update(new_refs)
        windowed = window_snapshot(yaml)

        return {
            "success": True,
            "result": {
                "snapshot": windowed["text"],
                "truncated": windowed["truncated"],
                "has_more": windowed["has_more"],
                "refs": refs,
                "url": page.url,
            },
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# File upload
# ---------------------------------------------------------------------------


@router.post("/file-upload")
async def post_file_upload(body: FileUploadRequest):
    """Upload file(s) to a file input element."""
    uid = _to_user_id(body.profile)
    try:
        session = all_sessions.get(_session_key(uid, body.engine))
        if session is None:
            raise HTTPException(404, {"error": f"No session for profile '{body.profile}'"})

        if body.tab_id:
            from camofox.core.session import find_tab

            found = find_tab(session, body.tab_id)
            if found is None:
                raise HTTPException(404, {"error": f"Tab '{body.tab_id}' not found"})
            page = found["tab_state"].page
        else:
            tab_info = _first_tab_info(uid, body.engine)
            if tab_info is None:
                raise HTTPException(404, {"error": f"No tabs for profile '{body.profile}'"})
            for gk, group in session.tab_groups.items():
                for tid, ts in group.items():
                    page = ts.page
                    break
                break
            else:
                raise HTTPException(404, {"error": "No tabs"})

        element = await page.query_selector(body.selector)
        if element is None:
            raise HTTPException(404, {"error": f"Selector '{body.selector}' not found"})

        await element.set_input_files(body.paths)

        return {
            "success": True,
            "result": {
                "uploaded": len(body.paths),
                "paths": body.paths,
            },
        }
    except HTTPException:
        raise
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


# ---------------------------------------------------------------------------
# Storage checkpoint
# ---------------------------------------------------------------------------


@router.post("/storage/checkpoint")
async def post_storage_checkpoint(body: StorageCheckpointRequest):
    """Save storage state (cookies, localStorage) for a profile. (stub)"""
    return {
        "success": True,
        "result": {"ok": True, "checkpointed": True, "checkpoint": "stub_python_port"},
    }


# ---------------------------------------------------------------------------
# Flow management (stubs)
# ---------------------------------------------------------------------------


@router.post("/flow/run")
async def post_flow_run(body: FlowRunRequest):
    return {
        "success": True,
        "result": {"ok": True, "note": "not yet implemented (Python port)", "flow": body.flow},
    }


@router.post("/flow/list")
async def post_flow_list(body: ProfileSiteRequest):
    return {
        "success": True,
        "result": {"flows": [], "count": 0},
    }


@router.post("/flow/inspect")
async def post_flow_inspect(body: FlowInspectRequest):
    return {
        "success": True,
        "result": {"note": "not yet implemented (Python port)", "flow": body.flow},
    }


# ---------------------------------------------------------------------------
# Notifications (stubs)
# ---------------------------------------------------------------------------


@router.post("/notifications/status")
async def post_notifications_status(body: NotificationsRequest):
    return {
        "success": True,
        "result": {"status": "stub", "note": "not yet implemented (Python port)"},
        "raw": {"status": "stub", "note": "not yet implemented (Python port)"},
    }


@router.post("/notifications/enable")
async def post_notifications_enable(body: NotificationsEnableRequest):
    return {
        "success": True,
        "result": {
            "status": "stub",
            "note": "not yet implemented (Python port)",
            "confirm": body.confirm,
        },
        "raw": {
            "status": "stub",
            "note": "not yet implemented (Python port)",
            "confirm": body.confirm,
        },
    }


@router.post("/notifications/list")
async def post_notifications_list(body: NotificationsListRequest):
    return {
        "success": True,
        "result": {"notifications": [], "count": 0},
        "raw": {"notifications": [], "count": 0},
    }


@router.post("/notifications/watch")
async def post_notifications_watch(body: NotificationsWatchRequest):
    return {
        "success": True,
        "result": {"events": [], "count": 0},
        "raw": {"events": [], "count": 0},
    }


@router.post("/notifications/self-test")
async def post_notifications_self_test(body: NotificationsRequest):
    return {
        "success": True,
        "result": {"status": "stub", "note": "not yet implemented (Python port)"},
        "raw": {"status": "stub", "note": "not yet implemented (Python port)"},
    }
