"""Managed browser system routes — profiles, leases, CLI, recovery."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from camofox.core.browser import browser_entries
from camofox.core.config import config
from camofox.core.engines import normalize_engine, make_browser_key
from camofox.core.session import create_server_owned_tab, get_session, sessions as all_sessions
from camofox.core.utils import normalize_user_id, validate_url
from camofox.domain.jobs import list_jobs, list_recovery, record_job, record_recovery, update_job
from camofox.domain.memory_store import list_flows, load_flow, record_flow
from camofox.domain.profile import persist_storage_state
from camofox.domain.replay import ReplayError, replay_flow_steps
from camofox.domain.snapshot import build_snapshot, window_snapshot
from camofox.managed.leases import ProfileLeaseError, lease_manager, serialize_profile_lease_error
from camofox.managed.profiles import (
    ManagedProfileError,
    list_managed_browser_profiles,
    managed_browser_profile_status,
    profile_to_user_id,
    resolve_managed_browser_profile,
)

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
    owner: str | None = None
    ttl: int | None = None
    ttl_ms: int | None = None
    ttlMs: int | None = None


class LeaseRenewRequest(BaseModel):
    profile: str
    lease_id: str
    ttl: int | None = None
    ttl_ms: int | None = None
    ttlMs: int | None = None


class LeaseReleaseRequest(BaseModel):
    profile: str
    lease_id: str


class CliOpenRequest(BaseModel):
    profile: str
    site: str | None = None
    url: str | None = None
    engine: str | None = None


class CliSnapshotRequest(BaseModel):
    profile: str
    site: str | None = None
    tab_id: str | None = None
    engine: str | None = None


class CliActRequest(BaseModel):
    profile: str
    action: str
    params: dict[str, Any] | None = None
    site: str | None = None
    engine: str | None = None
    tab_id: str | None = None
    timeout_ms: int | None = None

    # Node/JS clients commonly send camelCase.
    tabId: str | None = None
    timeoutMs: int | None = None

    @property
    def resolved_tab_id(self) -> str | None:
        return self.tab_id or self.tabId

    @property
    def resolved_timeout_ms(self) -> int | None:
        return self.timeout_ms or self.timeoutMs


class CliMemoryRecordRequest(BaseModel):
    profile: str
    site: str | None = None
    flow: list[dict[str, Any]]
    flow_id: str | None = None
    metadata: dict[str, Any] | None = None

class CliMemoryReplayRequest(BaseModel):
    profile: str
    site: str | None = None
    flow_id: str = "browser-actions"
    execute: bool = False
    engine: str | None = None
    tab_id: str | None = None
    timeout_ms: int | None = None
    params: dict[str, Any] | None = None

class CliMemoryListRequest(BaseModel):
    profile: str
    site: str | None = None
    include_flow: bool = False

class CliMemoryInspectRequest(BaseModel):
    profile: str
    site: str | None = None
    flow_id: str = "browser-actions"

class CliCheckpointRequest(BaseModel):
    profile: str
    engine: str | None = None


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
    engine: str | None = None


class JobRecordRequest(BaseModel):
    profile: str
    kind: str = "managed"
    status: str = "queued"
    payload: dict[str, Any] | None = None


class JobUpdateRequest(BaseModel):
    job_id: str
    status: str
    result: dict[str, Any] | None = None


class JobListRequest(BaseModel):
    profile: str | None = None


def _raise_managed_profile_error(err: ManagedProfileError) -> None:
    raise HTTPException(status_code=err.status_code, detail={"error": str(err), "code": err.code})


def _raise_lease_error(err: ProfileLeaseError) -> None:
    raise HTTPException(status_code=err.status_code, detail=serialize_profile_lease_error(err))


def _ttl_ms(body: Any) -> int | None:
    ttl_ms = getattr(body, "ttl_ms", None) or getattr(body, "ttlMs", None)
    ttl = getattr(body, "ttl", None)
    if ttl_ms is not None:
        return int(ttl_ms)
    if ttl is not None:
        return int(ttl * 1000)
    return None


def _first_tab(session: Any, tab_id: str | None = None) -> tuple[str, Any] | tuple[None, None]:
    """Return ``(tab_id, TabState)`` for a session, optionally by id."""
    if tab_id:
        for group in session.tab_groups.values():
            tab_state = group.get(tab_id)
            if tab_state is not None:
                return tab_id, tab_state
        return None, None
    for group in session.tab_groups.values():
        for existing_tab_id, tab_state in group.items():
            return existing_tab_id, tab_state
    return None, None


def _find_session_by_tab(tab_id: str) -> tuple[Any, str, Any] | tuple[None, None, None]:
    for session in all_sessions.values():
        found_tab_id, tab_state = _first_tab(session, tab_id)
        if tab_state is not None:
            return session, found_tab_id, tab_state
    return None, None, None


async def _ensure_managed_tab(uid: str, engine: str, tab_id: str | None = None) -> tuple[Any, str, Any]:
    if tab_id:
        session, found_tab_id, tab_state = _find_session_by_tab(tab_id)
        if tab_state is not None:
            return session, found_tab_id, tab_state
    session = await get_session(uid, engine=engine)
    found_tab_id, tab_state = _first_tab(session, tab_id)
    if tab_state is None:
        created = await create_server_owned_tab(session, user_id=uid, session_key="managed", url="about:blank")
        found_tab_id = created["tab_id"]
        tab_state = created["tab_state"]
    return session, found_tab_id, tab_state


async def _execute_replay_flow(uid: str, body: CliMemoryReplayRequest, flow_steps: list[dict[str, Any]]) -> dict[str, Any]:
    engine = normalize_engine(body.engine or config.default_engine)
    session = await get_session(uid, engine=engine)
    try:
        replay_result = await replay_flow_steps(
            session,
            user_id=uid,
            flow=flow_steps,
            tab_id=body.tab_id,
            session_key="managed",
            timeout_ms=body.timeout_ms,
            params=body.params,
        )
    except ReplayError as err:
        return {
            "ok": False,
            "executed": True,
            "profile": body.profile,
            "flow_id": body.flow_id,
            "flowId": body.flow_id,
            "error": str(err),
        }
    return {
        "profile": body.profile,
        "flow_id": body.flow_id,
        "flowId": body.flow_id,
        "stepCount": replay_result.get("step_count", len(flow_steps)),
        **replay_result,
    }


def _observed_for_profile(uid: str, engine: str | None = None) -> dict[str, Any]:
    normalized_engine = normalize_engine(engine or config.default_engine)
    session = all_sessions.get(make_browser_key(normalized_engine, uid))
    current_tab_id, _tab_state = _first_tab(session) if session else (None, None)
    return {"currentTabId": current_tab_id}


# ---------------------------------------------------------------------------
# Profile listing & status
# ---------------------------------------------------------------------------


@router.get("/profiles")
async def list_profiles():
    """List all managed profiles."""
    profiles = list_managed_browser_profiles()
    return {"profiles": profiles, "count": len(profiles)}

@router.get("/profiles/{profile}/status")
async def profile_status(profile: str, site: str | None = None, engine: str | None = None):
    """Check managed profile policy and live browser status."""
    try:
        policy = resolve_managed_browser_profile({"profile": profile, "site": site})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    normalized_engine = normalize_engine(engine or config.default_engine)
    entry = browser_entries.get(make_browser_key(normalized_engine, uid))
    status = managed_browser_profile_status(
        {"profile": profile, "site": site},
        observed=_observed_for_profile(uid, normalized_engine),
    )
    status.update({
        "exists": entry is not None,
        "alive": bool(entry and entry.browser is not None),
        "engine": normalized_engine,
        "display": entry.display if entry else None,
    })
    return status


# ---------------------------------------------------------------------------
# Profile lifecycle
# ---------------------------------------------------------------------------


@router.post("/profiles/ensure")
async def ensure_profile(body: ProfileEnsureRequest):
    """Resolve and validate a managed profile policy."""
    try:
        policy = resolve_managed_browser_profile({"profile": body.profile, "site": (body.config or {}).get("site")})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    return managed_browser_profile_status(
        {"profile": body.profile, "site": policy["siteKey"]},
        ensure=True,
        observed=_observed_for_profile(uid, body.engine),
    )


@router.post("/profiles/lease/acquire")
async def acquire_lease(body: LeaseAcquireRequest):
    """Acquire a managed profile lease."""
    try:
        profile = resolve_managed_browser_profile({"profile": body.profile})["profile"]
        lease = lease_manager.acquire(profile=profile, owner=body.owner, ttl_ms=_ttl_ms(body))
        return {"ok": True, "profile": profile, "lease": lease, **lease}
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    except ProfileLeaseError as err:
        _raise_lease_error(err)


@router.post("/profiles/lease/renew")
async def renew_lease(body: LeaseRenewRequest):
    """Renew a managed profile lease."""
    try:
        profile = resolve_managed_browser_profile({"profile": body.profile})["profile"]
        lease = lease_manager.renew(profile=profile, lease_id=body.lease_id, ttl_ms=_ttl_ms(body))
        return {"ok": True, "profile": profile, "lease": lease, **lease}
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    except ProfileLeaseError as err:
        _raise_lease_error(err)


@router.post("/profiles/lease/release")
async def release_lease(body: LeaseReleaseRequest):
    """Release a managed profile lease."""
    try:
        profile = resolve_managed_browser_profile({"profile": body.profile})["profile"]
        return lease_manager.release(profile=profile, lease_id=body.lease_id)
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    except ProfileLeaseError as err:
        _raise_lease_error(err)


# ---------------------------------------------------------------------------
# CLI operations
# ---------------------------------------------------------------------------


@router.post("/cli/open")
async def cli_open(body: CliOpenRequest):
    """Open a managed profile and optional URL, mirroring Node CLI open."""
    try:
        policy = resolve_managed_browser_profile({"profile": body.profile, "site": body.site})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    _session, tab_id, tab_state = await _ensure_managed_tab(uid, normalized_engine)
    target_url = body.url or policy.get("defaultStartUrl")
    if target_url:
        url_error = validate_url(target_url)
        if url_error:
            raise HTTPException(status_code=400, detail={"error": url_error})
        await tab_state.page.goto(target_url, wait_until="domcontentloaded", timeout=config.navigate_timeout_ms)
        tab_state.visited_urls.add(target_url)
        tab_state.last_requested_url = target_url
    return {
        "ok": True,
        "profile": policy["profile"],
        "siteKey": policy["siteKey"],
        "userId": uid,
        "engine": normalized_engine,
        "tab_id": tab_id,
        "tabId": tab_id,
        "url": tab_state.page.url,
    }


@router.post("/cli/snapshot")
async def cli_snapshot(body: CliSnapshotRequest):
    """Return a real DOM snapshot plus refs for managed CLI callers."""
    try:
        policy = resolve_managed_browser_profile({"profile": body.profile, "site": body.site})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    normalized_engine = normalize_engine(body.engine or config.default_engine)
    session = all_sessions.get(make_browser_key(normalized_engine, uid))
    if session is None:
        raise HTTPException(status_code=404, detail={"error": f"No session for profile '{body.profile}'"})
    tab_id, tab_state = _first_tab(session, body.tab_id)
    if tab_state is None:
        raise HTTPException(status_code=404, detail={"error": "No tab found for managed profile"})
    yaml, new_refs = await build_snapshot(tab_state.page)
    tab_state.refs.update(new_refs)
    windowed = window_snapshot(yaml)
    return {
        "ok": True,
        "profile": policy["profile"],
        "siteKey": policy["siteKey"],
        "userId": uid,
        "tab_id": tab_id,
        "tabId": tab_id,
        "url": tab_state.page.url,
        "engine": normalized_engine,
        "snapshot": windowed["text"],
        "truncated": windowed["truncated"],
        "has_more": windowed["has_more"],
        "refs": tab_state.refs,
        "result": {
            "snapshot": windowed["text"],
            "truncated": windowed["truncated"],
            "has_more": windowed["has_more"],
            "refs": tab_state.refs,
            "url": tab_state.page.url,
        },
    }


@router.post("/cli/act")
async def cli_act(body: CliActRequest):
    """Execute a single managed CLI action using the deterministic replay engine."""
    uid = profile_to_user_id(body.profile, body.site, allow_unknown=True)
    replay_body = CliMemoryReplayRequest(
        profile=body.profile,
        site=body.site,
        flow_id="__inline_cli_act__",
        execute=True,
        engine=body.engine,
        tab_id=body.resolved_tab_id,
        timeout_ms=body.resolved_timeout_ms,
    )
    step: dict[str, Any] = {"action": body.action}
    if isinstance(body.params, dict):
        step.update(body.params)
    result = await _execute_replay_flow(uid, replay_body, [step])
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    first_result = result.get("results", [{}])[0] if isinstance(result.get("results"), list) else {}
    return {
        "ok": True,
        "profile": body.profile,
        "userId": uid,
        "action": body.action,
        "tab_id": result.get("tab_id"),
        "tabId": result.get("tabId"),
        "url": result.get("url"),
        "result": first_result,
        "replay": result,
    }


@router.post("/cli/memory/record")
async def cli_memory_record(body: CliMemoryRecordRequest):
    """Persist an agent flow for later deterministic replay."""
    uid = profile_to_user_id(body.profile, body.site, allow_unknown=True)
    try:
        result = record_flow(
            uid,
            body.flow,
            flow_id=body.flow_id,
            metadata={**(body.metadata or {}), "managedProfile": body.profile, "site": body.site},
            profile_dir=config.profile_dir,
        )
        return {
            "ok": True,
            "profile": body.profile,
            "flow_id": result["flow_id"],
            "flowId": result["flow_id"],
            "step_count": result["step_count"],
            "path": result["path"],
        }
    except Exception as err:
        log.warning("Failed to record managed memory flow for %s: %s", uid, err)
        raise HTTPException(status_code=400, detail={"error": str(err)})


@router.post("/cli/memory/list")
async def cli_memory_list(body: CliMemoryListRequest):
    """List persisted managed memory flows for a profile."""
    uid = profile_to_user_id(body.profile, body.site, allow_unknown=True)
    flows = list_flows(uid, profile_dir=config.profile_dir)
    if body.include_flow:
        enriched = []
        for descriptor in flows:
            flow_id = descriptor.get("flow_id")
            payload = load_flow(uid, str(flow_id), profile_dir=config.profile_dir) if flow_id else None
            enriched.append({**descriptor, "flow": payload.get("flow", []) if isinstance(payload, dict) else []})
        flows = enriched
    return {"ok": True, "profile": body.profile, "userId": uid, "flows": flows, "count": len(flows)}


@router.post("/cli/memory/export")
@router.post("/cli/memory/inspect")
async def cli_memory_inspect(body: CliMemoryInspectRequest):
    """Inspect/export one persisted managed memory flow; defaults to browser-actions."""
    uid = profile_to_user_id(body.profile, body.site, allow_unknown=True)
    try:
        flow = load_flow(uid, body.flow_id, profile_dir=config.profile_dir)
    except ValueError as err:
        raise HTTPException(status_code=400, detail={"error": str(err)})
    if flow is None:
        raise HTTPException(status_code=404, detail={"error": f"Flow '{body.flow_id}' not found"})
    return {
        "ok": True,
        "profile": body.profile,
        "userId": uid,
        "flow_id": body.flow_id,
        "flowId": body.flow_id,
        "flow": flow.get("flow", []),
        "step_count": flow.get("step_count", len(flow.get("flow", [])) if isinstance(flow.get("flow"), list) else 0),
        "metadata": flow.get("metadata", {}),
        "created_at": flow.get("created_at"),
        "updated_at": flow.get("updated_at"),
    }


@router.post("/cli/memory/replay")
async def cli_memory_replay(body: CliMemoryReplayRequest):
    """Return or execute a persisted replay flow without LLM rediscovery."""
    uid = profile_to_user_id(body.profile, body.site, allow_unknown=True)
    try:
        flow = load_flow(uid, body.flow_id, profile_dir=config.profile_dir)
    except ValueError as err:
        raise HTTPException(status_code=400, detail={"error": str(err)})
    if flow is None:
        raise HTTPException(status_code=404, detail={"error": f"Flow '{body.flow_id}' not found"})
    flow_steps = flow.get("flow", [])
    if not isinstance(flow_steps, list):
        raise HTTPException(status_code=400, detail={"error": "Persisted flow is not a list"})
    if body.execute:
        result = await _execute_replay_flow(uid, body, flow_steps)
        if not result.get("ok"):
            raise HTTPException(status_code=422, detail=result)
        return result
    return {
        "ok": True,
        "executed": False,
        "profile": body.profile,
        "flow_id": body.flow_id,
        "flowId": body.flow_id,
        "flow": flow_steps,
        "step_count": flow.get("step_count", len(flow_steps)),
        "metadata": flow.get("metadata", {}),
    }


@router.post("/cli/checkpoint")
async def cli_checkpoint(body: CliCheckpointRequest):
    """Create a storage-state checkpoint for a managed profile."""
    uid = profile_to_user_id(body.profile, allow_unknown=True)
    session = all_sessions.get(make_browser_key(normalize_engine(body.engine or config.default_engine), uid))
    if session is None:
        raise HTTPException(status_code=404, detail={"error": f"No session for profile '{body.profile}'"})
    result = await persist_storage_state(session.profile_dir or config.profile_dir, uid, session.context)
    if result.get("error"):
        raise HTTPException(status_code=500, detail={"error": result["error"]})
    return {"ok": True, "profile": body.profile, "checkpointed": True, **result}


@router.post("/cli/release")
async def cli_release(body: CliReleaseRequest):
    """Release all active leases for a managed profile when called by CLI clients."""
    try:
        profile = resolve_managed_browser_profile({"profile": body.profile})["profile"]
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    released = lease_manager.release_all(profile=profile)
    event = record_recovery(
        profile=profile,
        tab_id=None,
        action="cli.release",
        status="released",
        detail={"released": released},
        profile_dir=config.profile_dir,
    )
    return {"ok": True, "profile": profile, "released": released, "event": event}


# ---------------------------------------------------------------------------
# Tab operations
# ---------------------------------------------------------------------------


@router.post("/visible-tab")
async def visible_tab(body: VisibleTabRequest):
    """Get or create the current visible tab for a managed profile."""
    try:
        policy = resolve_managed_browser_profile({"profile": body.profile})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    normalized_engine = normalize_engine(config.default_engine)
    _session, tab_id, tab_state = await _ensure_managed_tab(uid, normalized_engine, body.tab_id)
    return {
        "ok": True,
        "profile": policy["profile"],
        "userId": uid,
        "engine": normalized_engine,
        "tab_id": tab_id,
        "tabId": tab_id,
        "url": tab_state.page.url,
    }


@router.post("/recover-tab")
async def recover_tab(body: RecoverTabRequest):
    """Record a recovery event and return a usable managed tab."""
    try:
        policy = resolve_managed_browser_profile({"profile": body.profile})
    except ManagedProfileError as err:
        _raise_managed_profile_error(err)
    uid = normalize_user_id(policy["userId"])
    normalized_engine = normalize_engine(config.default_engine)
    _session, tab_id, tab_state = await _ensure_managed_tab(uid, normalized_engine, body.tab_id)
    event = record_recovery(
        profile=policy["profile"],
        tab_id=tab_id,
        action="recover-tab",
        status="ready",
        detail={"url": tab_state.page.url, "engine": normalized_engine},
        profile_dir=config.profile_dir,
    )
    return {
        "ok": True,
        "profile": policy["profile"],
        "userId": uid,
        "engine": normalized_engine,
        "tab_id": tab_id,
        "tabId": tab_id,
        "url": tab_state.page.url,
        "event": event,
    }


@router.post("/jobs/record")
async def managed_job_record(body: JobRecordRequest):
    job = record_job(kind=body.kind, profile=body.profile, status=body.status, payload=body.payload, profile_dir=config.profile_dir)
    return {"ok": True, "job": job, **job}


@router.post("/jobs/update")
async def managed_job_update(body: JobUpdateRequest):
    job = update_job(body.job_id, status=body.status, result=body.result, profile_dir=config.profile_dir)
    if job is None:
        raise HTTPException(status_code=404, detail={"error": f"Job '{body.job_id}' not found"})
    return {"ok": True, "job": job, **job}


@router.post("/jobs/list")
async def managed_job_list(body: JobListRequest):
    jobs = list_jobs(body.profile, profile_dir=config.profile_dir)
    return {"ok": True, "jobs": jobs, "count": len(jobs)}


@router.post("/recovery/list")
async def managed_recovery_list(body: JobListRequest):
    events = list_recovery(body.profile, profile_dir=config.profile_dir)
    return {"ok": True, "events": events, "count": len(events)}


@router.post("/storage-checkpoint")
async def storage_checkpoint(body: StorageCheckpointRequest):
    """Save storage state for a managed profile."""
    return await cli_checkpoint(CliCheckpointRequest(profile=body.profile, engine=body.engine))
