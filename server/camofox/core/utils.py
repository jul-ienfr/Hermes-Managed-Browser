"""Utility helpers — shared across all modules."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional


def normalize_user_id(user_id: Any) -> str:
    """Normalize userId to string (JSON body may parse as number)."""
    return str(user_id)


def sha256_hex(data: str) -> str:
    """SHA-256 hex digest."""
    return hashlib.sha256(data.encode()).hexdigest()


def user_dir_from_id(profile_dir: str, user_id: str) -> Path:
    """Return the profile directory path for a given userId.
    Uses first 32 chars of SHA256(user_id) as subdirectory name (matching Node.js)."""
    hashed = sha256_hex(user_id)[:32]
    return Path(profile_dir).expanduser() / hashed


def make_tab_id() -> str:
    """Generate a unique tab ID matching JS fly.makeTabId() format."""
    return uuid.uuid4().hex[:12]


def make_session_id() -> str:
    """Generate a unique session ID."""
    return f"sess-{uuid.uuid4().hex[:12]}"


def timing_safe_compare(a: str, b: str) -> bool:
    """Constant-time string comparison."""
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return hmac.compare_digest(a, b)


def is_loopback_address(address: str) -> bool:
    """Check if an IP address is a loopback address."""
    return address in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost")


def validate_url(url: str) -> Optional[str]:
    """Validate a URL, return error message or None."""
    if not url or not isinstance(url, str):
        return "URL must be a non-empty string"
    url = url.strip()
    if not re.match(r'^https?://', url, re.IGNORECASE):
        return "URL must start with http:// or https://"
    if len(url) > 8192:
        return "URL too long (max 8192 chars)"
    return None


def clamp_to_viewport(x: float, y: float, width: int, height: int) -> tuple[float, float]:
    """Clamp coordinates to viewport bounds."""
    return max(0.0, min(x, float(width - 1))), max(0.0, min(y, float(height - 1)))


async def safe_page_close(page, timeout_ms: int = 5000) -> None:
    """Safely close a Playwright page with timeout."""
    if page is None:
        return
    try:
        await asyncio.wait_for(page.close(), timeout=timeout_ms / 1000)
    except Exception:
        pass  # page already closed or closing


def is_dead_context_error(msg: str) -> bool:
    """Check if error is a dead context/browser."""
    return any(
        phrase in msg
        for phrase in [
            "Target page, context or browser has been closed",
            "browser has been closed",
            "Context closed",
            "Browser closed",
        ]
    )


def is_timeout_error(msg: str) -> bool:
    """Check if error is a timeout."""
    return "timed out after" in msg or ("Timeout" in msg and "exceeded" in msg)


def is_proxy_error(msg: str) -> bool:
    """Check if error is proxy-related."""
    return "NS_ERROR_PROXY" in msg or "proxy connection" in msg or "Proxy connection" in msg


def resolve_profile_root(profile_dir: Optional[str]) -> Optional[str]:
    """Resolve profile root path, expanding ~ and env vars."""
    if not profile_dir:
        return None
    return os.path.expanduser(os.path.expandvars(profile_dir))


async def coalesce_inflight(cache: dict, key: str, factory):
    """Deduplicate concurrent async operations by key.
    If an inflight operation with the same key exists, await it instead of starting a new one.
    """
    existing = cache.get(key)
    if existing is not None:
        return await existing
    future = asyncio.ensure_future(factory())
    cache[key] = future
    try:
        return await future
    finally:
        cache.pop(key, None)


def random_id(length: int = 8) -> str:
    """Generate a random hex ID."""
    return uuid.uuid4().hex[:length]
