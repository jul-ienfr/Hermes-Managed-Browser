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

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }

CURRENT_DISPLAY=""
X11VNC_PID=""

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

# Start noVNC (websockify) — proxies to x11vnc regardless of whether it's up yet
NOVNC_DIR="/usr/share/novnc"
if [ ! -d "$NOVNC_DIR" ]; then
  log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
  exit 1
fi
VNC_BIND="${VNC_BIND:-127.0.0.1}"
log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/camofox-novnc.log 2>&1 &

log "VNC watcher started — will attach x11vnc when Camoufox's Xvfb appears"

find_visible_camoufox_display() {
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

    X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -rfbport $VNC_PORT -noxdamage -quiet -bg -o /tmp/camofox-x11vnc.log"
    [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
    if [ -n "$PASSFILE" ]; then
      X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
    else
      X11VNC_ARGS="$X11VNC_ARGS -nopw"
    fi

    # shellcheck disable=SC2086
    x11vnc $X11VNC_ARGS
    sleep 1
    X11VNC_PID=$(pgrep -f "x11vnc.*-display $CURRENT_DISPLAY" | head -1)
    log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
  fi

  sleep 2
done
