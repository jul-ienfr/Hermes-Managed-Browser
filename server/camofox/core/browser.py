"""Browser lifecycle management — ensure, launch, close browsers.

Mirrors the Node.js ensureBrowser(), launchBrowserInstance(), idle shutdown
logic from server.js.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from camoufox.async_api import AsyncCamoufox
from camoufox import launch_options
from camoufox.virtdisplay import VirtualDisplay
from browserforge.fingerprints import Screen

from camofox.core.config import config
from camofox.core.engines import (
    CAMOUFOX_PYTHON,
    CLOAKBROWSER,
    normalize_engine,
    make_browser_key,
)
from camofox.core.metrics import browser_restarts_total, browser_instance_count
from camofox.core.plugins import plugin_events
from camofox.core.utils import (
    coalesce_inflight,
    normalize_user_id,
    resolve_profile_root,
)

log = logging.getLogger("camofox.browser")

# ---------------------------------------------------------------------------
# BrowserEntry — per-browser-instance state
# ---------------------------------------------------------------------------


@dataclass
class BrowserEntry:
    """State for one launched browser instance."""

    key: str
    engine: str = CAMOUFOX_PYTHON
    browser: Optional[Any] = None  # Playwright Browser
    profile_dir: Optional[str] = None
    executable_path: Optional[str] = None
    launch_promise: Optional[asyncio.Task] = None
    launch_proxy: Optional[dict] = None
    display: Optional[str] = None  # X11 DISPLAY
    persona: Optional[dict] = None  # launch profile persona
    virtual_display: Optional[Any] = None
    last_used: float = field(default_factory=time.time)
    launch_attempts: int = 0

    # Internal engine resources we must close on shutdown.
    _camoufox: Optional[Any] = None
    _playwright: Optional[Any] = None


# Global browser registry keyed by engine:userId (string).
browser_entries: dict[str, BrowserEntry] = {}

# Inflight launch tracking for deduplication.
_inflight_launches: dict[str, asyncio.Task] = {}

# Idle shutdown timers keyed by userId.
_idle_timers: dict[str, asyncio.TimerHandle] = {}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_browser_entry(user_id: str, engine: str | None = None) -> BrowserEntry:
    """Return the BrowserEntry for *user_id* and *engine*, creating one if absent."""
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    key = make_browser_key(normalized_engine, uid)
    if key not in browser_entries:
        browser_entries[key] = BrowserEntry(key=key, engine=normalized_engine)
    return browser_entries[key]


def _log(level: str, msg: str, **fields) -> None:
    """Structured logging matching Node.js log('info', 'msg', {k: v}) style."""
    getattr(log, level)(msg, extra={"fields": fields})


async def _check_browser_connected(entry: BrowserEntry) -> bool:
    """Quick connectivity check: try to get browser version."""
    browser = entry.browser
    if browser is None:
        return False
    try:
        version_str = browser.version
        return bool(version_str)
    except Exception:
        return False


async def _kill_virtual_display(entry: BrowserEntry) -> None:
    """Safely kill a VirtualDisplay if present."""
    vd = entry.virtual_display
    if vd is not None:
        try:
            vd.kill()
        except Exception:
            pass
        entry.virtual_display = None


async def _close_browser_inner(entry: BrowserEntry) -> None:
    """Low-level browser close + AsyncCamoufox teardown (no registry side-effects)."""
    browser = entry.browser
    if browser is not None:
        try:
            await asyncio.wait_for(browser.close(), timeout=10.0)
        except asyncio.TimeoutError:
            _log("warning", "browser close timed out, forcing", key=entry.key)
        except Exception:
            pass
        entry.browser = None

    # Tear down the AsyncCamoufox instance (closes the Playwright session)
    ac = getattr(entry, "_camoufox", None)
    if ac is not None:
        try:
            ac.browser = None  # prevent double-close in __aexit__
            await ac.__aexit__(None, None, None)
        except Exception:
            pass
        entry._camoufox = None

    pw = getattr(entry, "_playwright", None)
    if pw is not None:
        try:
            await pw.stop()
        except Exception:
            pass
        entry._playwright = None

    await _kill_virtual_display(entry)


# ---------------------------------------------------------------------------
# ensure_browser
# ---------------------------------------------------------------------------


async def ensure_browser(
    user_id: str = "default",
    profile_dir: str | None = None,
    engine: str | None = None,
) -> dict:
    """Return a usable browser + metadata for *user_id*.

    Checks existing entry first, validates connectivity, and relaunches
    if the browser is disconnected.  Concurrent calls for the same userId
    are coalesced (inflight de-duplication).

    Returns dict with keys: ``browser``, ``launch_proxy``, ``persona``,
    ``display``.
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)

    async def _do_ensure():
        entry = get_browser_entry(uid, normalized_engine)

        # If we already have a browser, quick-check connectivity
        if entry.browser is not None:
            connected = await _check_browser_connected(entry)
            if connected:
                entry.last_used = time.time()
                clear_browser_idle_timer(uid, normalized_engine)
                return _entry_to_result(entry)
            else:
                _log(
                    "warn",
                    "browser disconnected — relaunching",
                    key=browser_key,
                    profile_dir=profile_dir,
                )
                browser_restarts_total.labels(reason="disconnect").inc()
                await _close_browser_inner(entry)

        # Launch with configurable timeout
        try:
            result = await asyncio.wait_for(
                launch_browser_instance(uid, profile_dir=profile_dir, engine=normalized_engine),
                timeout=60.0,
            )
            return result
        except asyncio.TimeoutError:
            _log("error", "ensure_browser timed out after 60s", key=browser_key)
            raise RuntimeError(f"Browser launch timed out for user {uid}")
        except Exception:
            _log("error", "ensure_browser failed", key=browser_key)
            raise

    return await coalesce_inflight(_inflight_launches, browser_key, _do_ensure)


def _entry_to_result(entry: BrowserEntry) -> dict:
    return {
        "browser": entry.browser,
        "launch_proxy": entry.launch_proxy,
        "persona": entry.persona,
        "display": entry.display,
        "engine": entry.engine,
        "profile_dir": entry.profile_dir,
        "executable_path": entry.executable_path,
    }


# ---------------------------------------------------------------------------
# launch_browser_instance  (core launch with retry)
# ---------------------------------------------------------------------------
# NOTE: We do NOT use `async with AsyncCamoufox(...)` here because that
# context manager closes the browser on exit.  Instead we drive the
# __aenter__ / __aexit__ lifecycle manually and store the instance on the
# entry so it can be torn down later.


async def launch_browser_instance(
    user_id: str,
    profile_dir: str | None = None,
    engine: str | None = None,
) -> dict:
    """Core launch logic with retry.

    Tries ``CAMOUFOX_LAUNCH_RETRIES`` times (default 3).  Each iteration:
      1. Obtain a proxy from the proxy pool (if available).
      2. Build the Camoufox launch profile from persona / persisted profile.
      3. Set up Xvfb virtual display when required.
      4. Launch AsyncCamoufox.
      5. Record display metadata and attach cleanup handlers.

    On failure: close browser, kill virtual display, rotate proxy, retry.
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)
    retries = int(os.environ.get("CAMOUFOX_LAUNCH_RETRIES", "3"))

    entry = get_browser_entry(uid, normalized_engine)
    entry.key = browser_key
    entry.engine = normalized_engine
    entry.launch_attempts = 0

    # Resolve profile path
    default_profile_dir = config.cloakbrowser_profile_dir if normalized_engine == CLOAKBROWSER else config.profile_dir
    env_profile_dir = os.environ.get("CLOAK_BROWSER_PROFILE_DIR") if normalized_engine == CLOAKBROWSER else os.environ.get("CAMOFOX_PROFILE_DIR")
    resolved_profile = resolve_profile_root(profile_dir or env_profile_dir or default_profile_dir)

    if not resolved_profile:
        resolved_profile = resolve_profile_root(default_profile_dir)

    last_exc: Exception | None = None

    for attempt in range(1, retries + 1):
        entry.launch_attempts = attempt
        proxy_for_launch: dict | None = None
        vd: Any = None
        display_str: str | None = None
        ac: Any = None
        browser_obj: Any = None

        try:
            # ---- 1. Proxy resolution ---------------------------------
            proxy_for_launch = await _resolve_proxy(uid, attempt)

            # ---- 2. Build persona / launch profile ------------------
            persona = _build_persona(uid)

            # ---- 3. Virtual display resolution ----------------------
            needs_vd, display_str = _resolve_display(uid, persona)
            if needs_vd:
                vd = VirtualDisplay()
                display_str = vd.get()
                entry.virtual_display = vd
                if display_str:
                    os.environ["DISPLAY"] = display_str
                _log("info", "virtual display started", key=browser_key, display=display_str)

            _log(
                "info",
                "launching browser",
                key=browser_key,
                engine=normalized_engine,
                attempt=attempt,
                retries=retries,
                profile=resolved_profile,
                proxy=proxy_for_launch,
                display=display_str,
            )

            if normalized_engine == CAMOUFOX_PYTHON:
                launch_opts = _build_camoufox_launch_options(
                    uid=uid,
                    persona=persona,
                    proxy=proxy_for_launch,
                    display=display_str,
                    profile_dir=resolved_profile,
                )
                ac = AsyncCamoufox(**launch_opts)
                browser_obj = await ac.__aenter__()
            elif normalized_engine == CLOAKBROWSER:
                browser_obj = await _launch_cloak_browser(
                    proxy=proxy_for_launch,
                    display=display_str,
                    persona=persona,
                )
                # cloakbrowser patches browser.close() internally — no _playwright to track
            else:
                raise RuntimeError(f"Engine {normalized_engine} is not implemented in the Python server")

            # Verify the browser is alive
            try:
                version_str = browser_obj.version
                if not version_str:
                    raise RuntimeError("Browser returned empty version string")
            except Exception as exc:
                raise RuntimeError(
                    f"Browser version check failed: {exc}"
                ) from exc

            # ---- 6. Record state ---------------------------------
            entry.browser = browser_obj
            entry._camoufox = ac
            entry.profile_dir = resolved_profile
            entry.executable_path = config.cloakbrowser_executable_path if normalized_engine == CLOAKBROWSER else os.environ.get("CAMOFOX_EXECUTABLE_PATH")
            entry.launch_proxy = proxy_for_launch
            entry.display = display_str
            entry.persona = persona
            entry.last_used = time.time()
            browser_instance_count.inc()

            _log(
                "info",
                "browser launched",
                key=browser_key,
                attempt=attempt,
                display=display_str,
            )
            plugin_events.emit("browser:launched", user_id=uid, entry=entry)

            clear_browser_idle_timer(uid, normalized_engine)
            schedule_browser_idle_shutdown(uid, normalized_engine)

            return _entry_to_result(entry)

        except Exception as exc:
            last_exc = exc
            _log(
                "warn",
                "browser launch attempt failed",
                key=browser_key,
                attempt=attempt,
                error=str(exc),
            )

            # Clean up on failure
            if ac is not None:
                try:
                    ac.browser = None  # prevent double-close
                    await ac.__aexit__(None, None, None)
                except Exception:
                    pass
            elif browser_obj is not None:
                try:
                    await asyncio.wait_for(browser_obj.close(), timeout=5.0)
                except Exception:
                    pass
            if entry._playwright is not None:
                try:
                    await entry._playwright.stop()
                except Exception:
                    pass
                entry._playwright = None

            if vd is not None:
                try:
                    vd.kill()
                except Exception:
                    pass
            entry.browser = None
            entry._camoufox = None
            entry.virtual_display = None
            entry.display = None

            # If this was not the last attempt, yield briefly before retry
            if attempt < retries:
                await asyncio.sleep(1.0)

    # All retries exhausted
    entry.launch_attempts = 0
    error_msg = f"Browser launch failed for user {uid} after {retries} attempts"
    if last_exc is not None:
        error_msg += f": {last_exc}"
    _log("error", error_msg, key=browser_key)
    browser_restarts_total.labels(reason="launch_failed").inc()
    raise RuntimeError(error_msg)


# ---------------------------------------------------------------------------
# Proxy helper
# ---------------------------------------------------------------------------

_proxy_pool_instance: Any = None


async def _resolve_proxy(user_id: str, attempt: int) -> dict | None:
    """Obtain a launch proxy from the proxy pool, if available."""
    global _proxy_pool_instance

    # Lazy import to avoid circular dependency at module level
    if _proxy_pool_instance is None:
        try:
            from camofox.core.proxy_pool import proxy_pool as _proxy_pool_instance
        except ImportError:
            _proxy_pool_instance = False  # sentinel

    if _proxy_pool_instance and _proxy_pool_instance is not False:
        try:
            return await _proxy_pool_instance.get_launch_proxy()
        except Exception:
            _log("warn", "failed to get launch proxy", key=user_id, attempt=attempt)

    return None


# ---------------------------------------------------------------------------
# Persona / display helpers
# ---------------------------------------------------------------------------


def _build_persona(user_id: str) -> dict:
    """Build the persona dict for a user.

    This can be extended later to load from a database or configurable
    persona profiles.  For now returns the userId as a basic persona.
    """
    return {"userId": user_id}


def _resolve_display(user_id: str, persona: dict) -> tuple[bool, str | None]:
    """Decide whether a virtual display is needed and what DISPLAY to use.

    Returns (needs_virtual_display, display_string_or_None).
    """
    # Check for shared display
    if config.shared_display:
        # If shared_display_user_ids is specified, only those users share
        if config.shared_display_user_ids:
            if user_id in config.shared_display_user_ids:
                return False, config.shared_display
        else:
            # No restriction — everyone uses the shared display
            return False, config.shared_display

    # Check if a DISPLAY is already set (e.g., running in a desktop env)
    existing_display = os.environ.get("DISPLAY")
    if existing_display:
        return False, existing_display

    # macOS / Windows — no virtual display support
    import sys
    if sys.platform != "linux":
        return False, None

    # Default: launch a virtual display
    return True, None


# ---------------------------------------------------------------------------
# Launch options builder
# ---------------------------------------------------------------------------


def _build_camoufox_launch_options(
    uid: str,
    persona: dict,
    proxy: dict | None,
    display: str | None,
    profile_dir: str | None,
) -> dict:
    """Assemble the keyword arguments passed to launch_options()."""
    opts: dict[str, Any] = {}

    # --- Proxy ---
    if proxy:
        proxy_dict: dict[str, str] = {}
        if proxy.get("host"):
            proxy_dict["server"] = f"{proxy['host']}:{proxy.get('port', 0)}"
        if proxy.get("username"):
            proxy_dict["username"] = proxy["username"]
        if proxy.get("password"):
            proxy_dict["password"] = proxy["password"]
        if proxy_dict:
            opts["proxy"] = proxy_dict

    # --- Display / headless ---
    if display:
        # Verify the display is actually available before going headed
        import subprocess
        has_display = False
        try:
            result = subprocess.run(
                ["xdpyinfo", "-display", display],
                capture_output=True, timeout=3,
            )
            has_display = result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass

        if has_display:
            opts["headless"] = False
            opts["virtual_display"] = display
        else:
            log.warning("shared display %s not available, falling back to headless", display)
            opts["headless"] = True
    else:
        opts["headless"] = True

    # --- Profile directory ---
    # Note: Playwright persistent context support (profile_dir) is not yet wired.
    # Camoufox temp profiles are used by default.

    # --- Screen resolution ---
    screen_resolution = os.environ.get("CAMOFOX_SCREEN", "1920x1080")
    try:
        width_s, height_s = screen_resolution.split("x")
        width, height = int(width_s), int(height_s)
        opts["screen"] = Screen(
            min_width=width, max_width=width,
            min_height=height, max_height=height,
        )
        opts["window"] = (width, height)
    except (ValueError, AttributeError):
        opts["screen"] = Screen(
            min_width=1920, max_width=1920,
            min_height=1080, max_height=1080,
        )
        opts["window"] = (1920, 1080)

    # --- Locale ---
    locale_val = os.environ.get("CAMOFOX_LOCALE")
    if locale_val:
        opts["locale"] = locale_val

    # --- Timezone ---
    tz = os.environ.get("CAMOFOX_TIMEZONE")
    if tz:
        opts["timezoneId"] = tz

    # --- Geolocation ---
    geoip = os.environ.get("CAMOFOX_GEOIP", "").lower()
    if geoip in ("1", "true"):
        opts["geoip"] = True
    elif geoip:
        opts["geoip"] = geoip

    # --- Humanization ---
    humanize = os.environ.get("CAMOFOX_HUMANIZE", "").lower()
    if humanize in ("1", "true"):
        opts["humanize"] = True
    elif humanize:
        try:
            opts["humanize"] = float(humanize)
        except ValueError:
            opts["humanize"] = True

    # --- Firefox preferences ---
    firefox_prefs: dict[str, Any] = {}
    if os.environ.get("CAMOFOX_DISABLE_WEBGL", "0") == "1":
        firefox_prefs["webgl.disabled"] = True

    # Disable coop for cross-origin iframe interactions (Turnstile etc.)
    if os.environ.get("CAMOFOX_DISABLE_COOP", "0") == "1":
        firefox_prefs["dom.postMessage.sharedArrayBuffer.withCrossOriginIframes"] = False
        firefox_prefs["browser.tabs.remote.useCrossOriginOpenerPolicy"] = False

    if firefox_prefs:
        opts["firefox_user_prefs"] = firefox_prefs

    # --- Block resources ---
    if os.environ.get("CAMOFOX_BLOCK_IMAGES", "0") == "1":
        opts["block_images"] = True
    if os.environ.get("CAMOFOX_BLOCK_WEBRTC", "0") == "1":
        opts["block_webrtc"] = True

    # --- Executable path ---
    exe_path = os.environ.get("CAMOFOX_EXECUTABLE_PATH")
    if exe_path:
        opts["executable_path"] = exe_path

    # --- Debug ---
    if os.environ.get("CAMOFOX_DEBUG", "0") in ("1", "true"):
        opts["debug"] = True

    # Pass everything through launch_options() which returns Playwright args
    return launch_options(**opts)


async def _launch_cloak_browser(
    proxy: dict | None,
    display: str | None,
    persona: dict | None = None,
) -> Any:
    """Launch CloakBrowser via the ``cloakbrowser`` package.

    ``cloakbrowser.launch_async`` manages its own Playwright session and
    patches ``browser.close()`` to also stop the Playwright instance, so
    callers do NOT need to track a separate ``_playwright`` handle.
    """
    if not config.cloakbrowser_enabled:
        raise RuntimeError("CloakBrowser engine is disabled. Set CLOAK_BROWSER_ENABLED=1.")

    from cloakbrowser import launch_async, ensure_binary

    # Ensure the binary is downloaded before launching
    ensure_binary()

    # Map proxy to the format CloakBrowser / Playwright expects
    proxy_arg: str | dict | None = None
    if proxy and proxy.get("host"):
        server = f"{proxy['host']}:{proxy.get('port', 0)}"
        if proxy.get("username"):
            proxy_arg = {
                "server": server,
                "username": proxy["username"],
                "password": proxy.get("password", ""),
            }
        else:
            proxy_arg = server

    # Verify the display is actually available before going headed
    headless = True
    if display:
        import subprocess as _subprocess

        try:
            _result = _subprocess.run(
                ["xdpyinfo", "-display", display],
                capture_output=True, timeout=3,
            )
            headless = _result.returncode != 0
        except (FileNotFoundError, _subprocess.TimeoutExpired, OSError):
            headless = True

    kwargs: dict[str, Any] = {
        "headless": headless,
        "proxy": proxy_arg,
        "humanize": True,
        "args": [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
        ],
    }

    # Pass persona / env values through to CloakBrowser
    tz = os.environ.get("CAMOFOX_TIMEZONE")
    if tz:
        kwargs["timezone"] = tz
    locale_val = os.environ.get("CAMOFOX_LOCALE")
    if locale_val:
        kwargs["locale"] = locale_val
    geoip = os.environ.get("CAMOFOX_GEOIP", "").lower()
    if geoip in ("1", "true"):
        kwargs["geoip"] = True

    return await launch_async(**kwargs)


# ---------------------------------------------------------------------------
# close_browser
# ---------------------------------------------------------------------------


async def close_browser(
    user_id: str,
    entry: BrowserEntry | None = None,
    engine: str | None = None,
) -> None:
    """Close the browser for *user_id* and clean up all associated resources."""
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or (entry.engine if entry else config.default_engine))
    browser_key = make_browser_key(normalized_engine, uid)

    if entry is None:
        entry = browser_entries.get(browser_key)
        if entry is None:
            return

    _log("info", "closing browser", key=browser_key)

    clear_browser_idle_timer(uid, normalized_engine)

    await _close_browser_inner(entry)

    # Remove from registry
    if browser_entries.get(browser_key) is entry:
        del browser_entries[browser_key]

    browser_instance_count.dec()
    plugin_events.emit("browser:closed", user_id=uid, entry=entry)

    _log("info", "browser closed", key=browser_key)


# ---------------------------------------------------------------------------
# close_all_browsers
# ---------------------------------------------------------------------------


async def close_all_browsers() -> None:
    """Close every tracked browser instance."""
    keys = list(browser_entries.keys())
    if not keys:
        return
    _log("info", "closing all browsers", count=len(keys))

    for key in keys:
        entry = browser_entries.get(key)
        if entry is not None:
            clear_browser_idle_timer(entry.key, entry.engine)
            await _close_browser_inner(entry)

    browser_entries.clear()
    _idle_timers.clear()
    browser_instance_count.set(0)
    _log("info", "all browsers closed")


# ---------------------------------------------------------------------------
# Idle shutdown
# ---------------------------------------------------------------------------


def schedule_browser_idle_shutdown(user_id: str, engine: str | None = None) -> None:
    """After ``config.browser_idle_timeout_ms`` of inactivity, close browser.

    Idle timer is reset every time the browser is touched (see ensure_browser
    and clear_browser_idle_timer).
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)
    timeout_s = config.browser_idle_timeout_ms / 1000.0

    if timeout_s <= 0:
        return

    async def _do_shutdown():
        entry = browser_entries.get(browser_key)
        if entry is None:
            return
        # Double-check: has the browser been used recently?
        idle_for = time.time() - entry.last_used
        if idle_for >= timeout_s:
            _log(
                "info",
                "idle shutdown triggered",
                key=browser_key,
                idle_seconds=round(idle_for, 1),
                timeout_seconds=timeout_s,
            )
            await close_browser(uid, entry=entry)
        else:
            # Browser was touched since this timer was scheduled — reschedule
            schedule_browser_idle_shutdown(uid, normalized_engine)

    loop = asyncio.get_event_loop()
    timer = loop.call_later(timeout_s, lambda: asyncio.ensure_future(_do_shutdown()))
    _idle_timers[browser_key] = timer


def clear_browser_idle_timer(user_id: str, engine: str | None = None) -> None:
    """Cancel the idle shutdown timer for *user_id*, if any."""
    uid = normalize_user_id(user_id)
    browser_key = user_id if ":" in user_id else make_browser_key(engine or config.default_engine, uid)
    timer = _idle_timers.pop(browser_key, None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Browser health check
# ---------------------------------------------------------------------------


async def check_browser_health(user_id: str, engine: str | None = None) -> dict:
    """Check the health of a browser instance.

    Returns dict with keys:
        alive (bool)
        has_session (bool)
        profile_dir (str | None)
        up_since (float | None)  — epoch seconds
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)
    entry = browser_entries.get(browser_key)
    if entry is None:
        return {
            "alive": False,
            "has_session": False,
            "profile_dir": None,
            "up_since": None,
            "engine": normalized_engine,
        }

    browser = entry.browser
    alive = False
    try:
        if browser is not None:
            version_str = browser.version
            alive = bool(version_str)
    except Exception:
        alive = False

    # If the browser is dead, clean up
    if not alive and entry.browser is not None:
        _log("warn", "health check detected dead browser", key=browser_key)
        browser_restarts_total.labels(reason="health_check").inc()
        await _close_browser_inner(entry)
        browser_instance_count.dec()

    return {
        "alive": alive,
        "has_session": entry.browser is not None,
        "profile_dir": entry.profile_dir,
        "up_since": entry.last_used if alive else None,
        "engine": entry.engine,
        "executable_path": entry.executable_path,
    }
