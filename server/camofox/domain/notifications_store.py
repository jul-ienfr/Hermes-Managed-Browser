"""Persistent notification store for managed browser routes."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from camofox.core.config import config
from camofox.core.utils import user_dir_from_id

NOTIFICATIONS_FILENAME = "notifications.json"
DEFAULT_LIMIT = 100


def _path(user_id: str, profile_dir: str | None = None) -> Path:
    return user_dir_from_id(profile_dir or config.profile_dir, user_id) / NOTIFICATIONS_FILENAME


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{os.getpid()}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}")
    try:
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        tmp.rename(path)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise


def _read(user_id: str, profile_dir: str | None = None) -> dict[str, Any]:
    path = _path(user_id, profile_dir)
    if not path.is_file():
        return {"enabled": False, "notifications": []}
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"enabled": False, "notifications": []}
    if not isinstance(payload, dict):
        return {"enabled": False, "notifications": []}
    notifications = payload.get("notifications")
    if not isinstance(notifications, list):
        notifications = []
    return {"enabled": bool(payload.get("enabled", False)), "notifications": notifications}


def status_notifications(user_id: str, profile_dir: str | None = None) -> dict[str, Any]:
    payload = _read(user_id, profile_dir)
    unread = sum(1 for item in payload["notifications"] if not item.get("read"))
    return {
        "enabled": payload["enabled"],
        "count": len(payload["notifications"]),
        "unread": unread,
        "path": str(_path(user_id, profile_dir)),
    }


def set_notifications_enabled(user_id: str, enabled: bool, profile_dir: str | None = None) -> dict[str, Any]:
    payload = _read(user_id, profile_dir)
    payload["enabled"] = bool(enabled)
    payload["updated_at"] = time.time()
    _atomic_write(_path(user_id, profile_dir), payload)
    return status_notifications(user_id, profile_dir)


def add_notification(
    user_id: str,
    notification: dict[str, Any],
    profile_dir: str | None = None,
    max_items: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    payload = _read(user_id, profile_dir)
    item = {
        "id": str(notification.get("id") or uuid.uuid4().hex[:16]),
        "origin": notification.get("origin"),
        "title": notification.get("title") or notification.get("message") or "notification",
        "body": notification.get("body") or notification.get("text") or "",
        "timestamp": float(notification.get("timestamp") or time.time()),
        "read": bool(notification.get("read", False)),
        "data": notification.get("data") if isinstance(notification.get("data"), dict) else {},
    }
    notifications = [item, *payload["notifications"]]
    payload["notifications"] = notifications[:max_items]
    payload["updated_at"] = time.time()
    _atomic_write(_path(user_id, profile_dir), payload)
    return item


def list_notifications(
    user_id: str,
    profile_dir: str | None = None,
    limit: int | None = None,
    unread_only: bool = False,
) -> list[dict[str, Any]]:
    notifications = _read(user_id, profile_dir)["notifications"]
    if unread_only:
        notifications = [item for item in notifications if not item.get("read")]
    if limit is not None:
        notifications = notifications[: max(0, int(limit))]
    return notifications


def mark_notifications_read(
    user_id: str,
    notification_ids: list[str] | None = None,
    profile_dir: str | None = None,
    clear: bool = False,
) -> dict[str, Any]:
    payload = _read(user_id, profile_dir)
    notifications = payload["notifications"]
    if clear:
        cleared = len(notifications)
        payload["notifications"] = []
        payload["updated_at"] = time.time()
        _atomic_write(_path(user_id, profile_dir), payload)
        return {"cleared": cleared, "marked": 0}

    wanted = set(notification_ids or [])
    marked = 0
    for item in notifications:
        if not wanted or item.get("id") in wanted:
            if not item.get("read"):
                marked += 1
            item["read"] = True
    payload["updated_at"] = time.time()
    _atomic_write(_path(user_id, profile_dir), payload)
    return {"cleared": 0, "marked": marked}
