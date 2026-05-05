"""Browser fingerprint generation and launch-option building for Camoufox.

Mirrors ``lib/camoufox-launch-profile.js`` and parts of ``lib/browser-persona.js``
from the Node.js camofox-browser.

Fingerprints can be:
- Generated fresh at launch time by passing ``config``, ``os``, ``screen``,
  ``window``, etc. into ``launch_options()`` / ``AsyncCamoufox()``.
- Persisted and re-applied by passing a ``fingerprint`` (``Fingerprint``
  instance) to ``launch_options()`` — guaranteeing the same user gets the
  same fingerprint across sessions.

The Python camoufox library handles all actual browserforge fingerprint
generation internally; this module focuses on *which* parameters to pass
and how to resolve browser versions.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

from camofox.core.utils import sha256_hex, user_dir_from_id

log = logging.getLogger("camofox.fingerprint")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CAMOUFOX_CACHE = Path("~/.cache/camoufox").expanduser()
"""Default camoufox cache root (~/.cache/camoufox)."""

DEFAULT_BROWSER_BINARY = "camoufox-bin"
"""Standard binary name inside a browser version directory."""

# ---------------------------------------------------------------------------
# Browser version resolution
# ---------------------------------------------------------------------------


def resolve_browser_version(version: str) -> str | None:
    """Resolve a browser version string to an absolute binary path.

    The *version* string can be in several forms:

    ``official/146.0.1``
        → ``~/.cache/camoufox/browsers/official/146.0.1/camoufox-bin``
    ``coryking/142.0.1-fork.26``
        → ``~/.cache/camoufox/browsers/coryking/142.0.1-fork.26/camoufox-bin``
    ``146.0.1``  (bare version)
        → ``~/.cache/camoufox/browsers/official/146.0.1/camoufox-bin``

    Returns ``None`` when the binary does not exist on disk.
    """
    if not version or not isinstance(version, str):
        return None

    version = version.strip()
    if not version:
        return None

    # Split into (channel, version_part)
    if "/" in version:
        channel, ver = version.split("/", 1)
        channel = channel.strip()
        ver = ver.strip()
    else:
        channel = "official"
        ver = version

    if not channel or not ver:
        return None

    binary = CAMOUFOX_CACHE / "browsers" / channel / ver / DEFAULT_BROWSER_BINARY
    if binary.is_file():
        return str(binary.resolve())

    # Fallback: also check camoufox root (legacy single-version layout)
    legacy = CAMOUFOX_CACHE / DEFAULT_BROWSER_BINARY
    if legacy.is_file():
        return str(legacy.resolve())

    log.debug("Browser binary not found at %s", binary)
    return None


def read_active_version_from_config() -> str | None:
    """Read the active browser version from ``~/.cache/camoufox/config.json``.

    Returns
    -------
    str or None
        The ``active_version`` field value (e.g. ``"official/146.0.1"``), or
        ``None`` if the file is missing, corrupt, or the field is absent.
    """
    config_path = CAMOUFOX_CACHE / "config.json"
    if not config_path.is_file():
        return None
    try:
        data = json.loads(config_path.read_text())
        version: str | None = data.get("active_version")
        return version if version else None
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Failed to read camoufox config.json: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Fingerprint helpers
# ---------------------------------------------------------------------------


def expected_fingerprint_from_launch_profile(
    launch_profile: dict | None = None,
) -> dict | None:
    """Extract expected fingerprint fields from a launch profile.

    The ``launch_profile`` is expected to have the shape returned by
    the session/persona builder:

    .. code-block:: python

        {
            "persona": { "os": str, "locale": str, "screen": {w, h},
                         "window": {w, h}, ... },
            "firefox_user_prefs": {...},
            "persisted_fingerprint": {...} | None,
        }

    Returns the raw ``persisted_fingerprint`` dict if available, otherwise
    ``None`` — meaning a fresh fingerprint should be generated.

    Notes
    -----
    The ``persisted_fingerprint`` must be a ``browserforge.fingerprints.Fingerprint``
    dict (or serializable to one) — i.e. it must contain ``screen``,
    ``navigator``, ``headers``, ``videoCodecs``, ``audioCodecs``, etc.
    """
    if not launch_profile:
        return None
    pf = launch_profile.get("persisted_fingerprint")
    if pf is not None and isinstance(pf, dict) and pf.get("navigator"):
        return pf
    return None


def resolve_fingerprint_generator_config(
    launch_profile: dict | None = None,
) -> dict:
    """Resolve the config dict for fingerprint generation from persona + constraints.

    The camoufox ``launch_options()`` function accepts parameters like
    ``os``, ``screen``, ``window``, ``locale``, etc. that control how the
    fingerprint is generated internally by browserforge.

    This helper extracts those from a ``launch_profile`` (as produced by the
    persona system) and returns a dict of key/value pairs suitable for
    spreading into ``launch_options()``.

    Parameters
    ----------
    launch_profile : dict or None
        A launch profile with a ``persona`` key.

    Returns
    -------
    dict
        Keyword arguments for ``launch_options()`` related to fingerprint
        generation (``os``, ``screen``, ``window``, ``locale``, etc.).
    """
    config: dict[str, Any] = {}

    if not launch_profile:
        return config

    persona = launch_profile.get("persona") or {}

    # --- OS ---
    os_val = persona.get("os")
    if os_val:
        config["os"] = os_val

    # --- Screen ---
    screen = persona.get("screen")
    if screen and isinstance(screen, dict):
        config["screen"] = {"width": screen["width"], "height": screen["height"]}

    # --- Window ---
    window = persona.get("window")
    if window:
        if isinstance(window, dict):
            config["window"] = (window.get("outerWidth", 0), window.get("outerHeight", 0))
        elif isinstance(window, (list, tuple)) and len(window) == 2:
            config["window"] = tuple(window)

    # --- Viewport ---
    viewport = persona.get("viewport")
    if viewport and isinstance(viewport, dict):
        if "window" not in config:
            config["window"] = (viewport.get("width", 0), viewport.get("height", 0))

    # --- Locale ---
    locale_val = persona.get("locale")
    if locale_val:
        config["locale"] = locale_val

    # --- Languages ---
    languages = persona.get("languages")
    if languages:
        config["locale"] = languages  # type: ignore[assignment]

    # --- Launch screen constraints (used by Camoufox to constrain fp) ---
    constraints = persona.get("launchScreenConstraints")
    if constraints and isinstance(constraints, dict):
        if "screen" not in config:
            config["screen"] = {
                "minWidth": constraints.get("minWidth", 0),
                "maxWidth": constraints.get("maxWidth", 0),
                "minHeight": constraints.get("minHeight", 0),
                "maxHeight": constraints.get("maxHeight", 0),
            }
        else:
            # Already have screen coords — ensure they match constraints
            pass

    # --- Firefox preferences ---
    prefs = launch_profile.get("firefox_user_prefs") or persona.get("firefoxUserPrefs")
    if prefs and isinstance(prefs, dict):
        config["firefox_user_prefs"] = prefs

    # --- Camoufox config (profile path, etc.) ---
    launch_config = launch_profile.get("config")
    if launch_config and isinstance(launch_config, dict):
        # Merge; config keys from launch_profile take precedence
        existing_config = config.get("config", {})
        existing_config.update(launch_config)
        config["config"] = existing_config

    return config


# ---------------------------------------------------------------------------
# Build launch options
# ---------------------------------------------------------------------------


def build_camoufox_launch_options(
    launch_profile: dict | None = None,
    options: dict | None = None,
) -> dict:
    """Build the kwargs dict for ``camoufox.launch_options()``.

    This is the central mapping from the camofox-browser *launch profile*
    (persona + persisted state) to the parameters accepted by camoufox's
    ``launch_options()`` function.

    Parameters
    ----------
    launch_profile : dict or None
        Shape:

        .. code-block:: python

            {
                "persona": {"os": str, "locale": str, "screen": {w, h},
                            "window": {w, h}, ...},
                "firefox_user_prefs": {...},
                "persisted_fingerprint": {...} | None,
                "proxy": { ... } | None,
            }

    options : dict or None
        Override / runtime options.  Shape:

        .. code-block:: python

            {
                "proxy_server": dict | None,
                "headless": bool | None,
                "display": str | None,  # DISPLAY env var
                "config": dict | None,   # extra camoufox config
            }

    Returns
    -------
    dict
        A keyword-argument dict suitable for ``camoufox.launch_options(**result)``
        or ``AsyncCamoufox(**result)``.
    """
    launch_profile = launch_profile or {}
    options = options or {}

    persona = launch_profile.get("persona") or {}
    result: dict[str, Any] = {}

    # --- 1. Core camoufox config ---
    launch_config = launch_profile.get("config") or {}
    opt_config = options.get("config") or {}
    merged_config = {**launch_config, **opt_config}
    if merged_config:
        result["config"] = merged_config

    # --- 2. OS ---
    os_val = persona.get("os")
    if os_val:
        result["os"] = os_val

    # --- 3. Screen ---
    screen = persona.get("screen")
    if screen and isinstance(screen, dict):
        w = screen.get("width")
        h = screen.get("height")
        if w and h:
            result["screen"] = {"width": w, "height": h}

    # --- 4. Window ---
    window = persona.get("window")
    if window:
        if isinstance(window, dict):
            w = window.get("outerWidth") or window.get("width")
            h = window.get("outerHeight") or window.get("height")
            if w and h:
                result["window"] = (w, h)
        elif isinstance(window, (list, tuple)) and len(window) == 2:
            result["window"] = tuple(window)

    # Fallback to screen size if window not set
    if "window" not in result and "screen" in result:
        s = result["screen"]
        result["window"] = (s["width"], s["height"])

    # --- 5. Fingerprint (persisted or generated) ---
    persisted_fp = launch_profile.get("persisted_fingerprint")
    if persisted_fp and isinstance(persisted_fp, dict):
        # The camoufox Python library accepts a ``browserforge.Fingerprint``
        # object as the ``fingerprint`` parameter.  If we have a dict, try
        # importing the Fingerprint class and reconstructing it.
        fp_obj = _dict_to_fingerprint(persisted_fp)
        if fp_obj is not None:
            result["fingerprint"] = fp_obj

    # --- 6. Locale ---
    locale_val = persona.get("locale")
    if locale_val:
        result["locale"] = locale_val

    languages = persona.get("languages")
    if languages and not locale_val:
        # Use languages list as locale
        result["locale"] = languages

    # --- 7. Proxy ---
    proxy_source = options.get("proxy_server") or launch_profile.get("proxy")
    if proxy_source and isinstance(proxy_source, dict):
        proxy_dict: dict[str, str] = {}
        server = proxy_source.get("server") or ""
        if not server:
            host = proxy_source.get("host", "")
            port = proxy_source.get("port", 0)
            if host and port:
                server = f"{host}:{port}"
        if server:
            proxy_dict["server"] = server
        username = proxy_source.get("username")
        if username:
            proxy_dict["username"] = username
        password = proxy_source.get("password")
        if password:
            proxy_dict["password"] = password
        if proxy_dict:
            result["proxy"] = proxy_dict

    # --- 8. Headless ---
    headless = options.get("headless")
    if headless is not None:
        result["headless"] = bool(headless)
    else:
        result["headless"] = False  # headed by default (matches camoufox default)

    # --- 9. Virtual display ---
    display = options.get("display")
    if display:
        result["virtual_display"] = display

    # --- 10. Firefox user preferences ---
    prefs = launch_profile.get("firefox_user_prefs") or persona.get("firefoxUserPrefs")
    if prefs and isinstance(prefs, dict):
        # Merge with any existing prefs from the config
        existing_prefs = result.get("firefox_user_prefs", {})
        existing_prefs.update(prefs)
        result["firefox_user_prefs"] = existing_prefs

    # --- 11. Executable path (browser version) ---
    exec_path = options.get("executable_path") or launch_profile.get("executable_path")
    if exec_path:
        resolved = resolve_browser_version(str(exec_path))
        if resolved:
            result["executable_path"] = resolved
        else:
            result["executable_path"] = str(exec_path)

    # Also try active version from config
    if "executable_path" not in result:
        active_ver = read_active_version_from_config()
        if active_ver:
            resolved = resolve_browser_version(active_ver)
            if resolved:
                result["executable_path"] = resolved

    # --- 12. Firefox version pinning ---
    ff_version = options.get("ff_version") or launch_profile.get("ff_version")
    if ff_version:
        result["ff_version"] = int(ff_version)

    # --- 13. Additional camoufox options ---
    for key in ("block_images", "block_webrtc", "block_webgl", "disable_coop",
                "geoip", "humanize", "addons", "fonts", "custom_fonts_only",
                "exclude_addons", "enable_cache", "debug", "main_world_eval",
                "webgl_config", "args", "env", "i_know_what_im_doing"):
        val = options.get(key) or launch_profile.get(key)
        if val is not None:
            result[key] = val

    return result


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _dict_to_fingerprint(fp_dict: dict) -> Any | None:
    """Reconstruct a ``browserforge.fingerprints.Fingerprint`` from a dict.

    Parameters
    ----------
    fp_dict : dict
        A serialised fingerprint dict with keys ``screen``, ``navigator``,
        ``headers``, ``videoCodecs``, ``audioCodecs``, ``pluginsData``,
        ``battery``, ``videoCard``, ``multimediaDevices``, ``fonts``,
        ``mockWebRTC``, and ``slim``.

    Returns
    -------
    browserforge.fingerprints.Fingerprint or None
        The reconstructed object, or ``None`` if the import fails or the
        dict is missing required fields.
    """
    if not isinstance(fp_dict, dict):
        return None

    try:
        from browserforge.fingerprints import Fingerprint

        # browserforge's Fingerprint constructor expects keyword arguments
        # matching its dataclass fields.
        return Fingerprint(
            screen=fp_dict.get("screen"),
            navigator=fp_dict.get("navigator"),
            headers=fp_dict.get("headers"),
            videoCodecs=fp_dict.get("videoCodecs"),
            audioCodecs=fp_dict.get("audioCodecs"),
            pluginsData=fp_dict.get("pluginsData"),
            battery=fp_dict.get("battery"),
            videoCard=fp_dict.get("videoCard"),
            multimediaDevices=fp_dict.get("multimediaDevices"),
            fonts=fp_dict.get("fonts"),
            mockWebRTC=fp_dict.get("mockWebRTC"),
            slim=fp_dict.get("slim"),
        )
    except ImportError:
        log.warning("browserforge not available; cannot reconstruct fingerprint")
        return None
    except Exception as exc:
        log.warning("Failed to reconstruct fingerprint from dict: %s", exc)
        return None
