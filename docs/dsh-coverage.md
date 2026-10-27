# DSH 兼容覆盖清单

对照基线：**DSH v0.2.0-rc.2**（119 个 Context 服务，名单取自 cuckoo-code `docs/dsh-api-coverage.md`）。

## 当前状态

- ✅ **已实现：31 个**（`src/main/dsh/host.ts` 服务注册表，插件经 `ctx.<service>` 调用）
- ⏳ 待补：88 个，按批次推进

### 已实现

| 类别 | 服务 |
| --- | --- |
| core | `tools` `fs` `shell` `web` |
| session (B1) | `sessions` `sessionTitle` `sessionPersistence` `sessionQuery` |
| storage | `storage` |
| registry (B4) | `skills` `subagents` `goals` `workspaceFiles` `providers`(≈llm) `workspaceRegistry` `tokenMeter` |
| ui (B2) | `slots` `settings` `settingsController` `shortcuts` `theme` `locale` |

> 说明：Lidow 以自有能力映射 DSH 语义（如 `providers` 对应 `llm`），语义差异在适配层消化。

## 补全批次计划

| 批次 | 服务 | 状态 |
| --- | --- | --- |
| B1 | 会话四件套 | ✅ 已完成 |
| B2 | `settingsController` `shortcuts` `theme` `locale` | ✅ 已完成（uiWorkspace 待做） |
| B3 | `jobs` `jobController` `schedule` `credentials` | 待做 |
| B4 | `subagents` `skills` `goals` `workspaceFiles` | ✅ 已完成 |
| B5 | 客户端 UI 其余（`uiChat` `uiInput` `uiMessages`… 20 个） | 待做 |
| B6 | 扩展机制 + 低频 misc | 待做 |

## 完整 119 服务名单

core/tool: `tools` `systemPrompt` `fs` `shell` `terminals` `web` `mcpResources` `subprocess` `sandbox` `sandboxPolicy` `shellEnv` ·
session: `sessions` `sessionTitle` `sessionProjections` `sessionQuery` `sessionPersistence` `sessionProjectionCache` `sessionLogDownload` `sessionController` `sessionFileReferences` `sessionReferenceResolver` `sessionSkillCatalog` `sessionTelemetry` `sessionFeedback` `fileReferences` `spillStore` ·
storage: `storage` `storageDomain` ·
registry: `skills` `subagents` `workspaceRegistry` `workspaceFiles` `goals` `llm` `tokenMeter` `subagentModelSelection` ·
client ui: `slots` `settings` `webServer` `uiWorkspace` `uiSession` `locale` `theme` `shortcuts` `fileUpload` `settingsController` `uiChat` `uiInput` `uiMessages` `uiToasts` `uiDialogs` `uiPanels` `uiToolbar` `uiStatus` `uiNotifications` `uiOverlays` ·
ext: `lsp` `pluginManager` `pluginPackages` `hmr` `ptcRuntime` `typert` `typertGateway` `extensionPoints` `hookRegistry` ·
misc: `workflowEngine` `webhookRuntime` `jobs` `jobController` `schedule` `scheduler` `credentials` `secretStore` `otel` `telemetry` `metrics` `tracing` `logging` `audit` `permissions` `auth` `users` `teams` `shares` `comments` `notifications` `email` `calendar` `tasks` `kanban` `wiki` `docs` `search` `index` `embeddings` `vectors` `rag` `llmRouter` `llmFallback` `llmCache` `promptLibrary` `templateEngine` `render` `export` `import` `convert` `diff` `merge` `patch` `vcs` `git` `containers` `docker` `k8s` `cloud` `browser` `screenshot`

运行时查询：设置页显示实时覆盖数，或 IPC `dshCoverage()`。
