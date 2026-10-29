# Lidow 架构设计

## 进程模型

```
┌────────────────────────── Electron 主进程 (main) ──────────────────────────┐
│ app/      窗口、热键、更新器、AppContext、IPC handlers                     │
│ bridge/   Agent 循环（解析→确认→执行→观察）、OverlayManager、SSE 看门狗    │
│ tools/    工具注册表 + read/write/edit/glob/grep/bash/pwsh/webFetch/...    │
│ security/ 危险命令检测、SSRF 防护、拒绝改写（安全 MOD）                    │
│ providers/ 平台注册表（DeepSeek/Claude/ChatGPT/豆包/通义/文心/Kimi/GLM）   │
│ session/  会话存储（单会话单文件 + index）、血缘、压缩                     │
│ ecosystem/ Skills/Agents/Rules、记忆、审计回滚、任务计划、知识库           │
│ mcp/ dsh/ plugins/ sync/   MCP 三组件、DSH 宿主、插件与市场、多端同步     │
└──────────────┬──────────────────────────────────┬────────────────────────┘
     contextBridge │                              │ webview IPC
┌──────────────▼─────────────┐    ┌───────────────▼──────────────────────┐
│ renderer (React + Tailwind)│    │ overlay preload（注入 AI 网页）      │
│  三栏 UI / Harness / 设置   │    │  DOM 适配器、流监听、悬浮球、三层停止 │
└────────────────────────────┘    └──────────────────────────────────────┘
```

- **IPC 契约单一事实源**：`src/shared/ipc.ts` 定义 `LidowApi`；preload 只暴露
  `invoke(method, args)` + `onEvent(cb)`，renderer 用 Proxy 映射成类型化 API。
  新增方法零改动 preload。
- **会话隔离**：`routedSessionFacade` 按 sessionId 动态路由到所属项目的
  SessionStore——多窗口并发写各自会话，修复上游 #24 串扰。
- **Agent 循环**（`bridge/loop.ts`）：
  1. 首轮注入系统提示词（项目树 + 规则 + 技能摘要 + 记忆 + 工具协议 + 安全 MOD）
  2. `sendToPage` → overlay 填输入/点发送 → `awaitReply`（流式 chunk + TPS）
  3. 90s 看门狗；拒绝话术检测 → 按配置改写重试（上限防循环）
  4. `parseToolCalls` 解析 ```lidow 块 → 未知工具/畸形 JSON 反馈重试
  5. 工具执行：危险命令确认门（超时=拒绝）→ 审计留痕 → 结果回传观察
  6. 阈值自动压缩（保留近 8 轮原文）；三层停止（generate/tool/auto-loop）

## 通信通道

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| `lidow:invoke` | renderer → main | 全部方法调用（单通道 + 方法名分发） |
| `lidow:event` | main → renderer | 会话更新/流式 chunk/工具卡片/确认请求/通知 |
| `lidow:overlay` | webview → main | overlay 事件（ready/流/send-result/悬浮球动作） |
| `lidow:overlay-cmd` | main → webview | configure/send/stop/new-chat/extract |

## 目录树

见仓库 `src/`；`docs/` 其余文档：dsh-coverage / provider-dev / plugin-dev / ui-design。

## 构建与发布

- `electron-vite` 四产物：`out/main` `out/preload/index.js` `out/preload/overlay.js` `out/renderer/`
- `electron-builder`：Windows NSIS + 便携版、macOS universal dmg + zip（Intel + Apple Silicon，`.github/workflows/release.yml`）
- 打包文件清单显式白名单（修复上游 #45）；CI 三平台跑 typecheck/lint/test/build
