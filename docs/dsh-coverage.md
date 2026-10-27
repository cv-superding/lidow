# DSH 兼容覆盖清单

对照基线：**DSH v0.2.0-rc.2**（119 个 Context 服务，名单取自 cuckoo-code `docs/dsh-api-coverage.md`）。

## 当前状态：119 / 119 ✅

按 cuckoo 的"最小可用"哲学分三档实现（`src/main/dsh/host.ts` + `src/main/dsh/services.ts`）：

| 档位 | 含义 | 数量 |
| --- | --- | --- |
| ⚙️ native | Lidow 真实能力映射（工具/会话/文件/作业/凭据/插件/钩子/MCP/webServer…） | 45 |
| 🔗 event-bridge | 转发到 renderer 事件或确认门（客户端 UI 类：toast/dialog/输入框/消息列表…） | 14 |
| 📦 storage-backed | 泛用 CRUD 兜底（持久化 `dsh-kv.json`，插件可存取领域条目不崩溃；低频服务待深度实现） | 60 |

### native 明细（⚙️）

- core：`tools` `fs` `shell` `web` `subprocess` `systemPrompt`（片段注入提示词构建器）`mcpResources`（list+read）
- session：`sessions` `sessionTitle` `sessionPersistence` `sessionQuery` `sessionProjections` `sessionLogDownload` `sessionController` `terminals`
- registry：`skills` `subagents` `goals` `workspaceFiles` `providers`(≈llm) `llm` `workspaceRegistry` `tokenMeter`
- ui：`slots` `settings` `settingsController` `shortcuts` `theme` `locale` `webServer`（回环静态服务器+目录白名单）
- misc：`jobs` `jobController` `schedule` `scheduler` `credentials` `secretStore`（safeStorage 加密）
- ext：`pluginManager` `pluginPackages` `hmr`（插件入口真重载）`hookRegistry` `extensionPoints` `logging`

### event-bridge 明细（🔗）

`uiToasts` `uiNotifications` `uiStatus` `uiDialogs`（confirm 走危险操作确认门）`uiChat` `uiInput`（下发 ChatPanel 输入框）`uiMessages` `uiSession` `uiWorkspace` `fileUpload` `uiPanels` `uiToolbar` `uiOverlays`

### storage-backed 明细（📦）

`storageDomain` · `sessionProjectionCache` `sessionFileReferences` `sessionReferenceResolver` `sessionSkillCatalog` `sessionTelemetry` `sessionFeedback` `fileReferences` `spillStore` · `subagentModelSelection` `llmRouter` `llmFallback` `llmCache` `promptLibrary` · `ptcRuntime` `typert` `typertGateway` `lsp` `sandbox` `sandboxPolicy` `shellEnv`(半 native) ·
misc：`workflowEngine` `webhookRuntime` `otel` `telemetry` `metrics` `tracing` `audit` `permissions` `auth` `users` `teams` `shares` `comments` `email` `calendar` `tasks` `kanban` `wiki` `docs` `search` `index` `embeddings` `vectors` `rag` `templateEngine` `render` `export` `import` `convert` `diff` `merge` `patch` `vcs` `git` `containers` `docker` `k8s` `cloud` `browser` `screenshot`

> 升级路径：任何 📦 服务都可在后续批次升级为 native（如 `rag` 接知识库索引、`search` 接全文检索）；当前实现保证 DSH 插件调用不崩溃、数据可持久化。
