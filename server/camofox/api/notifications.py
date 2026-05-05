"""Notification polling routes — capture and poll for browser notifications."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.utils import normalize_user_id

log = logging.getLogger("camofox.api.notifications")
router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory notification store
# ---------------------------------------------------------------------------

_notification_store: dict[str, list[dict[str, Any]]] = {}
_notification_enabled: dict[str, bool] = {}


def _get_notifications(user_id: str) -> list[dict[str, Any]]:
    """Get the notification list for a user, creating it if absent."""
    if user_id not in _notification_store:
        _notification_store[user_id] = []
    return _notification_store[user_id]


def _is_enabled(user_id: str) -> bool:
    return _notification_enabled.get(user_id, False)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class UserIdRequest(BaseModel):
    userId: str


class MarkReadRequest(BaseModel):
    userId: str
    notification_ids: list[str] | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/status")
async def notification_status(body: UserIdRequest):
    """Return the current notification state for a user."""
    uid = normalize_user_id(body.userId)
    enabled = _is_enabled(uid)
    notifications = _get_notifications(uid)
    return {
        "ok": True,
        "enabled": enabled,
        "count": len(notifications),
        "userId": uid,
    }


@router.post("/enable")
async def notification_enable(body: UserIdRequest):
    """Enable notification capture for a user."""
    uid = normalize_user_id(body.userId)
    _notification_enabled[uid] = True
    log.info("Notification capture enabled for user %s", uid)
    return {"ok": True, "enabled": True, "userId": uid}


@router.post("/disable")
async def notification_disable(body: UserIdRequest):
    """Disable notification capture for a user."""
    uid = normalize_user_id(body.userId)
    _notification_enabled[uid] = False
    log.info("Notification capture disabled for user %s", uid)
    return {"ok": True, "enabled": False, "userId": uid}


@router.post("/list")
async def notification_list(body: UserIdRequest):
    """List buffered notifications for a user."""
    uid = normalize_user_id(body.userId)
    notifications = _get_notifications(uid)
    return {
        "ok": True,
        "notifications": notifications,
        "count": len(notifications),
        "userId": uid,
    }


@router.post("/poll")
async def notification_poll(body: UserIdRequest):
    """Poll for new notifications.

    Simplified implementation — returns immediately with any stored
    notifications rather than blocking.
    """
    uid = normalize_user_id(body.userId)
    notifications = _get_notifications(uid)
    result = {
        "ok": True,
        "notifications": notifications,
        "count": len(notifications),
        "userId": uid,
    }
    # Clear after poll (matching the "buffered" semantics)
    _notification_store[uid] = []
    return result


@router.post("/mark-read")
async def notification_mark_read(body: MarkReadRequest):
    """Mark notifications as read by clearing the store."""
    uid = normalize_user_id(body.userId)
    count = len(_get_notifications(uid))
    _notification_store[uid] = []
    log.info("Marked %d notifications as read for user %s", count, uid)
    return {"ok": True, "cleared": count, "userId": uid}
