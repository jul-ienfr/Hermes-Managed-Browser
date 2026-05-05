"""Agent memory routes — record, search, delete, replay agent history."""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from camofox.core.utils import normalize_user_id

log = logging.getLogger("camofox.api.memory")
router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory agent memory store
# ---------------------------------------------------------------------------

_agent_memory: dict[str, list[dict[str, Any]]] = {}


def _get_entries(user_id: str) -> list[dict[str, Any]]:
    """Get the memory entries for a user, creating the list if absent."""
    if user_id not in _agent_memory:
        _agent_memory[user_id] = []
    return _agent_memory[user_id]


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class RecordRequest(BaseModel):
    userId: str
    action: str
    details: dict[str, Any] | None = None


class DeleteRequest(BaseModel):
    userId: str


class ReplayRequest(BaseModel):
    userId: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/record")
async def memory_record(body: RecordRequest):
    """Record an action to the agent history."""
    uid = normalize_user_id(body.userId)
    entry: dict[str, Any] = {
        "userId": uid,
        "action": body.action,
        "timestamp": time.time(),
    }
    if body.details:
        entry["details"] = body.details

    entries = _get_entries(uid)
    entries.append(entry)
    log.debug("Recorded memory entry for user %s: %s", uid, body.action)
    return {
        "ok": True,
        "entry": entry,
        "total": len(entries),
        "userId": uid,
    }


@router.get("/search")
async def memory_search(
    userId: str = Query(..., description="User ID to search"),
    query: str = Query("", description="Search query to filter entries"),
):
    """Search agent history for entries matching a query."""
    uid = normalize_user_id(userId)
    entries = _get_entries(uid)

    if not query:
        return {
            "ok": True,
            "results": entries,
            "count": len(entries),
            "userId": uid,
        }

    query_lower = query.lower()
    results = [
        e
        for e in entries
        if query_lower in e.get("action", "").lower()
        or query_lower in str(e.get("details", {})).lower()
    ]
    return {
        "ok": True,
        "results": results,
        "count": len(results),
        "userId": uid,
    }


@router.delete("/delete")
async def memory_delete(body: DeleteRequest):
    """Delete all history entries for a user."""
    uid = normalize_user_id(body.userId)
    count = len(_get_entries(uid))
    _agent_memory[uid] = []
    log.info("Deleted %d memory entries for user %s", count, uid)
    return {
        "ok": True,
        "deleted": count,
        "userId": uid,
    }


@router.post("/replay")
async def memory_replay(body: ReplayRequest):
    """Replay a recorded sequence.

    Returns the stored entries for replay; actual replay logic is
    not yet implemented.
    """
    uid = normalize_user_id(body.userId)
    entries = _get_entries(uid)
    return {
        "ok": True,
        "entries": entries,
        "count": len(entries),
        "userId": uid,
        "note": "stored entries returned; actual replay not yet implemented",
    }
