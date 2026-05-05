"""Notification polling routes — capture and poll for browser notifications."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.utils import normalize_user_id
from camofox.domain.notifications_store import (
    list_notifications,
    mark_notifications_read,
    set_notifications_enabled,
    status_notifications,
)

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
    status = status_notifications(uid, config.profile_dir)
    return {"ok": True, "userId": uid, **status}


@router.post("/enable")
async def notification_enable(body: UserIdRequest):
    """Enable notification capture for a user."""
    uid = normalize_user_id(body.userId)
    status = set_notifications_enabled(uid, True, config.profile_dir)
    log.info("Notification capture enabled for user %s", uid)
    return {"ok": True, "userId": uid, **status}


@router.post("/disable")
async def notification_disable(body: UserIdRequest):
    """Disable notification capture for a user."""
    uid = normalize_user_id(body.userId)
    status = set_notifications_enabled(uid, False, config.profile_dir)
    log.info("Notification capture disabled for user %s", uid)
    return {"ok": True, "userId": uid, **status}


@router.post("/list")
async def notification_list(body: UserIdRequest):
    """List buffered notifications for a user."""
    uid = normalize_user_id(body.userId)
    notifications = list_notifications(uid, config.profile_dir)
    return {
        "ok": True,
        "notifications": notifications,
        "count": len(notifications),
        "userId": uid,
    }


@router.post("/poll")
async def notification_poll(body: UserIdRequest):
    """Poll for unread notifications without losing durable history."""
    uid = normalize_user_id(body.userId)
    notifications = list_notifications(uid, config.profile_dir, unread_only=True)
    mark_notifications_read(uid, [str(item.get("id")) for item in notifications], profile_dir=config.profile_dir)
    return {
        "ok": True,
        "notifications": notifications,
        "count": len(notifications),
        "userId": uid,
    }


@router.post("/mark-read")
async def notification_mark_read(body: MarkReadRequest):
    """Mark notifications as read or all read if no IDs are provided."""
    uid = normalize_user_id(body.userId)
    result = mark_notifications_read(uid, body.notification_ids, profile_dir=config.profile_dir)
    log.info("Marked notifications read for user %s: %s", uid, result)
    return {"ok": True, "userId": uid, **result}
