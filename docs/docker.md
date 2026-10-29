# Docker 部署（远程桌面）

Lidow 是 Electron 桌面应用，不是 Web 服务。Docker 镜像在容器内启动 Xvfb、Openbox、
x11vnc 与 noVNC，把**完整的 Lidow 桌面界面**通过浏览器提供：

```
浏览器 → noVNC(6080) → x11vnc → Xvfb(:99) → Lidow (Electron + WebView)
```

这不是阉割版 Web UI；工具调用、终端、右侧审阅、数据库/知识库、内嵌 AI 网页都按原样运行，
只是显示层换成了远程桌面。

## 环境要求

- Docker Engine 24+ / Docker Desktop，Docker Compose v2
- 建议 2 核 CPU、2 GB 内存、3 GB 可用磁盘（镜像含 Electron/Chromium 与中文字体）
- 能访问所用 AI 网页版的网络；首次登录需要手机扫码或邮箱密码

## 快速开始

```bash
mkdir -p workspace
cp .env.example .env      # 可选：改端口/密码
docker compose up -d --build
```

浏览器打开：

```
http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale
```

首次进入后：

1. 工作目录 `/workspace` 已自动加入项目列表并映射到宿主机 `./workspace`
2. 在页面里选择一个 AI 平台并登录
3. 网站里的 Lidow 引导会显示当前目录，确认后即可开始对话
4. 在纯净模式里新建任务；工具读写的是容器内 `/workspace`（即宿主机 `./workspace`）

查看日志/停止：

```bash
docker compose logs -f lidow
docker compose exec lidow tail -n 100 /home/lidow/.config/Lidow/logs/lidow.log
docker compose down
```

## 安全与远程访问

默认只把 noVNC 绑定在 `127.0.0.1`。需要在局域网/公网访问时：

```bash
# .env
LIDOW_BIND_ADDR=0.0.0.0
LIDOW_VNC_PASSWORD=change-me-at-least-6-chars
```

```bash
docker compose up -d
```

- **务必设置 VNC 密码**，并尽量放在 HTTPS 反向代理、VPN 或内网之后
- noVNC 等同于把一台可操作容器内文件和终端的桌面暴露给访问者
- 不要直接把 6080 暴露到公网；Lidow 的终端工具可以在容器内执行命令

## 持久化

Compose 会创建两个命名卷，并挂载项目目录：

| 容器路径 | 内容 | 宿主机 |
| :--- | :--- | :--- |
| `/home/lidow/.config/Lidow` | settings.json、projects.json、日志、记忆、审计、插件配置 | `lidow-config` 卷 |
| `/home/lidow/.lidow` | 用户级 skills / agents / rules | `lidow-user` 卷 |
| `/workspace` | 项目文件与 `.lidow/sessions`、`.lidow/skills` | `./workspace` |

```bash
docker compose down       # 保留数据
docker compose down -v    # 删除配置卷（不删除 ./workspace）
```

项目数据本身在 `./workspace/.lidow/`，随项目走；需要额外目录时在 Compose 里增加
`- /host/path:/workspace/other` 之类的挂载。

## 配置项

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `LIDOW_BIND_ADDR` | `127.0.0.1` | noVNC 监听地址 |
| `LIDOW_VNC_PORT` | `6080` | 宿主机端口 |
| `LIDOW_VNC_PASSWORD` | 空 | VNC 密码；远程访问必填 |
| `LIDOW_SCREEN` | `1360x860x24` | 容器虚拟屏幕分辨率 |
| `LIDOW_ENABLE_GPU` | `0` | 默认软件渲染；宿主透传 `/dev/dri` 后可设 1 |
| `PUID` / `PGID` | `1000` | 容器内运行 UID/GID，Linux 下建议与宿主一致 |
| `TZ` | `Asia/Shanghai` | 时区 |

修改 `.env` 后 `docker compose up -d` 重建即可。改分辨率后需重启容器。

## 更新

容器内不执行 Electron 应用内自动更新（镜像里的版本是固定的）。更新流程：

```bash
git pull
docker compose up -d --build
```

配置和项目数据在卷/宿主机目录里，会保留。

## 常见问题

**页面空白 / 连不上**
查看 `docker compose logs -f lidow`。确认 6080 端口未被占用，noVNC 地址包含
`/vnc.html`；直接访问根路径可能只是目录页。

**登录被平台拦截**
AI 网页版可能在数据中心 IP、无头浏览器或嵌入式浏览器上触发风控。优先使用手机扫码、
邮箱密码或平台允许的登录方式。Google OAuth 在嵌入式浏览器里会被拒绝，这是平台策略，
不是容器问题。

**中文输入**
容器内没有中文输入法。建议使用 noVNC 左侧剪贴板把中文/长提示词粘贴进去；
需要完整输入法可在镜像里自行安装 fcitx5/ibus 并调整 X 会话。

**文件权限错误**
Linux 下把 `PUID`/`PGID` 改成 `id -u` / `id -g` 的结果后重建容器；
Windows/macOS Docker Desktop 通常不需要设置。挂载目录需可写。

**性能较慢**
默认软件渲染并关闭桌宠（`desktopPet:false`）。降低 `LIDOW_SCREEN`（如 `1280x800x24`），
关闭网页动画；宿主有可用 `/dev/dri` 时可在 Compose 增加 `devices: ["/dev/dri:/dev/dri"]`
并设置 `LIDOW_ENABLE_GPU=1`。

**镜像构建失败**
构建阶段需要访问 Debian 包源、npm 和 Electron 下载源。Compose 默认使用阿里云 Debian 镜像
（海外网络可在 `.env` 设为 `APT_MIRROR=deb.debian.org`）；electron-builder 已配置 npmmirror 的
Electron 镜像。如仍失败，请为 Docker 配置代理后重试。

## 手动构建/运行

```bash
docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t lidow:local .
docker run --rm -p 127.0.0.1:6080:6080 \
  -v "$PWD/workspace:/workspace" \
  -v lidow-config:/home/lidow/.config/Lidow \
  lidow:local
```

镜像架构跟随构建机；在 x86_64 机器上构建 amd64 镜像，在 ARM 机器上构建 arm64 镜像。
