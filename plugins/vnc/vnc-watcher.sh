#!/bin/sh
# VNC watcher: detects Camoufox's dynamically-assigned Xvfb display and attaches
# x11vnc + noVNC to it. Handles browser restarts (re-attaches on display change).
#
# Called by the VNC plugin via child_process.spawn. Not meant to run standalone.
#
# Env vars (set by the plugin):
#   VNC_PASSWORD    If set, x11vnc requires this password
#   VIEW_ONLY       "1" for view-only mode
#   VNC_PORT        VNC port (default: 5900)
#   NOVNC_PORT      noVNC websocket port (default: 6080)

set -e

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_NOVNC_DIR="/usr/share/novnc"
PATCHED_NOVNC_DIR="/tmp/camofox-novnc-web"

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }

CURRENT_DISPLAY=""
X11VNC_PID=""
CAMOFOX_VNC_DISPLAY_REGISTRY="${CAMOFOX_VNC_DISPLAY_REGISTRY:-/tmp/camofox-vnc-displays.json}"
CAMOFOX_VNC_DISPLAY_SELECTION="${CAMOFOX_VNC_DISPLAY_SELECTION:-/tmp/camofox-vnc-selected-display.json}"
CAMOFOX_VNC_MANAGED_REGISTRY_ONLY="${CAMOFOX_VNC_MANAGED_REGISTRY_ONLY:-1}"

# Prepare password file if requested
PASSFILE=""
if [ -n "${VNC_PASSWORD:-}" ]; then
  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vnc/passwd >/dev/null 2>&1
  PASSFILE="/tmp/.vnc/passwd"
  log "x11vnc: password protected"
else
  log "x11vnc: NO password (bind $NOVNC_PORT to 127.0.0.1 on host + SSH tunnel)"
fi

prepare_novnc_dir() {
  if [ ! -d "$DEFAULT_NOVNC_DIR" ]; then
    log "ERROR: $DEFAULT_NOVNC_DIR not found; noVNC cannot start"
    exit 1
  fi

  rm -rf "$PATCHED_NOVNC_DIR"
  mkdir -p "$PATCHED_NOVNC_DIR"
  cp -a "$DEFAULT_NOVNC_DIR"/. "$PATCHED_NOVNC_DIR"/

  if [ -f "$SCRIPT_DIR/novnc-error-handler.patch.js" ] && [ -f "$PATCHED_NOVNC_DIR/vnc.html" ]; then
    cp "$SCRIPT_DIR/novnc-error-handler.patch.js" "$PATCHED_NOVNC_DIR/app/novnc-error-handler.patch.js"
    python3 - "$PATCHED_NOVNC_DIR/vnc.html" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
html = path.read_text()
patch_script = '    <script src="app/novnc-error-handler.patch.js"></script>\n'
anchor = '    <script src="app/error-handler.js"></script>\n'
if patch_script not in html:
    if anchor not in html:
        raise SystemExit('noVNC vnc.html error-handler anchor not found')
    html = html.replace(anchor, patch_script + anchor, 1)
path.write_text(html)
PY
  fi

  NOVNC_DIR="$PATCHED_NOVNC_DIR"
}

# Start/keep noVNC (websockify) — proxies to x11vnc regardless of whether it's up yet.
# A one-shot launch can fail with EADDRINUSE during restart, then leave noVNC down
# later if the old websockify exits. Keep the listener supervised here.
VNC_BIND="${VNC_BIND:-127.0.0.1}"
WEBSOCKIFY_PID=""

port_listening() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${NOVNC_PORT}$"
}

websockify_healthy() {
  [ -f "$NOVNC_DIR/vnc.html" ] || return 1
  curl -fsS -I --max-time 2 "http://127.0.0.1:$NOVNC_PORT/vnc.html" >/dev/null 2>&1
}

kill_websockify_on_port() {
  python3 - "$NOVNC_PORT" <<'PY' 2>/dev/null || true
import os, signal, sys, time
port = sys.argv[1]
needles = {f':{port}', f'0.0.0.0:{port}', f'127.0.0.1:{port}'}
killed = []
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        raw = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
    except Exception:
        continue
    argv = [x.decode('utf-8', 'ignore') for x in raw if x]
    if not argv:
        continue
    joined = ' '.join(argv)
    if 'websockify' not in joined:
        continue
    if not any(needle in joined for needle in needles):
        continue
    try:
        os.kill(int(pid), signal.SIGTERM)
        killed.append(int(pid))
    except ProcessLookupError:
        pass
for _ in range(10):
    alive = []
    for pid in killed:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except OSError:
            pass
    if not alive:
        break
    time.sleep(0.1)
for pid in alive if 'alive' in locals() else []:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
PY
}

start_websockify() {
  if port_listening; then
    if websockify_healthy; then
      return 0
    fi
    log "WARNING: noVNC port $NOVNC_PORT is listening but vnc.html is not healthy; restarting stale websockify"
    kill_websockify_on_port
    sleep 1
  fi
  if port_listening; then
    return 0
  fi
  log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
  websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/camofox-novnc.log 2>&1 &
  WEBSOCKIFY_PID="$!"
  sleep 1
  if ! kill -0 "$WEBSOCKIFY_PID" 2>/dev/null && ! port_listening; then
    log "WARNING: websockify failed to stay up; will retry"
    WEBSOCKIFY_PID=""
  fi
}

prepare_novnc_dir
start_websockify
log "VNC watcher started — will attach x11vnc when Camoufox's Xvfb appears and keep noVNC alive"

find_visible_camoufox_display() {
  # Prefer an explicit profile -> display registry written by the server.
  # This lets a human switch the noVNC view between multiple browser profiles.
  if [ -f "$CAMOFOX_VNC_DISPLAY_REGISTRY" ]; then
    REGISTRY_DISPLAY=$(python3 - "$CAMOFOX_VNC_DISPLAY_REGISTRY" "$CAMOFOX_VNC_DISPLAY_SELECTION" <<'PY' 2>/dev/null || true
import json, os, re, subprocess, sys
registry_path, selection_path = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(registry_path, encoding='utf-8'))
except Exception:
    data = {}
selected_user_id = ''
try:
    selected = json.load(open(selection_path, encoding='utf-8'))
    selected_user_id = str((selected or {}).get('userId') or '')
except Exception:
    selected_user_id = ''
def has_visible_browser_window(display):
    env = dict(os.environ, DISPLAY=display)
    try:
        result = subprocess.run(['xwininfo', '-root', '-tree'], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=False)
    except Exception:
        return False
    for line in result.stdout.splitlines():
        if not re.search(r'camoufox|firefox|navigator', line, re.I):
            continue
        match = re.search(r'\b([1-9][0-9]{2,})x([1-9][0-9]{2,})[+-]', line)
        if match:
            return True
    return False
def is_active(key, entry):
    if key == 'default':
        return False
    display = str((entry or {}).get('display') or '')
    pid = int((entry or {}).get('pid') or 0)
    if not display.startswith(':') or not display[1:].isdigit():
        return False
    if pid > 0:
        try:
            os.kill(pid, 0)
        except OSError:
            return False
    if not os.path.exists(f'/tmp/.X11-unix/X{display[1:]}'):
        return False
    return has_visible_browser_window(display)
if selected_user_id:
    entry = data.get(selected_user_id) or {}
    display = str(entry.get('display') or '')
    if display and is_active(selected_user_id, entry):
        print(display)
        raise SystemExit(0)
for key in sorted(data):
    entry = data.get(key) or {}
    display = str(entry.get('display') or '')
    if display and is_active(key, entry):
        print(display)
        break
PY
)
    if [ -n "$REGISTRY_DISPLAY" ]; then
      printf '%s\n' "$REGISTRY_DISPLAY"
      return 0
    fi
  fi

  if [ "$CAMOFOX_VNC_MANAGED_REGISTRY_ONLY" = "1" ]; then
    return 1
  fi

  for d in $(ps -eo args= 2>/dev/null | awk -v res="$VNC_RESOLUTION" '
    /\/Xvfb :[0-9]+/ && index($0, res) {
      for (i=1;i<=NF;i++) if ($i ~ /^:[0-9]+$/) { print substr($i, 2) }
    }
  '); do
    if DISPLAY=":$d" xwininfo -root -tree 2>/dev/null | grep -Eiq 'camoufox|firefox|navigator'; then
      if DISPLAY=":$d" xwininfo -root -tree 2>/dev/null | grep -Eiq '[0-9]{3,}x[0-9]{3,}'; then
        printf ':%s\n' "$d"
        return 0
      fi
    fi
  done
  return 1
}

while true; do
  start_websockify

  # Prefer the Xvfb display that actually contains a visible browser window.
  # With multiple Camoufox/Xvfb instances, picking the first display can attach
  # VNC to a hidden 10x10/blank browser and noVNC looks black.
  FOUND=$(find_visible_camoufox_display || true)

  if [ -n "$FOUND" ] && [ "$FOUND" != "$CURRENT_DISPLAY" ]; then
    # New or changed display — (re)attach x11vnc
    if [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null; then
      log "Camoufox display changed ($CURRENT_DISPLAY -> $FOUND), restarting x11vnc"
      kill "$X11VNC_PID" 2>/dev/null || true
      sleep 0.5
    fi

    CURRENT_DISPLAY="$FOUND"
    log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

    X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -rfbport $VNC_PORT -localhost -noxdamage -quiet -bg -o /tmp/camofox-x11vnc.log"
    [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
    if [ -n "$PASSFILE" ]; then
      X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
    else
      X11VNC_ARGS="$X11VNC_ARGS -nopw"
    fi

    # shellcheck disable=SC2086
    if x11vnc $X11VNC_ARGS; then
      sleep 1
      X11VNC_PID=$(pgrep -f "x11vnc.*-display $CURRENT_DISPLAY" | head -1)
      log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
    else
      log "WARNING: x11vnc failed to attach to DISPLAY=$CURRENT_DISPLAY; will retry"
      CURRENT_DISPLAY=""
      X11VNC_PID=""
    fi
  fi

  sleep 2
done
