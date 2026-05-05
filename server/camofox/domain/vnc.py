"""VNC display management — x11vnc + noVNC launcher and display registry.

Mirrors several Node.js modules:
- ``plugins/vnc/vnc-launcher.js`` — launching x11vnc + noVNC
- ``lib/vnc-display-registry.js`` — tracking which userId → which display
- ``lib/vnc-geometry-doctor.js`` — validate X11 window geometry
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("camofox.vnc")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DISPLAY_REGISTRY_PATH = Path.home() / ".camofox" / "vnc-display-registry.json"

# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------


def resolve_vnc_config(plugin_config: dict | None = None) -> dict:
    """Resolve VNC configuration from environment variables with plugin config
    fallback.

    Resolution order: environment variables first, then *plugin_config* dict,
    then built-in defaults.

    Parameters
    ----------
    plugin_config : dict or None
        Optional plugin-level config (e.g. from ``Config.load().vnc``
        serialised to a dict).

    Returns
    -------
    dict
        A dictionary with the following keys:

        .. code-block:: python

            {
                "enabled": bool,          # default False
                "resolution": str,        # "1920x1080x24" (default)
                "vnc_password": str | None,
                "view_only": bool,        # default True
                "vnc_port": int,          # default 5901
                "novnc_port": int,        # default 6081
                "bind": str,              # default "127.0.0.1"
                "human_only": bool,       # default True
                "managed_registry_only": bool,  # default False
                "display_registry": str,  # defaults to DISPLAY_REGISTRY_PATH
                "display_selection": str,       # from env or ""
            }

    Notes
    -----
    Resolution parsing:

    - ``"1920x1080"`` → ``"1920x1080x24"`` (appends ``x24`` depth when only
      one ``x`` is present)
    - ``"1920x1080x24"`` → as-is
    """
    pc = plugin_config or {}

    # --- Environment variables ---
    env_enabled = os.environ.get("ENABLE_VNC")
    env_resolution = os.environ.get("VNC_RESOLUTION")
    env_password = os.environ.get("VNC_PASSWORD")
    env_view_only = os.environ.get("VNC_VIEW_ONLY")
    env_vnc_port = os.environ.get("VNC_PORT")
    env_novnc_port = os.environ.get("NOVNC_PORT")
    env_bind = os.environ.get("VNC_BIND")
    env_human_only = os.environ.get("VNC_HUMAN_ONLY")
    env_managed_only = os.environ.get("VNC_MANAGED_REGISTRY_ONLY")
    env_display_selection = os.environ.get("VNC_DISPLAY_SELECTION")

    # --- Resolve enabled ---
    if env_enabled is not None:
        enabled = env_enabled.strip() in ("1", "true", "True", "yes")
    else:
        enabled = bool(pc.get("enabled", False))

    # --- Resolve resolution ---
    raw_resolution: str = (
        env_resolution
        or str(pc.get("resolution", "1920x1080"))
    )
    resolution = _normalise_resolution(raw_resolution)

    # --- Resolve password ---
    vnc_password: str | None = env_password or pc.get("vnc_password")

    # --- Resolve view_only ---
    if env_view_only is not None:
        view_only = env_view_only.strip() in ("1", "true", "True", "yes")
    else:
        view_only = bool(pc.get("view_only", True))

    # --- Resolve vnc_port ---
    if env_vnc_port is not None:
        vnc_port = int(env_vnc_port.strip())
    else:
        vnc_port = int(pc.get("vnc_port", 5901))

    # --- Resolve novnc_port ---
    if env_novnc_port is not None:
        novnc_port = int(env_novnc_port.strip())
    else:
        novnc_port = int(pc.get("novnc_port", 6081))

    # --- Resolve bind ---
    bind: str = env_bind or str(pc.get("bind", "127.0.0.1"))

    # --- Resolve human_only ---
    if env_human_only is not None:
        human_only = env_human_only.strip() in ("1", "true", "True", "yes")
    else:
        human_only = bool(pc.get("human_only", True))

    # --- Resolve managed_registry_only ---
    if env_managed_only is not None:
        managed_registry_only = env_managed_only.strip() in ("1", "true", "True", "yes")
    else:
        managed_registry_only = bool(pc.get("managed_registry_only", False))

    # --- Resolve display_selection ---
    display_selection: str = env_display_selection or str(pc.get("display_selection", ""))

    return {
        "enabled": enabled,
        "resolution": resolution,
        "vnc_password": vnc_password,
        "view_only": view_only,
        "vnc_port": vnc_port,
        "novnc_port": novnc_port,
        "bind": bind,
        "human_only": human_only,
        "managed_registry_only": managed_registry_only,
        "display_registry": str(DISPLAY_REGISTRY_PATH),
        "display_selection": display_selection,
    }


def _normalise_resolution(resolution: str) -> str:
    """Normalise a resolution string to ``WxHxD`` (``WxHx24``) format.

    - ``"1920x1080"`` → ``"1920x1080x24"``
    - ``"1920x1080x24"`` → as-is
    - ``"1920x1080x16"`` → as-is (non‑24 depth preserved)
    """
    parts = resolution.strip().split("x")
    if len(parts) == 2:
        # No colour depth — append default 24
        return f"{parts[0]}x{parts[1]}x24"
    # Already has depth or malformed — return as-is
    return resolution.strip()


# ---------------------------------------------------------------------------
# Display registry — JSON file on disk
# ---------------------------------------------------------------------------


def _ensure_registry_dir() -> None:
    """Create the parent directory for the display registry if needed."""
    DISPLAY_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)


def read_display_registry() -> dict:
    """Read the full display registry from disk.

    Returns
    -------
    dict
        A mapping of ``userId`` → display info dict (or empty dict if the
        registry file does not exist or is corrupt).

    The shape of each entry:

    .. code-block:: python

        {
            "userId": {
                "display": str,         # e.g. ":99"
                "resolution": str,      # e.g. "1920x1080x24"
                "profile_window_size": { "width": int, "height": int } | None,
            }
        }
    """
    if not DISPLAY_REGISTRY_PATH.is_file():
        return {}

    try:
        data = json.loads(DISPLAY_REGISTRY_PATH.read_text())
        if isinstance(data, dict):
            return data
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Failed to read VNC display registry: %s", exc)
        return {}


def _write_display_registry(registry: dict) -> None:
    """Atomically write the display registry to disk."""
    _ensure_registry_dir()
    tmp = DISPLAY_REGISTRY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(registry, indent=2))
    tmp.rename(DISPLAY_REGISTRY_PATH)


def record_vnc_display(
    user_id: str,
    display: str,
    resolution: str,
    profile_window_size: dict | None = None,
) -> None:
    """Record a VNC display assignment in the registry JSON file.

    Parameters
    ----------
    user_id : str
        The user identifier (e.g. ``"leboncoin-cim"``).
    display : str
        The X11 display string (e.g. ``":99"``).
    resolution : str
        The screen resolution (e.g. ``"1920x1080x24"``).
    profile_window_size : dict or None
        Optional window size override, e.g. ``{"width": 1920, "height": 1080}``.
    """
    registry = read_display_registry()
    entry: dict[str, Any] = {
        "display": display,
        "resolution": resolution,
    }
    if profile_window_size is not None:
        entry["profile_window_size"] = profile_window_size

    registry[str(user_id)] = entry
    _write_display_registry(registry)
    log.debug(
        "Recorded VNC display for user=%s display=%s resolution=%s",
        user_id, display, resolution,
    )


def remove_vnc_display(user_id: str) -> None:
    """Remove a VNC display assignment from the registry.

    Parameters
    ----------
    user_id : str
        The user identifier to remove.
    """
    registry = read_display_registry()
    removed = registry.pop(str(user_id), None)
    if removed is not None:
        _write_display_registry(registry)
        log.debug("Removed VNC display for user=%s", user_id)
    else:
        log.debug("No VNC display entry found for user=%s", user_id)


# ---------------------------------------------------------------------------
# Display selection scheme file
# ---------------------------------------------------------------------------


def read_selected_vnc_user_id(
    display_selection_scheme: str | None = None,
) -> str | None:
    """Read the currently selected VNC user ID from a scheme file.

    The scheme file is a simple text file containing the ``userId`` that
    should have its VNC display forwarded.  This is used by external tools
    (e.g. a desktop app) to signal *which* user's VNC stream is currently
    being viewed.

    Parameters
    ----------
    display_selection_scheme : str or None
        Path to the scheme file (a text file with one line — the user ID).
        If ``None``, reads from the environment variable
        ``VNC_DISPLAY_SELECTION`` or the default location
        ``~/.camofox/vnc-display-selection.txt``.

    Returns
    -------
    str or None
        The selected user ID, or ``None`` if the file does not exist or is
        empty.
    """
    path_str: str
    if display_selection_scheme:
        path_str = display_selection_scheme
    else:
        path_str = os.environ.get(
            "VNC_DISPLAY_SELECTION",
            str(Path.home() / ".camofox" / "vnc-display-selection.txt"),
        )

    scheme_path = Path(path_str)
    if not scheme_path.is_file():
        return None

    try:
        content = scheme_path.read_text().strip()
        return content if content else None
    except OSError as exc:
        log.warning("Failed to read VNC display selection file: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Geometry validation
# ---------------------------------------------------------------------------


def validate_vnc_geometry(
    display: str,
    expected_width: int,
    expected_height: int,
) -> dict:
    """Validate VNC X11 window geometry using ``xdotool``.

    Queries the currently active window on the given *display* and compares
    its dimensions against *expected_width* × *expected_height*.

    Parameters
    ----------
    display : str
        The X11 display string (e.g. ``":99"``).
    expected_width : int
        Expected window width in pixels.
    expected_height : int
        Expected window height in pixels.

    Returns
    -------
    dict
        Shape:

        .. code-block:: python

            {
                "valid": bool,
                "actual": {"width": int, "height": int} | None,
                "error": str | None,
            }
    """
    if not shutil.which("xdotool"):
        return {
            "valid": False,
            "actual": None,
            "error": "xdotool not found on this system",
        }

    env = {**os.environ, "DISPLAY": display}

    try:
        result = subprocess.run(
            ["xdotool", "getactivewindow", "getwindowgeometry", "--shell"],
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
        )
    except FileNotFoundError:
        return {
            "valid": False,
            "actual": None,
            "error": "xdotool not found on this system",
        }
    except subprocess.TimeoutExpired:
        return {
            "valid": False,
            "actual": None,
            "error": "xdotool timed out (10s)",
        }
    except OSError as exc:
        return {
            "valid": False,
            "actual": None,
            "error": f"xdotool execution error: {exc}",
        }

    if result.returncode != 0:
        return {
            "valid": False,
            "actual": None,
            "error": f"xdotool returned exit code {result.returncode}: "
                      f"{result.stderr.strip()}",
        }

    # Parse output like:
    #   WINDOW=12345678
    #   X=0
    #   Y=0
    #   WIDTH=1920
    #   HEIGHT=1080
    actual_width: int | None = None
    actual_height: int | None = None
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("WIDTH="):
            try:
                actual_width = int(line.split("=", 1)[1])
            except (ValueError, IndexError):
                pass
        elif line.startswith("HEIGHT="):
            try:
                actual_height = int(line.split("=", 1)[1])
            except (ValueError, IndexError):
                pass

    if actual_width is None or actual_height is None:
        return {
            "valid": False,
            "actual": None,
            "error": "Could not parse WIDTH/HEIGHT from xdotool output: "
                      f"{result.stdout.strip()[:200]}",
        }

    is_valid = actual_width == expected_width and actual_height == expected_height
    return {
        "valid": is_valid,
        "actual": {"width": actual_width, "height": actual_height},
        "error": None if is_valid else (
            f"Expected {expected_width}x{expected_height}, "
            f"got {actual_width}x{actual_height}"
        ),
    }


# ---------------------------------------------------------------------------
# VNC watcher launcher
# ---------------------------------------------------------------------------


def _parse_display_number(display: str) -> int | None:
    """Extract the display number from an X11 display string.

    Examples
    --------
    - ``":99"`` → ``99``
    - ``":0"`` → ``0``
    - ``"localhost:10"`` → ``10``
    - ``""`` → ``None``
    """
    if not display:
        return None
    # Strip optional host prefix
    if ":" in display:
        after_colon = display.split(":", 1)[1]
    else:
        return None
    # Strip optional screen suffix (e.g. ":99.0" → "99")
    number_part = after_colon.split(".")[0]
    try:
        return int(number_part)
    except ValueError:
        return None


def launch_vnc_watcher(config: dict, user_id: str) -> subprocess.Popen | None:
    """Launch x11vnc and noVNC (websockify) for a given display.

    This starts two background processes:

    1. **x11vnc** — serves the X11 display via VNC.
    2. **websockify** — proxies WebSocket VNC connections to the raw VNC
       port (noVNC).

    Both processes are launched as a single composite process group; the
    returned :class:`subprocess.Popen` object corresponds to the x11vnc
    process.  The caller is responsible for tracking and terminating the
    subprocess when it is no longer needed.

    Parameters
    ----------
    config : dict
        VNC configuration dict as returned by :func:`resolve_vnc_config`.
        Relevant keys: ``vnc_port``, ``novnc_port``, ``vnc_password``,
        ``view_only``, ``bind``, ``resolution``.
    user_id : str
        The user identifier (used only for logging).

    Returns
    -------
    subprocess.Popen or None
        The x11vnc process handle, or ``None`` if a required binary is
        missing or the display number could not be parsed.

    Notes
    -----
    Display resolution is parsed from ``config["resolution"]`` and applied to
    x11vnc via the ``-clip`` flag (e.g. ``-clip 1920x1080+0+0``).  This
    ensures only the expected area of the virtual screen is served.
    """
    display = config.get("display", os.environ.get("DISPLAY", ""))
    if not display:
        log.warning("launch_vnc_watcher: no display configured for user=%s", user_id)
        return None

    display_num = _parse_display_number(display)
    if display_num is None:
        log.warning(
            "launch_vnc_watcher: could not parse display number from %r for user=%s",
            display, user_id,
        )
        return None

    vnc_port = int(config.get("vnc_port", 5901))
    novnc_port = int(config.get("novnc_port", 6081))
    vnc_password = config.get("vnc_password") or ""
    view_only = bool(config.get("view_only", True))
    bind = config.get("bind", "127.0.0.1")
    resolution = config.get("resolution", "1920x1080x24")

    # --- Check binary availability ---
    x11vnc_bin = shutil.which("x11vnc")
    if not x11vnc_bin:
        log.error("x11vnc not found on PATH; cannot start VNC watcher for user=%s", user_id)
        return None

    websockify_bin = shutil.which("websockify")
    if not websockify_bin:
        log.error("websockify not found on PATH; cannot start noVNC for user=%s", user_id)
        return None

    # --- Check for existing listeners on target ports ---
    if _is_port_in_use(vnc_port):
        log.error(
            "VNC port %d already in use; cannot start watcher for user=%s",
            vnc_port, user_id,
        )
        return None

    if _is_port_in_use(novnc_port):
        log.error(
            "noVNC port %d already in use; cannot start watcher for user=%s",
            novnc_port, user_id,
        )
        return None

    # --- Parse clip geometry from resolution ---
    clip_geo = _resolution_to_clip(resolution)

    # --- Build x11vnc command ---
    x11vnc_args: list[str] = [
        x11vnc_bin,
        "-display", display,
        "-forever",
        "-shared",
        "-rfbport", str(vnc_port),
    ]

    if vnc_password:
        x11vnc_args.extend(["-passwd", vnc_password])

    if view_only:
        x11vnc_args.append("-viewonly")

    if clip_geo:
        x11vnc_args.extend(["-clip", clip_geo])

    # Always use localhost unless bind is explicitly 0.0.0.0
    if bind != "0.0.0.0":
        x11vnc_args.extend(["-localhost", "1"])
    else:
        x11vnc_args.extend(["-localhost", "0"])

    # --- Start x11vnc ---
    try:
        x11vnc_proc = subprocess.Popen(
            x11vnc_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Do not inherit stdin
            stdin=subprocess.DEVNULL,
        )
    except OSError as exc:
        log.error("Failed to start x11vnc for user=%s: %s", user_id, exc)
        return None

    # --- Build websockify (noVNC) command ---
    websockify_args: list[str] = [
        websockify_bin,
        "--web", "/usr/share/novnc",
        str(novnc_port),
        f"127.0.0.1:{vnc_port}",
    ]

    # --- Start websockify ---
    try:
        subprocess.Popen(
            websockify_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
    except OSError as exc:
        log.error(
            "Failed to start websockify for user=%s (x11vnc PID %d): %s",
            user_id, x11vnc_proc.pid, exc,
        )
        # Attempt to clean up x11vnc since websockify failed
        x11vnc_proc.terminate()
        return None

    log.info(
        "VNC watcher started for user=%s display=%s "
        "x11vnc=:%d novnc=:%d resolution=%s",
        user_id, display, vnc_port, novnc_port, resolution,
    )

    return x11vnc_proc


def _resolution_to_clip(resolution: str) -> str | None:
    """Convert a ``WxHxD`` resolution string to an x11vnc ``-clip`` geometry.

    The ``-clip`` flag expects ``WxH+X+Y``.  This function always uses
    ``+0+0`` as the offset.

    Returns ``None`` if the resolution string cannot be parsed.
    """
    parts = resolution.strip().split("x")
    if len(parts) >= 2:
        try:
            width = int(parts[0])
            height = int(parts[1])
            return f"{width}x{height}+0+0"
        except ValueError:
            return None
    return None


def _is_port_in_use(port: int) -> bool:
    """Check if a TCP port is already in use (IPv4 + IPv6).

    Uses ``/proc/net/tcp`` and ``/proc/net/tcp6`` on Linux; falls back to
    a ``socket`` connect attempt on other platforms.
    """
    try:
        # Fast path: check /proc/net/tcp on Linux
        return _check_proc_net_tcp(port)
    except (FileNotFoundError, OSError):
        pass

    # Fallback: try to connect
    return _check_port_with_socket(port)


def _check_proc_net_tcp(port: int) -> bool:
    """Check /proc/net/tcp and /proc/net/tcp6 for a listening port.

    Ports in /proc/net/tcp are stored as hexadecimal (big-endian).
    """
    hex_port = f"{port:04x}"  # e.g. 5901 → "170d"

    for proc_path in ("/proc/net/tcp", "/proc/net/tcp6"):
        if not Path(proc_path).is_file():
            continue
        content = Path(proc_path).read_text()
        # Lines look like:
        #   sl  local_address rem_address   st tx_queue ...
        #   0:  0100007F:170D 00000000:0000 0A ...
        for line in content.splitlines():
            parts = line.strip().split()
            if len(parts) < 2:
                continue
            local_addr = parts[1]  # "0100007F:170D"
            if ":" in local_addr:
                addr_hex = local_addr.split(":", 1)[1]
                if addr_hex == hex_port:
                    # Check state (0A = TCP_LISTEN)
                    if len(parts) >= 4:
                        state = parts[3]
                        if state == "0A":
                            return True
    return False


def _check_port_with_socket(port: int) -> bool:
    """Check if a port is in use by attempting a socket connect."""
    import socket

    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(1.0)
            try:
                if family == socket.AF_INET6:
                    sock.connect(("::1", port))
                else:
                    sock.connect(("127.0.0.1", port))
                sock.close()
                return True
            except (ConnectionRefusedError, OSError):
                sock.close()
        except OSError:
            pass
    return False
