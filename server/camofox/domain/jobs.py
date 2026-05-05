"""Minimal durable lifecycle/recovery/job registry for the Python managed port."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from camofox.core.config import config

REGISTRY_DIRNAME = "managed-runtime"
JOBS_FILENAME = "jobs.json"
RECOVERY_FILENAME = "recovery.json"


def _root(profile_dir: str | None = None) -> Path:
    path = Path(profile_dir or config.profile_dir).expanduser() / REGISTRY_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path(filename: str, profile_dir: str | None = None) -> Path:
    return _root(profile_dir) / filename


def _read(filename: str, profile_dir: str | None = None) -> dict[str, Any]:
    path = _path(filename, profile_dir)
    if not path.is_file():
        return {"items": {}}
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"items": {}}
    return payload if isinstance(payload, dict) else {"items": {}}


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


def record_job(
    *,
    kind: str,
    profile: str,
    status: str = "queued",
    payload: dict[str, Any] | None = None,
    profile_dir: str | None = None,
) -> dict[str, Any]:
    registry = _read(JOBS_FILENAME, profile_dir)
    items = registry.setdefault("items", {})
    now = time.time()
    job_id = uuid.uuid4().hex[:16]
    item = {
        "id": job_id,
        "kind": kind,
        "profile": profile,
        "status": status,
        "payload": payload or {},
        "created_at": now,
        "updated_at": now,
    }
    items[job_id] = item
    _atomic_write(_path(JOBS_FILENAME, profile_dir), registry)
    return item


def update_job(job_id: str, *, status: str, result: dict[str, Any] | None = None, profile_dir: str | None = None) -> dict[str, Any] | None:
    registry = _read(JOBS_FILENAME, profile_dir)
    item = registry.setdefault("items", {}).get(job_id)
    if item is None:
        return None
    item["status"] = status
    item["updated_at"] = time.time()
    if result is not None:
        item["result"] = result
    _atomic_write(_path(JOBS_FILENAME, profile_dir), registry)
    return item


def list_jobs(profile: str | None = None, profile_dir: str | None = None) -> list[dict[str, Any]]:
    items = list((_read(JOBS_FILENAME, profile_dir).get("items") or {}).values())
    if profile:
        items = [item for item in items if item.get("profile") == profile]
    return sorted(items, key=lambda item: item.get("updated_at", 0), reverse=True)


def record_recovery(
    *,
    profile: str,
    tab_id: str | None,
    action: str,
    status: str,
    detail: dict[str, Any] | None = None,
    profile_dir: str | None = None,
) -> dict[str, Any]:
    registry = _read(RECOVERY_FILENAME, profile_dir)
    items = registry.setdefault("items", {})
    event_id = uuid.uuid4().hex[:16]
    item = {
        "id": event_id,
        "profile": profile,
        "tab_id": tab_id,
        "tabId": tab_id,
        "action": action,
        "status": status,
        "detail": detail or {},
        "created_at": time.time(),
    }
    items[event_id] = item
    _atomic_write(_path(RECOVERY_FILENAME, profile_dir), registry)
    return item


def list_recovery(profile: str | None = None, profile_dir: str | None = None) -> list[dict[str, Any]]:
    items = list((_read(RECOVERY_FILENAME, profile_dir).get("items") or {}).values())
    if profile:
        items = [item for item in items if item.get("profile") == profile]
    return sorted(items, key=lambda item: item.get("created_at", 0), reverse=True)
