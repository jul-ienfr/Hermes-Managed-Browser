"""User profile persistence — load / save browser state to disk.

Mirrors ``lib/persistence.js`` from the Node.js camofox-browser.

Each user gets a deterministic directory under *profile_dir*:

.. code-block:: text

    {profile_dir}/
      {sha256_hex(user_id)[:32]}/
        browser-profile.json      # Full browser profile (persona + fingerprint)
        fingerprint.json          # Serialised browserforge Fingerprint
        fingerprint-meta.json     # Metadata about the fingerprint (version, source, …)
        storage-state.json        # Playwright storage state (cookies, localStorage)
        profile-policy.json       # Managed profile policy overrides

All writes are atomic (write-to-temp-then-rename) to prevent partial-file reads
on crash.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from camofox.core.utils import user_dir_from_id

log = logging.getLogger("camofox.profile")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STORAGE_STATE_FILENAME = "storage-state.json"
BROWSER_PROFILE_FILENAME = "browser-profile.json"
FINGERPRINT_FILENAME = "fingerprint.json"
FINGERPRINT_META_FILENAME = "fingerprint-meta.json"
PROFILE_POLICY_FILENAME = "profile-policy.json"

# ---------------------------------------------------------------------------
# Atomic file writing
# ---------------------------------------------------------------------------


def _atomic_write(path: Path, data: dict) -> None:
    """Write *data* as JSON to *path* atomically.

    Writes to a temporary file (``.tmp-{pid}-{ms}``) in the same directory,
    then renames over the target.  This is POSIX-atomic (same filesystem).
    Missing parent directories are created automatically.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{os.getpid()}-{int(time.time() * 1000)}")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        tmp.rename(path)
    except Exception:
        # Clean up temp file on failure
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise


def _safe_read_json(path: Path) -> dict | None:
    """Read a JSON file, returning ``None`` on any failure."""
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Failed to read %s: %s", path, exc)
        return None


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def get_user_persistence_paths(profile_dir: str, user_id: str) -> dict:
    """Return the paths dict for a user's persisted state files.

    Parameters
    ----------
    profile_dir : str
        Root profiles directory (e.g. ``~/.camofox/profiles``).
    user_id : str
        Normalised user identifier.

    Returns
    -------
    dict
        .. code-block:: python

            {
                "dir": Path,                  # User-specific directory
                "storage_state": Path,        # storage-state.json
                "meta": Path,                 # (alias: same as storage_state dir)
                "browser_profile": Path,      # browser-profile.json
                "profile_policy": Path,       # profile-policy.json
                "fingerprint": Path,          # fingerprint.json
                "fingerprint_meta": Path,    # fingerprint-meta.json
            }
    """
    user_dir = user_dir_from_id(profile_dir, user_id)
    return {
        "dir": user_dir,
        "storage_state": user_dir / STORAGE_STATE_FILENAME,
        "meta": user_dir,  # same directory, for convenience
        "browser_profile": user_dir / BROWSER_PROFILE_FILENAME,
        "profile_policy": user_dir / PROFILE_POLICY_FILENAME,
        "fingerprint": user_dir / FINGERPRINT_FILENAME,
        "fingerprint_meta": user_dir / FINGERPRINT_META_FILENAME,
    }


# ---------------------------------------------------------------------------
# Browser profile
# ---------------------------------------------------------------------------


def load_persisted_browser_profile(profile_dir: str, user_id: str) -> dict | None:
    """Load the persisted browser profile (``browser-profile.json``).

    Returns ``None`` if the file does not exist or is corrupt.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    return _safe_read_json(paths["browser_profile"])


def persist_browser_profile(profile_dir: str, user_id: str, profile: dict) -> dict:
    """Save *profile* as ``browser-profile.json`` atomically.

    Parameters
    ----------
    profile_dir : str
        Root profiles directory.
    user_id : str
        Normalised user identifier.
    profile : dict
        The profile data to persist.

    Returns
    -------
    dict
        A result dict with ``path`` (the saved file path) and ``size``
        (bytes written).
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    _atomic_write(paths["browser_profile"], profile)
    size = paths["browser_profile"].stat().st_size
    log.debug("Persisted browser profile to %s (%d bytes)", paths["browser_profile"], size)
    return {"path": str(paths["browser_profile"]), "size": size}


# ---------------------------------------------------------------------------
# Fingerprint
# ---------------------------------------------------------------------------


def load_persisted_fingerprint(profile_dir: str, user_id: str) -> dict | None:
    """Load the persisted fingerprint (``fingerprint.json`` + metadata).

    Returns
    -------
    dict or None
        Shape (when found):

        .. code-block:: python

            {
                "fingerprint": { ... },       # The browserforge fingerprint dict
                "metadata": { ... } | None,   # fingerprint-meta.json content
                "fingerprint_path": str,
                "fingerprint_meta_path": str | None,
            }

        Returns ``None`` when ``fingerprint.json`` does not exist.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)

    fp_data = _safe_read_json(paths["fingerprint"])
    if fp_data is None:
        return None

    meta_data = _safe_read_json(paths["fingerprint_meta"])

    return {
        "fingerprint": fp_data,
        "metadata": meta_data,
        "fingerprint_path": str(paths["fingerprint"]),
        "fingerprint_meta_path": str(paths["fingerprint_meta"]) if meta_data is not None else None,
    }


def persist_fingerprint(
    profile_dir: str,
    user_id: str,
    fingerprint: dict,
    metadata: dict | None = None,
) -> dict:
    """Save *fingerprint* (and optionally *metadata*) atomically.

    Parameters
    ----------
    profile_dir : str
        Root profiles directory.
    user_id : str
        Normalised user identifier.
    fingerprint : dict
        Serialised browserforge Fingerprint (must be JSON-serialisable).
    metadata : dict or None
        Optional metadata dict saved to ``fingerprint-meta.json`` (e.g.
        ``{"version": 2, "source": "generated", "created_at": "..."}``).

    Returns
    -------
    dict
        .. code-block:: python

            {
                "fingerprint_path": str,
                "fingerprint_meta_path": str | None,
                "fingerprint_size": int,
            }
    """
    paths = get_user_persistence_paths(profile_dir, user_id)

    _atomic_write(paths["fingerprint"], fingerprint)
    fp_size = paths["fingerprint"].stat().st_size

    meta_path: str | None = None
    if metadata:
        _atomic_write(paths["fingerprint_meta"], metadata)
        meta_path = str(paths["fingerprint_meta"])

    log.debug(
        "Persisted fingerprint to %s (%d bytes)",
        paths["fingerprint"],
        fp_size,
    )
    return {
        "fingerprint_path": str(paths["fingerprint"]),
        "fingerprint_meta_path": meta_path,
        "fingerprint_size": fp_size,
    }


# ---------------------------------------------------------------------------
# Storage state (Playwright)
# ---------------------------------------------------------------------------


def load_persisted_storage_state(profile_dir: str, user_id: str) -> str | None:
    """Return the path to ``storage-state.json`` if it exists, else ``None``.

    The caller can pass this path directly to Playwright's
    ``browser.new_context(storage_state=path)``.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    if paths["storage_state"].is_file():
        return str(paths["storage_state"])
    return None


async def persist_storage_state(profile_dir: str, user_id: str, context) -> dict:
    """Save the Playwright browser context's storage state atomically.

    Uses ``context.storage_state()`` to capture cookies, localStorage, etc.

    Parameters
    ----------
    profile_dir : str
        Root profiles directory.
    user_id : str
        Normalised user identifier.
    context : BrowserContext
        A Playwright ``BrowserContext`` instance.

    Returns
    -------
    dict
        ``{"path": str, "size": int}`` or ``{"error": str}`` on failure.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    target = paths["storage_state"]

    try:
        # Playwright's storage_state() returns a dict; we save it atomically.
        state = await context.storage_state()
        _atomic_write(target, state)
        size = target.stat().st_size
        log.debug("Persisted storage state to %s (%d bytes)", target, size)
        return {"path": str(target), "size": size}
    except Exception as exc:
        log.warning("Failed to persist storage state: %s", exc)
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Profile policy
# ---------------------------------------------------------------------------


def load_persisted_profile_policy(profile_dir: str, user_id: str) -> dict | None:
    """Load the persisted profile policy (``profile-policy.json``).

    Returns ``None`` if the file does not exist or is corrupt.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    return _safe_read_json(paths["profile_policy"])


def persist_profile_policy(profile_dir: str, user_id: str, policy: dict) -> dict:
    """Save *policy* as ``profile-policy.json`` atomically.

    Parameters
    ----------
    profile_dir : str
        Root profiles directory.
    user_id : str
        Normalised user identifier.
    policy : dict
        The policy data to persist.

    Returns
    -------
    dict
        ``{"path": str, "size": int}``.
    """
    paths = get_user_persistence_paths(profile_dir, user_id)
    _atomic_write(paths["profile_policy"], policy)
    size = paths["profile_policy"].stat().st_size
    log.debug("Persisted profile policy to %s (%d bytes)", paths["profile_policy"], size)
    return {"path": str(paths["profile_policy"]), "size": size}
