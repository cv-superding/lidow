# syntax=docker/dockerfile:1

# ---------- 构建：Linux 解包目录（内置 Electron，运行时不再需要 Node） ----------
FROM node:22-bookworm-slim AS build

WORKDIR /src
# electron-builder 会自行下载对应 Linux 版 Electron，npm 阶段不需要再下一份
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# 国内网络可 --build-arg APT_MIRROR=mirrors.aliyun.com
ARG APT_MIRROR=deb.debian.org

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
      [ -f "$f" ] && sed -i "s|deb.debian.org|${APT_MIRROR}|g" "$f"; \
    done \
  && apt-get -o Acquire::Retries=10 update \
  && apt-get install -y --no-install-recommends -o Acquire::Retries=10 ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
  && ./node_modules/.bin/electron-builder --linux dir --config electron-builder.yml --publish never

# ---------- 运行：Xvfb + noVNC 提供完整 Electron 桌面 ----------
FROM debian:bookworm-slim

# 国内网络可 --build-arg APT_MIRROR=mirrors.aliyun.com
ARG APT_MIRROR=deb.debian.org

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/lidow \
    XDG_CONFIG_HOME=/home/lidow/.config \
    XDG_RUNTIME_DIR=/tmp/runtime-lidow \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai \
    LIDOW_SCREEN=1360x860x24 \
    LIDOW_VNC_PORT=6080 \
    LIDOW_PROJECT_DIR=/workspace \
    LIDOW_DISABLE_UPDATE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
      [ -f "$f" ] && sed -i "s|deb.debian.org|${APT_MIRROR}|g" "$f"; \
    done \
  && apt-get -o Acquire::Retries=10 update \
  && apt-get install -y --no-install-recommends -o Acquire::Retries=10 \
    ca-certificates curl tini gosu jq procps tzdata \
    xvfb x11vnc openbox novnc websockify dbus-x11 \
    libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 libdrm2 libxkbcommon0 \
    libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libpango-1.0-0 \
    libcairo2 libasound2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libx11-xcb1 libxcb1 libxcb-dri3-0 libxshmfence1 libglib2.0-0 libdbus-1-3 \
    libxcb-keysyms1 libxcb-icccm4 libxcb-image0 libxcb-render-util0 libxcb-xkb1 \
    libxkbcommon-x11-0 libxcb-shape0 libxcb-randr0 libxcb-xfixes0 libxcb-sync1 libxcb-present0 \
    libxcb-cursor0 libxcb-util1 libxcursor1 libxcb-xinerama0 \
    libsecret-1-0 libgl1 libegl1 libgles2 libvulkan1 libnotify4 xdg-utils \
    fonts-wqy-microhei fonts-noto-color-emoji fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash lidow \
  && mkdir -p /workspace /home/lidow/.config/Lidow /home/lidow/.lidow /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chown -R lidow:lidow /home/lidow /workspace

COPY --from=build /src/dist/linux-unpacked /opt/lidow
COPY docker/entrypoint.sh /usr/local/bin/lidow-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/lidow-entrypoint \
  && chmod 0755 /usr/local/bin/lidow-entrypoint \
  && find /opt/lidow -maxdepth 1 -type f \( -iname 'lidow' -o -iname 'chrome-sandbox' -o -iname 'chrome_crashpad_handler' \) -exec chmod 0755 {} + \
  && chown -R lidow:lidow /opt/lidow

WORKDIR /workspace
VOLUME ["/home/lidow/.config/Lidow", "/home/lidow/.lidow", "/workspace"]
EXPOSE 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null \
  && pgrep -f '^/opt/lidow/' >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lidow-entrypoint"]
