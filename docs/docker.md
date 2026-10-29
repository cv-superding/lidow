# Docker 部署（原生 Web 版）

Docker 镜像启动后，浏览器直接打开 Lidow 的原生网页界面。**没有 VNC、没有远程桌面或屏幕串流**：

```
浏览器 → Lidow Web (HTTP API + SSE) → main 进程
                                      └→ 隐藏 Chromium 宿主（Xvfb 内）→ AI 网页
```

- 会话列表、对话、思考折叠、工具卡片、右侧文件/任务/终端/审阅都是真实 DOM 界面
- AI 网页由容器内的隐藏 Chromium 驱动，用户看不到浏览器窗口
- 登录态、项目、会话、技能全部持久化

> Xvfb 只用于让容器内的 Chromium 正常渲染 AI 网页；它不会暴露给访问者。

## 快速开始

```bash
mkdir -p workspace
cp .env.example .env      # 可选：端口 / 访问令牌 / PUID
docker compose up -d --build
```

浏览器打开：

```
http://127.0.0.1:6080/
```

`./workspace` 会挂载为容器内 `/workspace`，并自动加入项目列表。

查看日志/停止：

```bash
docker compose logs -f lidow
docker compose exec lidow tail -n 100 /home/lidow/.config/Lidow/logs/lidow.log
docker compose down
```

## 首次登录 AI 平台

容器无法替你完成平台登录。点左下角 **登录平台**，按弹窗提示操作：

1. 点「打开登录页」，在你自己的浏览器里登录对应 AI 网站（邮箱/验证码；Google OAuth 会被平台拒绝）
2. 按 F12 → Network → 任意请求 → 复制请求头里的 `Cookie`
3. 粘贴到 Lidow Web 的登录弹窗，点「导入登录态」
4. 新建任务即可；服务端隐藏宿主会用这份 Cookie 打开 AI 网页

Cookie 写入对应平台/账号的持久化分区，重启容器后仍有效。也支持粘贴导出的 JSON Cookie 数组。

如果平台触发风控，优先使用平台允许的登录方式；数据中心 IP 可能被额外限制，这是平台策略。

## 使用流程

1. 左侧「新建任务」创建会话
2. 在输入框发任务；AI 通过容器内 `/workspace` 读写文件、执行命令
3. 右侧工具侧栏查看文件、任务、终端与 diff 审阅
4. 会话、工具结果和项目数据都在 `/workspace/.lidow/` 与配置卷里持久化

## 持久化

| 容器路径 | 内容 | 宿主机 |
| :--- | :--- | :--- |
| `/home/lidow/.config/Lidow` | settings.json、projects.json、日志、记忆、审计、插件配置、平台 Cookie 分区 | `lidow-config` 卷 |
| `/home/lidow/.lidow` | 用户级 skills / agents / rules | `lidow-user` 卷 |
| `/workspace` | 项目文件与 `.lidow/sessions`、`.lidow/skills` | `./workspace` |

```bash
docker compose down       # 保留数据
docker compose down -v    # 删除配置卷（不删除 ./workspace）
```

## 配置项

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `LIDOW_BIND_ADDR` | `127.0.0.1` | Web 服务监听地址 |
| `LIDOW_WEB_PORT` | `6080` | 宿主机端口（容器内固定 6080） |
| `LIDOW_WEB_TOKEN` | 空 | 访问令牌；设置后访问需带 `?token=...` |
| `LIDOW_SCREEN` | `1360x860x24` | 隐藏 Chromium 宿主的虚拟屏幕分辨率 |
| `LIDOW_ENABLE_GPU` | `0` | 默认软件渲染；宿主透传 `/dev/dri` 后可设 1 |
| `PUID` / `PGID` | `1000` | 容器内运行 UID/GID，Linux 下建议与宿主一致 |
| `TZ` | `Asia/Shanghai` | 时区 |

远程访问示例：

```bash
# .env
LIDOW_BIND_ADDR=0.0.0.0
LIDOW_WEB_TOKEN=change-me
```

然后访问 `http://<host>:6080/?token=change-me`，并尽量放在 HTTPS 反向代理 / VPN 之后。
**不要无令牌直接暴露到公网**：Web 界面包含可在容器内执行命令的终端与文件工具。

## 更新

容器内不执行 Electron 应用内自动更新（镜像里的版本固定）。更新流程：

```bash
git pull
docker compose up -d --build
```

配置和项目数据在卷/宿主机目录里，会保留。

## 常见问题

**页面打不开 / 空白**
先看 `docker compose logs -f lidow`，再访问 `/healthz`；确认端口未被占用。

**导入 Cookie 后仍显示未登录**
Cookie 可能不完整或已过期；重新登录后复制整条 `Cookie` 请求头。部分平台会把登录态拆到 localStorage，若 Cookie 无效请更换登录方式或平台。

**AI 回复卡住**
查看日志中的 `overlay` / `nav` 记录。平台改版可能导致 DOM 适配器选择器失效，可在项目配置中调整 `adapter`。

**中文输入**
Web 界面直接使用本机输入法；终端面板同样支持浏览器输入法。

**文件权限错误**
Linux 下把 `PUID`/`PGID` 改成 `id -u` / `id -g` 后重建容器；Windows/macOS Docker Desktop 通常不需要设置。

**镜像构建失败**
构建阶段需要访问 Debian 包源、npm 与 Electron 下载源。Compose 默认使用阿里云 Debian 镜像（海外网络可在 `.env` 设 `APT_MIRROR=deb.debian.org`）；electron-builder 已配置 npmmirror 的 Electron 镜像。

## 手动构建/运行

```bash
docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t lidow:local .
docker run --rm -p 127.0.0.1:6080:6080 \
  -e LIDOW_WEB_TOKEN=change-me \
  -v "$PWD/workspace:/workspace" \
  -v lidow-config:/home/lidow/.config/Lidow \
  lidow:local
```

访问 `http://127.0.0.1:6080/?token=change-me`。镜像架构跟随构建机。
