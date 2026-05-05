"""Session management routes — /start, /stop, /sessions/*."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.browser import ensure_browser, close_browser
from camofox.core.engines import normalize_engine
from camofox.core.session import (
    get_session,
    close_session,
    get_total_tab_count,
    handle_route_error,
)
from camofox.core.utils import normalize_user_id

log = logging.getLogger("camofox.api.sessions")
router = APIRouter()


class StartRequest(BaseModel):
    userId: str
    proxy: dict[str, Any] | None = None
    headless: bool | None = None
    engine: str | None = None
    profileDir: str | None = None


class StopRequest(BaseModel):
    userId: str
    engine: str | None = None


class CookiesRequest(BaseModel):
    userId: str
    cookies: list[dict[str, Any]] | None = None
    cookie_file: str | None = None
    engine: str | None = None


@router.post("/start")
async def post_start(body: StartRequest):
    """Start a browser session for a user."""
    uid = normalize_user_id(body.userId)
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    try:
        result = await ensure_browser(uid, profile_dir=body.profileDir, engine=normalized_engine)
        session = await get_session(uid, profile_dir=body.profileDir, engine=normalized_engine)
        return {
            "ok": True,
            "browser": "connected",
            "launch_proxy": result.get("launch_proxy"),
            "persona": result.get("persona"),
            "display": result.get("display"),
            "engine": normalized_engine,
            "profile_dir": result.get("profile_dir"),
            "executable_path": result.get("executable_path"),
            "tab_count": get_total_tab_count(),
        }
    except Exception as err:
        status, body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=body)


@router.post("/stop")
async def post_stop(body: StopRequest):
    """Stop a browser session for a user."""
    uid = normalize_user_id(body.userId)
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    try:
        session = await get_session(uid, engine=normalized_engine)
        await close_session(uid, session, reason="user_stopped")
        await close_browser(uid, engine=normalized_engine)
        return {"ok": True, "message": f"Session closed for {uid}", "engine": normalized_engine}
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


@router.post("/sessions/{userId}/cookies")
async def post_cookies(userId: str, body: CookiesRequest):
    """Inject cookies into a session."""
    uid = normalize_user_id(userId)
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    try:
        session = await get_session(uid, engine=normalized_engine)
        if body.cookies:
            await session.context.add_cookies(body.cookies)
        return {"ok": True, "cookie_count": len(body.cookies or []), "engine": normalized_engine}
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)


@router.delete("/sessions/{userId}")
async def delete_session(userId: str, engine: str | None = Query(None)):
    """Close and destroy a user's session + browser."""
    uid = normalize_user_id(userId)
    normalized_engine = normalize_engine(engine or config.default_engine)
    try:
        session = await get_session(uid, engine=normalized_engine)
        await close_session(uid, session, reason="user_deleted")
        await close_browser(uid, engine=normalized_engine)
        return {"ok": True, "message": f"Session and browser destroyed for {uid}", "engine": normalized_engine}
    except Exception as err:
        status, error_body = await handle_route_error(err, user_id=uid)
        raise HTTPException(status_code=status, detail=error_body)
