"""Admin / health routes — healthcheck, metrics, profile status, fingerprint, auth."""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.engines import normalize_engine, make_browser_key, SUPPORTED_ENGINES
from camofox.core.session import get_total_tab_count, sessions
from camofox.core.browser import browser_entries
from camofox.core.utils import normalize_user_id

log = logging.getLogger("camofox.api.admin")
router = APIRouter()

# ---------------------------------------------------------------------------
# Server start time for uptime calculation
# ---------------------------------------------------------------------------

_server_start: float = time.time()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ProfileStatusRequest(BaseModel):
    userId: str | None = None
    profile: str | None = None
    site: str | None = None
    engine: str | None = None


class FingerprintDoctorRequest(BaseModel):
    userId: str
    fingerprint: dict[str, Any] | None = None


class AuthStatusRequest(BaseModel):
    pass


class AuthEnsureRequest(BaseModel):
    pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/health")
async def health():
    """Healthcheck endpoint returning server state."""
    elapsed = time.time() - _server_start
    tab_count = get_total_tab_count()
    session_count = len(sessions)

    return {
        "status": "ok",
        "version": "0.1.0",
        "uptime_seconds": round(elapsed, 2),
        "active_sessions": session_count,
        "active_tabs": tab_count,
        "node_env": config.node_env,
        "prometheus_enabled": config.prometheus_enabled,
        "default_engine": normalize_engine(config.default_engine),
        "engines": {
            engine: {
                "enabled": engine != "cloakbrowser" or config.cloakbrowser_enabled,
                "executable_path": config.cloakbrowser_executable_path if engine == "cloakbrowser" else None,
            }
            for engine in sorted(SUPPORTED_ENGINES)
        },
    }


@router.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint.

    Returns metrics in Prometheus text format if prometheus is enabled,
    or a plain-text message otherwise.
    """
    if not config.prometheus_enabled:
        return Response(
            content="# Prometheus metrics are disabled\n",
            media_type="text/plain; charset=utf-8",
        )

    try:
        from prometheus_client import generate_latest

        data = generate_latest()
        return Response(
            content=data,
            media_type="text/plain; charset=utf-8; version=0.0.4",
        )
    except Exception as exc:
        log.warning("Failed to generate Prometheus metrics: %s", exc)
        return Response(
            content="# Failed to generate metrics\n",
            media_type="text/plain; charset=utf-8",
        )


@router.post("/profile/status")
async def profile_status(body: ProfileStatusRequest):
    """Check if a profile has persisted data / a running session.

    Accepts either ``userId`` (Python native) or ``profile``+``site``
    (Node.js compatibility).
    """
    uid = body.userId or body.profile
    if not uid:
        raise HTTPException(422, {"error": "Provide userId or profile"})
    uid = normalize_user_id(uid)
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)

    entry = browser_entries.get(browser_key)
    if entry is None:
        return {
            "success": True,
            "status": "ok",
            "operation": "profile.status",
            "result": {
                "ok": True,
                "exists": False,
                "alive": False,
                "profile": body.profile or uid,
                "site": body.site or uid,
                "engine": normalized_engine,
            },
        }

    # Find first tab if any
    session_obj = sessions.get(browser_key)
    tab_id = None
    tab_url = None
    if session_obj:
        for group_key, group in session_obj.tab_groups.items():
            for tid, ts in group.items():
                tab_id = tid
                tab_url = ts.last_requested_url or (ts.page.url if ts.page else None)
                break
            break

    return {
        "success": True,
        "status": "ok",
        "operation": "profile.status",
        "result": {
            "ok": True,
            "exists": True,
            "alive": entry.browser is not None,
            "profile": body.profile or uid,
            "site": body.site or uid,
            "userId": uid,
            "engine": entry.engine,
            "profile_dir": entry.profile_dir,
            "executable_path": entry.executable_path,
            "lifecycle": {
                "state": "WARM" if entry.browser else "COLD",
                "currentTabId": tab_id,
                "currentTabUrl": tab_url,
            },
        },
    }


@router.post("/fingerprint/doctor")
async def fingerprint_doctor(body: FingerprintDoctorRequest):
    """Diagnose a fingerprint configuration."""
    # Stub — full fingerprint diagnosis not yet implemented
    return {
        "ok": True,
        "note": "not yet implemented",
        "userId": body.userId,
    }


@router.post("/auth/status")
async def auth_status(body: AuthStatusRequest):
    """Current auth configuration status."""
    api_key_configured = bool(config.api_key)
    admin_key_configured = bool(config.admin_key)
    return {
        "ok": True,
        "api_key_configured": api_key_configured,
        "admin_key_configured": admin_key_configured,
        "env": config.node_env,
    }


@router.post("/auth/ensure")
async def auth_ensure(body: AuthEnsureRequest):
    """Ensure auth is configured (idempotent)."""
    # Stub — full auth ensure logic not yet implemented
    return {
        "ok": True,
        "note": "not yet implemented",
        "api_key_configured": bool(config.api_key),
    }
