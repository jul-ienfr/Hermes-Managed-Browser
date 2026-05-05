"""VNC routes — status, enable, disable VNC for users."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.utils import normalize_user_id
from camofox.domain.vnc import (
    resolve_vnc_config,
    read_display_registry,
    read_selected_vnc_user_id,
)

log = logging.getLogger("camofox.api.vnc")
router = APIRouter()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class UserIdRequest(BaseModel):
    userId: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/status")
async def vnc_status(body: UserIdRequest):
    """Return the current VNC status for the system or a specific user.

    Returns the resolved VNC configuration, the display registry state,
    and the currently selected VNC user (if any).
    """
    uid = normalize_user_id(body.userId)

    # Resolve VNC config from the application config
    vnc_cfg = resolve_vnc_config(
        plugin_config=config.vnc.model_dump() if hasattr(config.vnc, "model_dump") else None
    )

    display_registry = read_display_registry()
    selected_user = read_selected_vnc_user_id()

    user_entry = display_registry.get(uid)

    return {
        "ok": True,
        "enabled": vnc_cfg.get("enabled", False),
        "config": {
            "resolution": vnc_cfg.get("resolution"),
            "vnc_port": vnc_cfg.get("vnc_port"),
            "novnc_port": vnc_cfg.get("novnc_port"),
            "bind": vnc_cfg.get("bind"),
            "view_only": vnc_cfg.get("view_only"),
            "human_only": vnc_cfg.get("human_only"),
            "managed_registry_only": vnc_cfg.get("managed_registry_only"),
        },
        "user": uid,
        "user_display": user_entry,
        "selected_vnc_user": selected_user,
        "registry_entry_count": len(display_registry),
    }


@router.post("/enable")
async def vnc_enable(body: UserIdRequest):
    """Enable VNC for a user.

    Stub implementation — records the intent to enable VNC.
    Full VNC watcher launch will be added in a future module.
    """
    uid = normalize_user_id(body.userId)
    log.info("VNC enable requested for user %s", uid)

    vnc_cfg = resolve_vnc_config(
        plugin_config=config.vnc.model_dump() if hasattr(config.vnc, "model_dump") else None
    )

    if not vnc_cfg.get("enabled", False):
        return {
            "ok": False,
            "note": "VNC is globally disabled in configuration",
            "userId": uid,
        }

    return {
        "ok": True,
        "note": "VNC enable recorded; full watcher launch not yet implemented",
        "userId": uid,
    }


@router.post("/disable")
async def vnc_disable(body: UserIdRequest):
    """Disable VNC for a user.

    Stub implementation — records the intent to disable VNC.
    Full VNC watcher shutdown will be added in a future module.
    """
    uid = normalize_user_id(body.userId)
    log.info("VNC disable requested for user %s", uid)

    return {
        "ok": True,
        "note": "VNC disable recorded; full watcher shutdown not yet implemented",
        "userId": uid,
    }
