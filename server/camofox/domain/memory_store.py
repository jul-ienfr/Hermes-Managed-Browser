"""Persistent managed memory flows for deterministic replay.

This is intentionally a minimal Python equivalent of the Node.js managed
browser memory layer: it persists recorded flows to disk by profile and flow ID
so callers can replay them without asking an LLM to rediscover the steps.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from camofox.core.config import config
from camofox.core.utils import user_dir_from_id

FLOW_INDEX_FILENAME = "managed-memory-index.json"
FLOW_DIRNAME = "managed-memory"
_SENSITIVE_KEYS = re.compile(r"(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)", re.I)
_SAFE_FLOW_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _validate_flow_id(flow_id: str) -> str:
    if not isinstance(flow_id, str) or not _SAFE_FLOW_ID.fullmatch(flow_id):
        raise ValueError("flow_id must be 1-128 chars and contain only letters, numbers, '.', '_' or '-'")
    return flow_id


def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{os.getpid()}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        tmp.rename(path)
    except Exception:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise


def _safe_read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text())
        return raw if isinstance(raw, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _redact(value: Any, key: str | None = None) -> Any:
    if key and _SENSITIVE_KEYS.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def _profile_memory_dir(profile: str, profile_dir: str | None = None) -> Path:
    root = profile_dir or config.profile_dir
    return user_dir_from_id(root, profile) / FLOW_DIRNAME


def _flow_path(profile: str, flow_id: str, profile_dir: str | None = None) -> Path:
    return _profile_memory_dir(profile, profile_dir) / f"{_validate_flow_id(flow_id)}.json"


def _index_path(profile: str, profile_dir: str | None = None) -> Path:
    return _profile_memory_dir(profile, profile_dir) / FLOW_INDEX_FILENAME


def _load_index(profile: str, profile_dir: str | None = None) -> dict[str, Any]:
    return _safe_read_json(_index_path(profile, profile_dir)) or {"flows": {}}


def record_flow(
    profile: str,
    flow: list[dict[str, Any]],
    flow_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    profile_dir: str | None = None,
) -> dict[str, Any]:
    """Persist a replayable flow for *profile* and return its descriptor."""
    if not isinstance(flow, list):
        raise TypeError("flow must be a list of step dictionaries")
    if any(not isinstance(step, dict) for step in flow):
        raise TypeError("each flow step must be a dictionary")

    now = time.time()
    fid = uuid.uuid4().hex[:16] if flow_id is None else _validate_flow_id(flow_id)
    redacted_flow = _redact(flow)
    payload: dict[str, Any] = {
        "profile": profile,
        "flow_id": fid,
        "created_at": now,
        "updated_at": now,
        "metadata": _redact(metadata or {}),
        "flow": redacted_flow,
        "step_count": len(redacted_flow),
    }

    path = _flow_path(profile, fid, profile_dir)
    previous = _safe_read_json(path)
    if previous and previous.get("created_at"):
        payload["created_at"] = previous["created_at"]

    _atomic_write(path, payload)

    index = _load_index(profile, profile_dir)
    flows = index.setdefault("flows", {})
    flows[fid] = {
        "flow_id": fid,
        "profile": profile,
        "path": str(path),
        "step_count": len(redacted_flow),
        "created_at": payload["created_at"],
        "updated_at": now,
        "metadata": payload["metadata"],
    }
    _atomic_write(_index_path(profile, profile_dir), index)
    return {**flows[fid], "flow": redacted_flow}


def load_flow(profile: str, flow_id: str, profile_dir: str | None = None) -> dict[str, Any] | None:
    """Load a persisted flow payload."""
    return _safe_read_json(_flow_path(profile, flow_id, profile_dir))


def list_flows(profile: str, profile_dir: str | None = None) -> list[dict[str, Any]]:
    """List flow descriptors for *profile*."""
    index = _load_index(profile, profile_dir)
    flows = index.get("flows", {})
    if not isinstance(flows, dict):
        return []
    return sorted(flows.values(), key=lambda item: item.get("updated_at", 0), reverse=True)
