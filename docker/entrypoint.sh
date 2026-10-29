#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Lidow"
PROJECT_DIR="${LIDOW_PROJECT_DIR:-/workspace}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DISPLAY_NUM="${LIDOW_DISPLAY:-:99}"
SCREEN="${LIDOW_SCREEN:-1360x860x24}"
VNC_PORT="${LIDOW_VNC_PORT:-6080}"

seed_profile() {
  mkdir -p "$CONFIG_DIR" "$PROJECT_DIR"
  if [ ! -f "$CONFIG_DIR/projects.json" ]; then
    local now name
    now=$(( $(date +%s) * 1000 ))
    name="$(basename "$PROJECT_DIR")"
    jq -n \
      --arg id "proj_docker" \
      --arg name "$name" \
      --arg root "$PROJECT_DIR" \
      --argjson now "$now" \
      '{projects:[{id:$id,name:$name,root:$root,createdAt:$now,lastOpenedAt:$now}],activeProjectId:$id}' \
      > "$CONFIG_DIR/projects.json"
  fi
  if [ ! -f "$CONFIG_DIR/settings.json" ]; then
    printf '%s\n' '{"theme":"graphite","desktopPet":false,"pureMode":false}' > "$CONFIG_DIR/settings.json"
  fi
}

# 以 root 启动时先对齐 UID/GID、准备持久化目录，再降权运行
if [ "$(id -u)" = "0" ] && [ "${LIDOW_ENTRY_DROPPED:-0}" != "1" ]; then
  if [ "$(id -u lidow)" != "$PUID" ]; then usermod -o -u "$PUID" lidow; fi
  if [ "$(id -g lidow)" != "$PGID" ]; then groupmod -o -g "$PGID" lidow; fi
  mkdir -p "$HOME" "$CONFIG_DIR" "$PROJECT_DIR" "$XDG_RUNTIME_DIR"
  seed_profile
  chown -R "$PUID:$PGID" "$HOME" "$PROJECT_DIR" 2>/dev/null || true
  chown "$PUID:$PGID" "$XDG_RUNTIME_DIR" 2>/dev/null || true
  chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
  export LIDOW_ENTRY_DROPPED=1
  exec gosu "$PUID:$PGID" "$0" "$@"
fi

seed_profile
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

APP_PID=""
XVFB_PID=""
OPENBOX_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$APP_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID" "$OPENBOX_PID" "$XVFB_PID"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export DISPLAY="$DISPLAY_NUM"
echo "[lidow] starting Xvfb ${DISPLAY} (${SCREEN})"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -ac +extension GLX +render -noreset &
XVFB_PID=$!

for _ in $(seq 1 100); do
  if [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then break; fi
  sleep 0.1
done
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[lidow] Xvfb failed to start" >&2
  exit 1
fi

# 轻量窗口管理器：原生文件对话框/焦点切换更稳定
if command -v openbox >/dev/null 2>&1; then
  openbox >/tmp/openbox.log 2>&1 &
  OPENBOX_PID=$!
fi

VNC_ARGS=(-display "$DISPLAY" -forever -shared -localhost -rfbport 5900 -noxdamage -repeat -o /tmp/x11vnc.log)
if [ -n "${LIDOW_VNC_PASSWORD:-}" ]; then
  mkdir -p "$HOME/.vnc"
  x11vnc -storepasswd "$LIDOW_VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
  VNC_ARGS+=(-rfbauth "$HOME/.vnc/passwd")
else
  VNC_ARGS+=(-nopw)
fi
echo "[lidow] starting x11vnc"
x11vnc "${VNC_ARGS[@]}" &
X11VNC_PID=$!

echo "[lidow] noVNC listening on 0.0.0.0:${VNC_PORT}"
NOVNC_WEB="${LIDOW_NOVNC_WEB:-/usr/share/novnc}"
if [ ! -f "$NOVNC_WEB/vnc.html" ]; then
  found="$(find /usr/share -name vnc.html -print -quit 2>/dev/null || true)"
  if [ -n "$found" ]; then NOVNC_WEB="$(dirname "$found")"; fi
fi
if [ ! -f "$NOVNC_WEB/vnc.html" ] || ! command -v websockify >/dev/null 2>&1; then
  echo "[lidow] noVNC/websockify not installed correctly" >&2
  exit 1
fi
websockify --web="$NOVNC_WEB" "$VNC_PORT" 127.0.0.1:5900 &
WEBSOCKIFY_PID=$!

APP_BIN="${LIDOW_APP_BIN:-}"
if [ -z "$APP_BIN" ]; then
  APP_BIN="$(find /opt/lidow -maxdepth 1 -type f -perm -u+x \( -iname 'lidow*' -o -iname 'electron' \) -print -quit)"
fi
if [ -z "$APP_BIN" ] || [ ! -x "$APP_BIN" ]; then
  echo "[lidow] app binary not found under /opt/lidow" >&2
  exit 1
fi

APP_ARGS=(--no-sandbox --disable-dev-shm-usage --disable-gpu-sandbox --ozone-platform=x11)
if [ "${LIDOW_ENABLE_GPU:-0}" != "1" ]; then APP_ARGS+=(--disable-gpu); fi

echo "[lidow] starting app: $APP_BIN"
if command -v dbus-run-session >/dev/null 2>&1; then
  dbus-run-session -- "$APP_BIN" "${APP_ARGS[@]}" &
else
  "$APP_BIN" "${APP_ARGS[@]}" &
fi
APP_PID=$!

echo "[lidow] open http://<host>:${VNC_PORT}/vnc.html?autoconnect=true&resize=scale"
wait "$APP_PID"
