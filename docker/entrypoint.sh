#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Lidow"
PROJECT_DIR="${LIDOW_PROJECT_DIR:-/workspace}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DISPLAY_NUM="${LIDOW_DISPLAY:-:99}"
SCREEN="${LIDOW_SCREEN:-1360x860x24}"
WEB_PORT="${LIDOW_WEB_PORT:-6080}"

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
    printf '%s\n' '{"theme":"graphite","desktopPet":false,"pureMode":true}' > "$CONFIG_DIR/settings.json"
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

cleanup() {
  trap - EXIT INT TERM
  for pid in "$APP_PID" "$XVFB_PID"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export DISPLAY="$DISPLAY_NUM"
# Web 版：Electron 窗口只作为隐藏的 AI 网页宿主，用户只访问 6080 的原生网页界面
export LIDOW_WEB_SERVER=1
export LIDOW_HOST_VISIBLE=1
export LIDOW_WEB_PORT="$WEB_PORT"

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

echo "[lidow] starting app host: $APP_BIN"
if command -v dbus-run-session >/dev/null 2>&1; then
  dbus-run-session -- "$APP_BIN" "${APP_ARGS[@]}" &
else
  "$APP_BIN" "${APP_ARGS[@]}" &
fi
APP_PID=$!

if [ -n "${LIDOW_WEB_TOKEN:-}" ]; then
  echo "[lidow] open http://<host>:${WEB_PORT}/?token=${LIDOW_WEB_TOKEN}"
else
  echo "[lidow] open http://<host>:${WEB_PORT}/"
fi
wait "$APP_PID"
