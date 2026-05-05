"""Managed browser system routes — profiles, leases, CLI, recovery."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.browser import browser_entries
from camofox.core.config import config
from camofox.core.engines import normalize_engine, make_browser_key
from camofox.core.utils import normalize_user_id

log = logging.getLogger("camofox.api.managed")
router = APIRouter()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ProfileEnsureRequest(BaseModel):
    profile: str
    config: dict[str, Any] | None = None
    engine: str | None = None


class LeaseAcquireRequest(BaseModel):
    profile: str
    ttl: int | None = None


class LeaseRenewRequest(BaseModel):
    profile: str
    lease_id: str


class LeaseReleaseRequest(BaseModel):
    profile: str
    lease_id: str


class CliOpenRequest(BaseModel):
    profile: str


class CliSnapshotRequest(BaseModel):
    profile: str
    tab_id: str | None = None


class CliActRequest(BaseModel):
    profile: str
    action: str
    params: dict[str, Any] | None = None


class CliMemoryRecordRequest(BaseModel):
    profile: str
    flow: list[dict[str, Any]]


class CliMemoryReplayRequest(BaseModel):
    profile: str
    flow_id: str


class CliCheckpointRequest(BaseModel):
    profile: str


class CliReleaseRequest(BaseModel):
    profile: str


class VisibleTabRequest(BaseModel):
    profile: str
    tab_id: str | None = None


class RecoverTabRequest(BaseModel):
    profile: str
    tab_id: str | None = None


class StorageCheckpointRequest(BaseModel):
    profile: str


# ---------------------------------------------------------------------------
# Profile listing & status
# ---------------------------------------------------------------------------


@router.get("/profiles")
async def list_profiles():
    """List all managed profiles."""
    # Stub — the full managed browser system is a separate module
    return {"profiles": [], "count": 0}


@router.get("/profiles/{profile}/status")
async def profile_status(profile: str, engine: str | None = None):
    """Check whether a browser entry exists for this profile."""
    uid = normalize_user_id(profile)
    normalized_engine = normalize_engine(engine or config.default_engine)
    entry = browser_entries.get(make_browser_key(normalized_engine, uid))
    if entry is None:
        return {"profile": profile, "exists": False, "alive": False, "engine": normalized_engine}
    return {
        "profile": profile,
        "exists": True,
        "alive": entry.browser is not None,
        "engine": entry.engine,
        "profile_dir": entry.profile_dir,
        "display": entry.display,
    }


# ---------------------------------------------------------------------------
# Profile lifecycle
# ---------------------------------------------------------------------------


@router.post("/profiles/ensure")
async def ensure_profile(body: ProfileEnsureRequest):
    """Ensure a profile exists. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/profiles/lease/acquire")
async def acquire_lease(body: LeaseAcquireRequest):
    """Acquire a profile lease. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/profiles/lease/renew")
async def renew_lease(body: LeaseRenewRequest):
    """Renew a profile lease. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/profiles/lease/release")
async def release_lease(body: LeaseReleaseRequest):
    """Release a profile lease. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


# ---------------------------------------------------------------------------
# CLI operations
# ---------------------------------------------------------------------------


@router.post("/cli/open")
async def cli_open(body: CliOpenRequest):
    """Open CLI on a managed profile. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/cli/snapshot")
async def cli_snapshot(body: CliSnapshotRequest):
    """Take a snapshot via CLI. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/cli/act")
async def cli_act(body: CliActRequest):
    """Execute an action via CLI. (stub)"""
    return {
        "ok": True,
        "note": "not yet implemented",
        "profile": body.profile,
        "action": body.action,
    }


@router.post("/cli/memory/record")
async def cli_memory_record(body: CliMemoryRecordRequest):
    """Record an agent flow. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/cli/memory/replay")
async def cli_memory_replay(body: CliMemoryReplayRequest):
    """Replay an agent flow. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/cli/checkpoint")
async def cli_checkpoint(body: CliCheckpointRequest):
    """Create a checkpoint. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/cli/release")
async def cli_release(body: CliReleaseRequest):
    """Release CLI. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


# ---------------------------------------------------------------------------
# Tab operations
# ---------------------------------------------------------------------------


@router.post("/visible-tab")
async def visible_tab(body: VisibleTabRequest):
    """Get or make a visible tab. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/recover-tab")
async def recover_tab(body: RecoverTabRequest):
    """Recover a tab. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}


@router.post("/storage-checkpoint")
async def storage_checkpoint(body: StorageCheckpointRequest):
    """Save storage state. (stub)"""
    return {"ok": True, "note": "not yet implemented", "profile": body.profile}
