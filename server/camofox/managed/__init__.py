"""Managed browser system — profile lifecycle, leasing, recovery, CLI.

This module manages the lifecycle of managed browser profiles:

- **Profile lifecycle**: Create, retrieve, and track managed profiles with
  deterministic persona derivation.
- **Leasing**: Acquire, renew, and release exclusive leases on profiles to
  prevent concurrent access from multiple CLI agents.
- **CLI sessions**: Track CLI agent sessions attached to managed profiles,
  including agent memory and checkpoints.
- **Tab recovery**: Reconnect visible tabs after crashes, and save/load
  persistent storage state.
- **Display registry**: Find visible VNC displays assigned to managed profiles.

All state is held in-memory in the global dicts ``_profiles`` and
``_cli_sessions``.
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from camofox.core.config import Config as _Config
from camofox.core.utils import normalize_user_id, random_id, make_session_id
from camofox.core.plugins import plugin_events
from camofox.domain.persona import build_browser_persona
from camofox.domain.profile import (
    load_persisted_browser_profile,
    load_persisted_storage_state,
    persist_browser_profile,
)
from camofox.domain.vnc import read_display_registry

log = logging.getLogger("camofox.managed")


# ═══════════════════════════════════════════════════════════════════════════════
# Data structures
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ManagedProfile:
    """A managed browser profile with identity, persona, and state.

    Attributes
    ----------
    user_id : str
        Normalised user identifier.
    profile : str
        Profile name/key (e.g. ``"leboncoin-cim"``).
    site_key : str
        Site key (e.g. ``"amazon.fr"``).
    session_key : str
        Session key, ``"default"`` or custom.
    profile_dir : str
        Path to the profile data directory on disk.
    browser_persona_key : str
        Deterministically derived browser persona key.
    human_persona_key : str
        Deterministically derived human persona key.
    persona_data : dict or None
        The full browser persona dict (from :func:`build_browser_persona`).
    created_at : float
        Unix timestamp of profile creation.
    last_access : float
        Unix timestamp of last access / lease operation.
    lease_holder : str or None
        CLI session ID currently holding the lease, if any.
    lease_expires : float
        Unix timestamp when the current lease expires.
    lease_token : str or None
        Lease token used to authenticate lease operations.
    """

    user_id: str
    profile: str
    site_key: str
    session_key: str
    profile_dir: str
    browser_persona_key: str
    human_persona_key: str
    persona_data: dict | None = None
    created_at: float = 0.0
    last_access: float = 0.0
    lease_holder: str | None = None
    lease_expires: float = 0.0
    lease_token: str | None = None

    def to_dict(self) -> dict:
        """Return a JSON-serialisable dict representation."""
        return {
            "user_id": self.user_id,
            "profile": self.profile,
            "site_key": self.site_key,
            "session_key": self.session_key,
            "profile_dir": self.profile_dir,
            "browser_persona_key": self.browser_persona_key,
            "human_persona_key": self.human_persona_key,
            "persona_data": self.persona_data,
            "created_at": self.created_at,
            "last_access": self.last_access,
            "lease_holder": self.lease_holder,
            "lease_expires": self.lease_expires,
            "lease_token": self.lease_token,
        }


@dataclass
class ManagedCliSession:
    """A CLI agent session attached to a managed profile.

    Attributes
    ----------
    session_id : str
        Unique session identifier.
    user_id : str
        Normalised user identifier.
    profile_name : str
        Name of the managed profile this session is attached to.
    created_at : float
        Unix timestamp of session creation.
    last_activity : float
        Unix timestamp of last recorded activity.
    tab_id : str or None
        The currently attached tab ID, if any.
    memory : list[dict]
        Agent memory entries (ordered list of event dicts).
    checkpoint : dict or None
        Current checkpoint data for this session.
    """

    session_id: str
    user_id: str
    profile_name: str
    created_at: float = 0.0
    last_activity: float = 0.0
    tab_id: str | None = None
    memory: list[dict] = field(default_factory=list)
    checkpoint: dict | None = None

    def to_dict(self) -> dict:
        """Return a JSON-serialisable dict representation."""
        return {
            "session_id": self.session_id,
            "user_id": self.user_id,
            "profile_name": self.profile_name,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "tab_id": self.tab_id,
            "memory": self.memory,
            "checkpoint": self.checkpoint,
        }


# ═══════════════════════════════════════════════════════════════════════════════
# Global in-memory stores
# ═══════════════════════════════════════════════════════════════════════════════

_profiles: dict[str, ManagedProfile] = {}       # keyed by profile name
_cli_sessions: dict[str, ManagedCliSession] = {}  # keyed by session_id


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_persona_key(user_id: str, salt: str) -> str:
    """Derive a deterministic persona key from *user_id*.

    Uses SHA-256 with a salt to produce a consistent human-readable key
    (first 16 hex characters).  This matches the deterministic derivation
    pattern used in the persona system.
    """
    data = f"{salt}:{user_id}".encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    return digest[:16]


def _get_profile_root() -> str:
    """Return the configured root profile directory.

    Lazily loads from the configuration singleton.
    """
    return _Config.load().profile_dir


def _resolve_profile_dir(user_id: str) -> str:
    """Resolve the on-disk profile directory path for *user_id*.

    Uses the configured profile root as parent directory and applies the
    same deterministic subdirectory scheme (SHA-256 prefix) as the rest
    of the system.
    """
    from camofox.core.utils import user_dir_from_id

    return str(user_dir_from_id(_get_profile_root(), user_id))


def _now() -> float:
    """Return current Unix timestamp as a float."""
    return time.time()


# ═══════════════════════════════════════════════════════════════════════════════
# Profile listing & retrieval
# ═══════════════════════════════════════════════════════════════════════════════


def list_managed_profiles() -> list[dict]:
    """Return all managed profiles as dicts.

    Returns
    -------
    list[dict]
        A list of profile dicts as produced by :meth:`ManagedProfile.to_dict`.
    """
    return [p.to_dict() for p in _profiles.values()]


def get_managed_profile(profile_name: str) -> ManagedProfile | None:
    """Get a managed profile by name.

    Parameters
    ----------
    profile_name : str
        The profile name/key.

    Returns
    -------
    ManagedProfile or None
        The profile if found, else ``None``.
    """
    return _profiles.get(profile_name)


# ═══════════════════════════════════════════════════════════════════════════════
# Profile lifecycle
# ═══════════════════════════════════════════════════════════════════════════════


async def ensure_managed_profile(
    user_id: str,
    site_key: str,
    profile_name: str,
    session_key: str = "default",
) -> ManagedProfile:
    """Ensure a managed profile exists.

    If a profile with *profile_name* already exists in the global store,
    it is returned immediately.  Otherwise a new :class:`ManagedProfile` is
    created with deterministic persona keys and stored in ``_profiles``.

    Parameters
    ----------
    user_id : str
        Normalised user identifier.
    site_key : str
        Site key (e.g. ``"amazon.fr"``).
    profile_name : str
        Profile name/key (e.g. ``"leboncoin-cim"``).  Used as the key in
        ``_profiles``.
    session_key : str
        Session key (default ``"default"``).

    Returns
    -------
    ManagedProfile
        The existing or newly-created profile.

    Notes
    -----
    Emits the ``managed:profile:created`` plugin event when a new profile
    is created.
    """
    user_id = normalize_user_id(user_id)

    # Return existing profile if already tracked
    existing = _profiles.get(profile_name)
    if existing is not None:
        existing.last_access = _now()
        log.debug("Reusing existing managed profile '%s'", profile_name)
        return existing

    # Resolve deterministic persona keys
    browser_persona_key = _make_persona_key(user_id, "browser-persona")
    human_persona_key = _make_persona_key(user_id, "human-persona")

    # Build persona data
    persona_data = build_browser_persona(user_id)

    # Resolve on-disk profile directory path
    profile_dir = _resolve_profile_dir(user_id)

    now = _now()

    profile = ManagedProfile(
        user_id=user_id,
        profile=profile_name,
        site_key=site_key,
        session_key=session_key,
        profile_dir=profile_dir,
        browser_persona_key=browser_persona_key,
        human_persona_key=human_persona_key,
        persona_data=persona_data,
        created_at=now,
        last_access=now,
    )

    _profiles[profile_name] = profile

    # Emit plugin event
    plugin_events.emit("managed:profile:created", profile=profile.to_dict())

    log.info(
        "Created managed profile '%s' (user=%s, site=%s)",
        profile_name,
        user_id,
        site_key,
    )

    return profile


# ═══════════════════════════════════════════════════════════════════════════════
# Leasing
# ═══════════════════════════════════════════════════════════════════════════════


async def acquire_lease(
    profile_name: str,
    cli_session_id: str,
    duration_seconds: int = 300,
) -> dict:
    """Acquire a lease on a managed profile.

    Leases prevent concurrent access from multiple CLI agents.  Only one
    holder may hold a lease at a time.  If the existing lease has expired,
    any caller may claim it.  If the lease is still active and held by a
    different session, a :class:`RuntimeError` is raised.

    Parameters
    ----------
    profile_name : str
        Name of the managed profile.
    cli_session_id : str
        CLI session ID requesting the lease.
    duration_seconds : int
        Lease duration in seconds (default 300 = 5 minutes).

    Returns
    -------
    dict
        ``{"lease_token": str, "expires_at": float}``.

    Raises
    ------
    RuntimeError
        If the profile does not exist, or if the lease is held by a different
        session and has not expired.
    """
    profile = _profiles.get(profile_name)
    if profile is None:
        raise RuntimeError(
            f"Cannot acquire lease: profile '{profile_name}' not found"
        )

    now = _now()

    # Check for existing active lease
    if profile.lease_holder is not None and profile.lease_expires > now:
        if profile.lease_holder != cli_session_id:
            remaining = profile.lease_expires - now
            raise RuntimeError(
                f"Profile '{profile_name}' has an active lease held by "
                f"session '{profile.lease_holder}' "
                f"({remaining:.0f}s remaining)"
            )
        # Same holder — refresh / extend the lease
        profile.lease_expires = now + duration_seconds
        profile.last_access = now
        log.debug(
            "Extended lease for profile '%s' by session '%s' "
            "(expires in %ds)",
            profile_name,
            cli_session_id,
            duration_seconds,
        )
    else:
        # No active lease, or it has expired — grant new lease
        lease_token = random_id(24)
        profile.lease_holder = cli_session_id
        profile.lease_expires = now + duration_seconds
        profile.lease_token = lease_token
        profile.last_access = now

        log.info(
            "Acquired lease for profile '%s' by session '%s' "
            "(token=%s, expires in %ds)",
            profile_name,
            cli_session_id,
            lease_token,
            duration_seconds,
        )

    return {
        "lease_token": profile.lease_token,
        "expires_at": profile.lease_expires,
    }


async def renew_lease(
    profile_name: str,
    lease_token: str,
    duration_seconds: int = 300,
) -> dict:
    """Renew a lease if it has not expired and the token matches.

    Parameters
    ----------
    profile_name : str
        Name of the managed profile.
    lease_token : str
        The lease token returned by :func:`acquire_lease`.
    duration_seconds : int
        New lease duration in seconds (default 300).

    Returns
    -------
    dict
        ``{"lease_token": str, "expires_at": float, "renewed": bool}``.

    Raises
    ------
    RuntimeError
        If the profile does not exist, the lease token does not match, or
        the lease has already expired.
    """
    profile = _profiles.get(profile_name)
    if profile is None:
        raise RuntimeError(
            f"Cannot renew lease: profile '{profile_name}' not found"
        )

    now = _now()

    # Verify lease token
    if profile.lease_token is None or profile.lease_token != lease_token:
        raise RuntimeError(
            f"Lease token mismatch for profile '{profile_name}'"
        )

    # Check expiration
    if profile.lease_expires <= now:
        profile.lease_token = None
        profile.lease_holder = None
        profile.lease_expires = 0.0
        raise RuntimeError(
            f"Cannot renew lease for profile '{profile_name}': "
            "lease has already expired"
        )

    # Renew
    profile.lease_expires = now + duration_seconds
    profile.last_access = now

    log.debug(
        "Renewed lease for profile '%s' (expires in %ds)",
        profile_name,
        duration_seconds,
    )

    return {
        "lease_token": profile.lease_token,
        "expires_at": profile.lease_expires,
        "renewed": True,
    }


async def release_lease(profile_name: str, lease_token: str) -> dict:
    """Release a lease on a managed profile.

    Parameters
    ----------
    profile_name : str
        Name of the managed profile.
    lease_token : str
        The lease token returned by :func:`acquire_lease`.

    Returns
    -------
    dict
        ``{"released": bool, "profile": str}``.

    Raises
    ------
    RuntimeError
        If the profile does not exist or the lease token does not match.
    """
    profile = _profiles.get(profile_name)
    if profile is None:
        raise RuntimeError(
            f"Cannot release lease: profile '{profile_name}' not found"
        )

    if profile.lease_token is not None and profile.lease_token != lease_token:
        raise RuntimeError(
            f"Lease token mismatch for profile '{profile_name}'"
        )

    holder = profile.lease_holder
    profile.lease_holder = None
    profile.lease_expires = 0.0
    profile.lease_token = None
    profile.last_access = _now()

    log.info(
        "Released lease for profile '%s' (was held by '%s')",
        profile_name,
        holder,
    )

    return {"released": True, "profile": profile_name}


# ═══════════════════════════════════════════════════════════════════════════════
# CLI session management
# ═══════════════════════════════════════════════════════════════════════════════


async def create_cli_session(user_id: str, profile_name: str) -> ManagedCliSession:
    """Create a new CLI agent session for a managed profile.

    Parameters
    ----------
    user_id : str
        Normalised user identifier.
    profile_name : str
        Name of the managed profile this session is attached to.

    Returns
    -------
    ManagedCliSession
        The newly created session.

    Notes
    -----
    Emits the ``managed:cli:session:created`` plugin event.
    """
    user_id = normalize_user_id(user_id)
    session_id = make_session_id()
    now = _now()

    session = ManagedCliSession(
        session_id=session_id,
        user_id=user_id,
        profile_name=profile_name,
        created_at=now,
        last_activity=now,
    )

    _cli_sessions[session_id] = session

    plugin_events.emit(
        "managed:cli:session:created",
        session=session.to_dict(),
    )

    log.info(
        "Created CLI session '%s' for profile '%s' (user=%s)",
        session_id,
        profile_name,
        user_id,
    )

    return session


async def get_cli_session(session_id: str) -> ManagedCliSession | None:
    """Get an existing CLI session by ID.

    Parameters
    ----------
    session_id : str
        The session identifier.

    Returns
    -------
    ManagedCliSession or None
        The session if found, else ``None``.
    """
    session = _cli_sessions.get(session_id)
    if session is not None:
        session.last_activity = _now()
    return session


async def record_cli_memory(session_id: str, entry: dict) -> dict:
    """Record an agent memory entry in the CLI session history.

    Parameters
    ----------
    session_id : str
        The CLI session ID.
    entry : dict
        A memory event dict.  A ``timestamp`` field is added automatically
        if not present.

    Returns
    -------
    dict
        ``{"recorded": bool, "session_id": str, "entry_index": int}``.

    Raises
    ------
    RuntimeError
        If the session is not found.
    """
    session = _cli_sessions.get(session_id)
    if session is None:
        raise RuntimeError(f"CLI session '{session_id}' not found")

    # Add timestamp if missing
    if "timestamp" not in entry:
        entry["timestamp"] = _now()

    session.memory.append(entry)
    session.last_activity = _now()
    entry_index = len(session.memory) - 1

    log.debug(
        "Recorded memory entry %d for CLI session '%s'",
        entry_index,
        session_id,
    )

    return {
        "recorded": True,
        "session_id": session_id,
        "entry_index": entry_index,
    }


async def search_cli_memory(
    session_id: str,
    query: str | None = None,
) -> list:
    """Search agent memory for a CLI session.

    Parameters
    ----------
    session_id : str
        The CLI session ID.
    query : str or None
        If provided, only entries whose string representation contains
        *query* (case-insensitive substring match) are returned.
        If ``None``, all memory entries are returned.

    Returns
    -------
    list
        List of matching memory entry dicts.

    Raises
    ------
    RuntimeError
        If the session is not found.
    """
    session = _cli_sessions.get(session_id)
    if session is None:
        raise RuntimeError(f"CLI session '{session_id}' not found")

    session.last_activity = _now()

    if not query:
        return list(session.memory)

    query_lower = query.lower()
    results: list[dict] = []
    for entry in session.memory:
        # Convert entry to a flat searchable string
        entry_str = str(entry).lower()
        if query_lower in entry_str:
            results.append(entry)

    log.debug(
        "Searched CLI session '%s' memory: %d/%d entries matched query",
        session_id,
        len(results),
        len(session.memory),
    )

    return results


async def set_cli_checkpoint(session_id: str, data: dict) -> dict:
    """Create/save a checkpoint for a CLI session.

    Parameters
    ----------
    session_id : str
        The CLI session ID.
    data : dict
        The checkpoint data to store.

    Returns
    -------
    dict
        ``{"saved": bool, "session_id": str}``.

    Raises
    ------
    RuntimeError
        If the session is not found.
    """
    session = _cli_sessions.get(session_id)
    if session is None:
        raise RuntimeError(f"CLI session '{session_id}' not found")

    session.checkpoint = data
    session.last_activity = _now()

    log.debug("Saved checkpoint for CLI session '%s'", session_id)

    return {"saved": True, "session_id": session_id}


async def release_cli_session(session_id: str) -> dict:
    """Release and clean up a CLI session.

    Parameters
    ----------
    session_id : str
        The CLI session ID to release.

    Returns
    -------
    dict
        ``{"released": bool, "session_id": str}``.

    Raises
    ------
    RuntimeError
        If the session is not found.
    """
    session = _cli_sessions.pop(session_id, None)
    if session is None:
        raise RuntimeError(f"CLI session '{session_id}' not found")

    # Release any lease held by this session on its profile
    profile = _profiles.get(session.profile_name)
    if profile is not None and profile.lease_holder == session_id:
        profile.lease_holder = None
        profile.lease_expires = 0.0
        profile.lease_token = None
        log.debug(
            "Released lease on profile '%s' during CLI session release",
            session.profile_name,
        )

    plugin_events.emit(
        "managed:cli:session:released",
        session=session.to_dict(),
    )

    log.info("Released CLI session '%s'", session_id)

    return {"released": True, "session_id": session_id}


# ═══════════════════════════════════════════════════════════════════════════════
# Tab operations
# ═══════════════════════════════════════════════════════════════════════════════


async def find_visible_tab(profile_name: str) -> dict | None:
    """Find a visible tab for a managed profile.

    Checks the VNC display registry to see if a display is assigned to
    the profile's user.  This is used for human/VNC interaction where a
    visible browser window needs to be located.

    Parameters
    ----------
    profile_name : str
        The managed profile name.

    Returns
    -------
    dict or None
        If a display is found, returns:
        ``{"display": str, "resolution": str, "profile_window_size": dict | None}``.
        Returns ``None`` if the profile does not exist or no display is
        registered.
    """
    profile = _profiles.get(profile_name)
    if profile is None:
        log.warning(
            "find_visible_tab: profile '%s' not found",
            profile_name,
        )
        return None

    # Read the VNC display registry for this user
    registry = read_display_registry()
    entry = registry.get(profile.user_id)

    if entry is None:
        log.debug(
            "No VNC display registered for user '%s' (profile '%s')",
            profile.user_id,
            profile_name,
        )
        return None

    log.debug(
        "Found visible tab for profile '%s': display=%s",
        profile_name,
        entry.get("display"),
    )

    return {
        "display": entry.get("display"),
        "resolution": entry.get("resolution"),
        "profile_window_size": entry.get("profile_window_size"),
    }


async def recover_tab_profile(user_id: str, profile_name: str) -> dict:
    """Recover/reconnect a tab for a profile after a crash or disconnect.

    Looks up the managed profile and returns information needed to
    re-establish a browser session: persisted browser profile, storage
    state path, persona data, and VNC display info.

    Parameters
    ----------
    user_id : str
        Normalised user identifier.
    profile_name : str
        The managed profile name.

    Returns
    -------
    dict
        A recovery payload with keys:
        ``profile_name``, ``user_id``, ``exists``, ``profile_dir``,
        ``browser_profile``, ``storage_state_path``,
        ``persona_data``, ``display_info``.

        If the profile does not exist in the managed store, ``exists`` is
        ``False`` and other fields are ``None``.
    """
    user_id = normalize_user_id(user_id)
    profile = _profiles.get(profile_name)

    if profile is None:
        log.warning(
            "recover_tab_profile: profile '%s' not found in managed store",
            profile_name,
        )
        return {
            "profile_name": profile_name,
            "user_id": user_id,
            "exists": False,
            "profile_dir": None,
            "browser_profile": None,
            "storage_state_path": None,
            "persona_data": None,
            "display_info": None,
        }

    # Load persisted browser profile from disk
    browser_profile = load_persisted_browser_profile(
        _get_profile_root(), user_id
    )

    # Resolve storage state path
    storage_state_path = load_persisted_storage_state(
        _get_profile_root(), user_id
    )

    # Look up VNC display
    registry = read_display_registry()
    display_entry = registry.get(user_id)
    display_info: dict | None = None
    if display_entry is not None:
        display_info = {
            "display": display_entry.get("display"),
            "resolution": display_entry.get("resolution"),
            "profile_window_size": display_entry.get("profile_window_size"),
        }

    profile.last_access = _now()

    log.info(
        "Recovered tab info for profile '%s' (user=%s) — "
        "browser_profile=%s, storage_state=%s, display=%s",
        profile_name,
        user_id,
        "found" if browser_profile else "missing",
        "found" if storage_state_path else "missing",
        display_info.get("display") if display_info else "none",
    )

    return {
        "profile_name": profile_name,
        "user_id": user_id,
        "exists": True,
        "profile_dir": profile.profile_dir,
        "browser_profile": browser_profile,
        "storage_state_path": storage_state_path,
        "persona_data": profile.persona_data,
        "display_info": display_info,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Storage checkpointing
# ═══════════════════════════════════════════════════════════════════════════════


async def save_storage_checkpoint(user_id: str, profile_name: str) -> dict:
    """Save persistent storage state for a profile.

    Persists the current ``browser-profile.json`` to disk for the given
    user.  This is a lightweight checkpoint — the heavy lifting (Playwright
    ``storage_state``) is done by the caller with the actual browser context.

    Parameters
    ----------
    user_id : str
        Normalised user identifier.
    profile_name : str
        The managed profile name (used for logging and lookup).

    Returns
    -------
    dict
        A dict with keys:
        ``saved`` (bool), ``profile_name`` (str), ``user_id`` (str),
        ``path`` (str or None), ``size`` (int or None).

        If the profile is not tracked in the managed store, the persona
        data is built fresh for persistence.

    Notes
    -----
    This function saves the *persona* / *browser profile metadata* to disk.
    The actual Playwright storage state (cookies, localStorage) should be
    saved by calling :func:`persist_storage_state` with the browser context.
    """
    user_id = normalize_user_id(user_id)

    # Try to get managed profile for persona data
    profile = _profiles.get(profile_name)
    persona_data: dict | None = None
    if profile is not None:
        persona_data = profile.persona_data
        profile.last_access = _now()

    # Build the browser profile payload to persist
    # This mirrors what the session system stores on disk
    browser_payload: dict[str, Any] = {
        "user_id": user_id,
        "profile_name": profile_name,
        "saved_at": _now(),
        "persona": persona_data if persona_data else build_browser_persona(user_id),
    }

    # Persist to disk
    result = persist_browser_profile(
        _get_profile_root(), user_id, browser_payload
    )

    log.info(
        "Saved storage checkpoint for profile '%s' (user=%s) → %s (%d bytes)",
        profile_name,
        user_id,
        result.get("path", "?"),
        result.get("size", 0),
    )

    return {
        "saved": True,
        "profile_name": profile_name,
        "user_id": user_id,
        "path": result.get("path"),
        "size": result.get("size"),
    }
