"""Proxy pool — round-robin and backconnect providers.

Mirrors ``lib/proxy.js`` from the Node.js camofox-browser.
"""
from __future__ import annotations

import threading
from typing import Any, Optional

from camofox.core.config import ProxyConfig
from camofox.core.utils import random_id

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_proxy_pool_instance: dict | None = None
_round_robin_index: int = 0
_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def build_round_robin_url(host: str, port: int, protocol: str = "http") -> str:
    """Build a proxy URL string (e.g. ``http://host:port``)."""
    return f"{protocol}://{host}:{port}"


# ---------------------------------------------------------------------------
# Provider: Decodo
# ---------------------------------------------------------------------------


def _decodo_build_session_username(
    base_username: str,
    options: Optional[dict[str, Any]] = None,
) -> str:
    """Build a Decodo-style session username.

    Format::
        user-{base}-country-{cc}-state-{st}-session-{sid}-sessionduration-{min}
    """
    opts = options or {}
    country = opts.get("country", "")
    state_value = opts.get("state", "")
    session_id = opts.get("sessionId", f"sess-{random_id(12)}")
    session_duration = opts.get("sessionDurationMinutes", 10)

    parts = [f"user-{base_username}"]
    if country:
        parts.append(f"country-{country}")
    if state_value:
        parts.append(f"state-{state_value}")
    parts.append(f"session-{session_id}")
    parts.append(f"sessionduration-{session_duration}")
    return "-".join(parts)


def _decodo_build_proxy_url(
    proxy: dict[str, Any],
    config: ProxyConfig,
) -> str | None:
    """Build a full proxy URL for Decodo (CLI tools like yt-dlp)."""
    server = proxy.get("server", "")
    if not server:
        return None
    username = proxy.get("username", "")
    password = proxy.get("password", "")
    if username and password:
        return server.replace("http://", f"http://{username}:***@")
    return server


_DECODO_PROVIDER: dict[str, Any] = {
    "name": "decodo",
    "can_rotate_sessions": True,
    "launch_retries": 10,
    "launch_timeout_ms": 180000,
    "build_session_username": _decodo_build_session_username,
    "build_proxy_url": _decodo_build_proxy_url,
}

# ---------------------------------------------------------------------------
# Provider: Generic
# ---------------------------------------------------------------------------


def _generic_build_session_username(
    base_username: str,
    options: Optional[dict[str, Any]] = None,
) -> str:
    """Build a generic session username.

    Appends session ID if the provider supports session rotation.
    """
    opts = options or {}
    can_rotate = opts.get("can_rotate_sessions", True)
    if can_rotate:
        session_id = opts.get("sessionId", f"ctx-{random_id(12)}")
        return f"{base_username}-session-{session_id}"
    return base_username


def _generic_build_proxy_url(
    proxy: dict[str, Any],
    config: ProxyConfig,
) -> str | None:
    """Build a full proxy URL for generic providers (CLI tools like yt-dlp)."""
    server = proxy.get("server", "")
    if not server:
        return None
    username = proxy.get("username", "")
    password = proxy.get("password", "")
    if username and password:
        return server.replace("http://", f"http://{username}:***@")
    return server


_GENERIC_PROVIDER: dict[str, Any] = {
    "name": "generic",
    "can_rotate_sessions": True,
    "launch_retries": 5,
    "launch_timeout_ms": 120000,
    "build_session_username": _generic_build_session_username,
    "build_proxy_url": _generic_build_proxy_url,
}

# Provider registry
_PROVIDERS: dict[str, dict[str, Any]] = {
    "decodo": _DECODO_PROVIDER,
    "generic": _GENERIC_PROVIDER,
}

# ---------------------------------------------------------------------------
# Pool creation helpers
# ---------------------------------------------------------------------------


def _create_round_robin_pool(proxy_config: ProxyConfig) -> dict | None:
    """Create a round‑robin proxy pool from ``host`` + ``ports[]``."""
    host = proxy_config.host
    ports = proxy_config.ports
    if not host or not ports:
        return None

    # Build the list of proxy entries — one per port.
    proxy_entries: list[dict[str, Any]] = []
    for port in ports:
        proxy_entries.append(
            {
                "server": build_round_robin_url(host, port),
                "username": proxy_config.username or None,
                "password": proxy_config.password or None,
            }
        )

    def _get_proxy(session_id: str | None = None) -> dict[str, Any]:
        """Return the next proxy in round‑robin order."""
        global _round_robin_index
        with _lock:
            idx = _round_robin_index
            _round_robin_index = (idx + 1) % len(proxy_entries)
        entry = proxy_entries[idx]
        return {
            "server": entry["server"],
            "username": entry["username"],
            "password": entry["password"],
        }

    pool: dict[str, Any] = {
        "mode": "round_robin",
        "can_rotate_sessions": False,
        "launch_retries": 1,
        "launch_timeout_ms": 60000,
        "size": len(ports),
        "_entries": proxy_entries,
        "get_launch_proxy": _get_proxy,
        "get_next": _get_proxy,
    }

    return pool


def _create_backconnect_pool(proxy_config: ProxyConfig) -> dict | None:
    """Create a backconnect proxy pool using a provider (decodo / generic)."""
    provider = _PROVIDERS.get(proxy_config.provider_name or "generic")
    if provider is None:
        return None

    backconnect_host = proxy_config.backconnect_host
    backconnect_port = proxy_config.backconnect_port
    if not backconnect_host or not backconnect_port:
        return None

    pool: dict[str, Any] = {
        "mode": "backconnect",
        "provider": provider,
        "can_rotate_sessions": provider["can_rotate_sessions"],
        "launch_retries": provider["launch_retries"],
        "launch_timeout_ms": provider["launch_timeout_ms"],
        "size": 1,
    }

    def _get_proxy(session_id: str | None = None) -> dict[str, Any]:
        """Build a backconnect proxy entry (with optional session rotation)."""
        base_username = proxy_config.username
        password = proxy_config.password
        sid = session_id or f"sess-{random_id(12)}"

        build_username = provider.get("build_session_username")
        if build_username and provider["can_rotate_sessions"]:
            username: str = build_username(
                base_username,
                {
                    "country": proxy_config.country,
                    "state": proxy_config.state,
                    "sessionId": sid,
                    "sessionDurationMinutes": proxy_config.session_duration_minutes,
                    "can_rotate_sessions": provider["can_rotate_sessions"],
                },
            )
        else:
            username = base_username

        proxy_entry: dict[str, Any] = {
            "server": build_round_robin_url(backconnect_host, backconnect_port),
            "username": username if username else None,
            "password": password if password else None,
            "sessionId": sid,
        }
        return proxy_entry

    pool["get_launch_proxy"] = _get_proxy
    pool["get_next"] = _get_proxy

    return pool


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def create_proxy_pool(
    proxy_config: Optional[ProxyConfig] = None,
) -> dict | None:
    """Create a proxy pool based on configuration strategy.

    Two modes:

    * ``round_robin`` — cycles through a list of ports on a single host.
    * ``backconnect`` — uses a provider (decodo / generic) for session‑based
      proxies with automatic session ID rotation.

    Parameters
    ----------
    proxy_config : ProxyConfig or None
        Configuration object.  If ``None``, loads from ``Config.load().proxy``.

    Returns
    -------
    dict or None
        The proxy pool dict (see module docstring for shape), or ``None`` if
        required configuration fields are missing.

    Notes
    -----
    Sets the module‑level ``_proxy_pool_instance`` so that
    :func:`get_proxy_pool` returns the most recently created pool.
    """
    global _proxy_pool_instance

    if proxy_config is None:
        from camofox.core.config import Config as _Config

        cfg = _Config.load()
        proxy_config = cfg.proxy

    strategy = proxy_config.strategy

    if strategy == "round_robin":
        pool = _create_round_robin_pool(proxy_config)
    elif strategy == "backconnect":
        pool = _create_backconnect_pool(proxy_config)
    else:
        pool = None

    _proxy_pool_instance = pool
    return pool


def get_proxy_pool() -> dict | None:
    """Return the current proxy pool instance, or ``None``."""
    return _proxy_pool_instance


def normalize_playwright_proxy(proxy_entry: dict) -> dict:
    """Convert a proxy pool entry to Playwright‑compatible proxy settings.

    Playwright expects:
    ``{"server": str, "username": str | None, "password": str | None}``
    """
    return {
        "server": proxy_entry.get("server", ""),
        "username": proxy_entry.get("username"),
        "password": proxy_entry.get("password"),
    }


def build_proxy_url(
    pool: Optional[dict] = None,
    config: Optional[ProxyConfig] = None,
) -> str | None:
    """Build a full proxy URL string for CLI tools (e.g. yt‑dlp).

    Resolution order:

    1. **Backconnect** — uses the provider's ``build_proxy_url`` callback.
    2. **Round‑robin** — builds from the first entry in the pool.
    3. **Fallback** — builds from ``config.host`` / ``config.port`` or
       ``config.backconnect_host`` / ``config.backconnect_port``.

    Parameters
    ----------
    pool : dict or None
        The proxy pool dict.  Falls back to :func:`get_proxy_pool` when
        ``None``.
    config : ProxyConfig or None
        Configuration object.  Falls back to ``Config.load().proxy`` when
        ``None``.

    Returns
    -------
    str or None
        A URL of the form ``http://user:pass@host:port``, or ``None`` if
        insufficient data is available.
    """
    if pool is None:
        pool = _proxy_pool_instance
    if pool is None:
        return None

    if config is None:
        from camofox.core.config import Config as _Config

        cfg = _Config.load()
        config = cfg.proxy

    # --- Backconnect: delegate to provider ---
    if pool.get("mode") == "backconnect":
        provider = pool.get("provider")
        if provider:
            build_fn = provider.get("build_proxy_url")
            if build_fn:
                proxy_entry = pool["get_launch_proxy"](None)
                return build_fn(proxy_entry, config)

    # --- Round-robin: first entry ---
    entries = pool.get("_entries")
    if entries:
        entry = entries[0]
        server = entry["server"]
        username = entry.get("username")
        password = entry.get("password")
        if username and password:
            return server.replace("http://", f"http://{username}:***@")
        return server

    # --- Last resort: from config directly ---
    if config.host and config.port:
        server = build_round_robin_url(config.host, config.port)
        if config.username and config.password:
            return server.replace("http://", f"http://{config.username}:***@")
        return server
    if config.backconnect_host and config.backconnect_port:
        server = build_round_robin_url(config.backconnect_host, config.backconnect_port)
        if config.username and config.password:
            return server.replace("http://", f"http://{config.username}:***@")
        return server

    return None
