import type {
  AppSettings,
  AuditEntry,
  DomAdapter,
  FileNode,
  KnowledgeBase,
  MarketPlugin,
  McpServerConfig,
  McpToolInfo,
  MemoryEntry,
  InstalledPlugin,
  ProjectInfo,
  ProviderDescriptor,
  QuickCommand,
  Session,
  SessionMeta,
  SkillDraft,
  SkillMeta,
  SkillTrashItem,
  GitHubSkillInstallResult,
  ExternalSkillMeta,
  ExternalSkillImportResult,
  AgentMeta,
  RuleEntry,
  TaskItem,
  TaskPlan,
  ToolResult,
  StopLevel
} from './types'

/** renderer → main 可调用接口（preload contextBridge 实现同名方法） */
export interface WebAttachmentInfo {
  path: string
  name: string
  /** 图片附件的缩略预览（data URL）；非图片/过大文件没有 */
  preview?: string
}

export interface LidowApi {
  // 应用
  getAppState(): Promise<{
    projects: ProjectInfo[]
    activeProjectId: string | null
    settings: AppSettings
    version: string
  }>
  /** 内置 HTTP API 运行状态（桌面版按设置启停，Web 版常驻） */
  getApiStatus(): Promise<{
    mode: 'desktop' | 'web'
    running: boolean
    host: string
    port: number
    error: string
  }>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickDirectory(): Promise<string | null>
  openProject(root: string): Promise<ProjectInfo>
  /** 项目目录被删除/移动后，重新绑定到用户新选的目录（保留项目 id 与会话归属） */
  relocateProject(projectId: string, root: string): Promise<ProjectInfo>
  closeProject(projectId: string): Promise<void>
  /** 从项目列表移除（不删除磁盘文件）；可选同时删除网页端会话；当前项目需先切换走 */
  removeProject(
    projectId: string,
    deleteWebChats?: boolean
  ): Promise<{ removed: boolean; webDeleted: number; webFailed: number; message: string }>
  quit(): void

  // Provider / 账号
  listProviders(projectId: string): Promise<ProviderDescriptor[]>
  addProvider(
    desc: Omit<ProviderDescriptor, 'builtIn' | 'enabled' | 'accounts'>
  ): Promise<ProviderDescriptor>
  removeProvider(projectId: string, providerId: string): Promise<void>
  addAccount(projectId: string, providerId: string, label: string): Promise<ProviderDescriptor>
  switchAccount(
    projectId: string,
    providerId: string,
    accountId: string
  ): Promise<ProviderDescriptor>
  removeAccount(
    projectId: string,
    providerId: string,
    accountId: string
  ): Promise<ProviderDescriptor>
  updateProviderAdapter(
    projectId: string,
    providerId: string,
    adapter: ProviderDescriptor['adapter']
  ): Promise<ProviderDescriptor>

  // 会话
  listSessions(projectId: string, providerId?: string): Promise<SessionMeta[]>
  getSession(sessionId: string): Promise<Session | null>
  createSession(
    projectId: string,
    providerId: string,
    parentSessionId?: string,
    accountId?: string
  ): Promise<Session>
  /** 删除会话；默认同时删除网页端对话（deleteWebChat=false 只删本地） */
  deleteSession(
    sessionId: string,
    deleteWebChat?: boolean
  ): Promise<{ webDeleted?: boolean; message?: string }>
  /** 删除项目内所有 0 轮次会话（保留 keepSessionId），返回清理数 */
  cleanupEmptySessions(projectId: string, keepSessionId?: string): Promise<number>
  renameSession(sessionId: string, title: string): Promise<void>
  /** 纯净模式初始化：向网页端发送首条系统提示词，让新对话出现在平台侧栏 */
  startProjectSession(sessionId: string): Promise<boolean>
  /** Web 版：让服务端隐藏宿主打开/绑定该会话的网页 */
  hostAttachSession(sessionId: string): Promise<boolean>
  /** Web 版：导入平台 Cookie（浏览器 DevTools 的 Cookie 请求头或 JSON 数组） */
  importProviderCookies(
    providerId: string,
    cookieText: string,
    accountId?: string
  ): Promise<{ imported: number }>
  compactSession(sessionId: string): Promise<Session>

  // Agent 循环
  sendPrompt(sessionId: string, text: string): Promise<void>
  newChat(sessionId: string): Promise<void>
  stop(sessionId: string, level: StopLevel): Promise<void>
  confirmTool(callId: string, approved: boolean, rememberChoice?: boolean): Promise<void>
  /** 确认/放弃计划：第一个参数是会话 id（计划按会话存储） */
  confirmPlan(
    sessionId: string,
    approved: boolean,
    edits?: { id: string; title: string; detail: string }[]
  ): Promise<void>
  abortPlan(sessionId: string): Promise<void>

  // 工具/文件
  readFileTree(projectId: string, dir: string, depth: number): Promise<FileNode[]>
  readFileContent(projectId: string, relPath: string): Promise<string>
  openPathInSystem(path: string): Promise<void>

  // Skills / Agents / Rules
  listSkills(): Promise<SkillMeta[]>
  getSkillDir(scope: 'project' | 'user'): Promise<string>
  createSkill(input: SkillDraft): Promise<SkillMeta>
  updateSkill(path: string, input: SkillDraft): Promise<SkillMeta>
  setSkillEnabled(path: string, enabled: boolean): Promise<SkillMeta[]>
  trashSkill(path: string): Promise<SkillTrashItem>
  listSkillTrash(): Promise<SkillTrashItem[]>
  restoreSkillTrash(id: string): Promise<SkillTrashItem>
  purgeSkillTrash(id: string): Promise<void>
  installSkillsFromGitHub(
    url: string,
    scope: 'project' | 'user',
    category?: string
  ): Promise<GitHubSkillInstallResult>
  listExternalSkills(): Promise<ExternalSkillMeta[]>
  importExternalSkills(
    paths: string[],
    scope: 'project' | 'user',
    category?: string
  ): Promise<ExternalSkillImportResult>
  listAgents(): Promise<AgentMeta[]>
  listRules(): Promise<RuleEntry[]>
  readSkill(path: string): Promise<string>

  // 记忆
  listMemory(): Promise<MemoryEntry[]>
  addMemory(title: string, content: string, tags: string[]): Promise<MemoryEntry>
  deleteMemory(id: string): Promise<void>

  // MCP
  listMcpServers(): Promise<McpServerConfig[]>
  addMcpServer(cfg: McpServerConfig): Promise<McpServerConfig[]>
  removeMcpServer(name: string): Promise<McpServerConfig[]>
  listMcpTools(): Promise<McpToolInfo[]>

  // 插件
  listInstalledPlugins(): Promise<InstalledPlugin[]>
  /** 内置精选插件（本地直装，不依赖网络） */
  listBuiltinPlugins(): Promise<MarketPlugin[]>
  searchMarket(
    query: string,
    category?: string
  ): Promise<{ items: MarketPlugin[]; warning?: string }>
  installPlugin(id: string): Promise<InstalledPlugin[]>
  uninstallPlugin(id: string): Promise<InstalledPlugin[]>
  togglePlugin(id: string, enabled: boolean): Promise<InstalledPlugin[]>

  // DSH
  dshCoverage(): Promise<{ total: number; implemented: string[]; missing: string[] }>
  /** 服务端权威 token 消耗（按平台累计） */
  getTokenStats(): Promise<Record<string, number>>

  // 任务拆解
  getActivePlan(sessionId: string): Promise<TaskPlan | null>

  // 人机共用待办看板
  listTodos(): Promise<TaskItem[]>
  addTodo(title: string): Promise<TaskItem[]>
  setTodoStatus(id: string, status: TaskItem['status']): Promise<TaskItem[]>
  clearDoneTodos(): Promise<TaskItem[]>

  // 会话导出
  exportSession(sessionId: string): Promise<string>

  // 顶栏工具
  /** 在系统文件管理器中打开路径（项目根/导出目录） */
  revealPath(path: string): Promise<boolean>
  /** 用外部程序打开项目（explorer / vscode / pycharm / terminal） */
  openInApp(appId: string, target: string): Promise<boolean>
  /** 打开导出目录并返回路径 */
  openExportDir(): Promise<string>
  /** 内置终端：执行一条命令（独立于 AI，用户手动运行），返回输出 */
  runTerminal(
    command: string,
    cwd?: string
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }>
  /** 内置终端默认工作目录（当前项目根） */
  terminalCwd(): Promise<string>
  /** 已注册工具清单（内置 + MCP + 插件），供帮助面板展示 */
  listTools(): Promise<{ name: string; description: string }[]>
  /** 用系统浏览器打开外部链接 */
  openExternal(url: string): Promise<boolean>

  // 审计
  listAudit(sessionId?: string, limit?: number): Promise<AuditEntry[]>
  revertAudit(entryId: string): Promise<boolean>

  // 知识库
  listKnowledgeBases(): Promise<KnowledgeBase[]>
  addKnowledgeBase(name: string, root: string): Promise<KnowledgeBase>
  removeKnowledgeBase(id: string): Promise<void>
  searchKnowledge(
    kbId: string,
    query: string,
    limit?: number
  ): Promise<{ path: string; score: number; snippet: string }[]>

  // 快捷指令
  listQuickCommands(): Promise<QuickCommand[]>
  saveQuickCommand(cmd: QuickCommand): Promise<QuickCommand[]>
  deleteQuickCommand(id: string): Promise<QuickCommand[]>

  // 视图控制
  attachWebview(
    providerId: string,
    accountId: string
  ): Promise<{
    partition: string
    overlayPath: string
    home: string
    /** 该平台的 DOM 适配器：无会话场景也要下发，否则登录态轮询与引导都不工作 */
    adapter?: DomAdapter
  }>
  bindSession(sessionId: string, webContentsId: number): Promise<void>
  /** 切换会话后把页面落到该会话自己的对话（providerUrl 或新聊天） */
  landSession(sessionId: string): Promise<void>
  /** 无会话时下发 adapter 与项目目录（决定是否弹首次引导） */
  syncProjectToWebview(
    webContentsId: number,
    adapter?: DomAdapter,
    providerId?: string,
    accountId?: string
  ): Promise<boolean>
  setPureMode(on: boolean): Promise<void>
  /** 触发网页内交互（深度思考 / 智能搜索 / 上传文件） */
  overlayToggle(
    sessionId: string,
    kind: 'toggle-think' | 'toggle-search' | 'upload-file'
  ): Promise<boolean>
  /** 选择本机文件并附加到当前网页会话的输入区（桌面纯模式） */
  uploadWebFile(sessionId: string): Promise<{
    ok: boolean
    canceled?: boolean
    count?: number
    files?: WebAttachmentInfo[]
    message?: string
  }>
  /** 粘贴剪贴板里的图片：data URL 注入当前网页会话的输入区 */
  pasteWebImages(
    sessionId: string,
    images: string[]
  ): Promise<{ ok: boolean; count?: number; files?: WebAttachmentInfo[]; message?: string }>
  /** 按文案点击平台自带按钮（各平台底部功能不同） */
  overlayAction(sessionId: string, keywords: string[]): Promise<boolean>
  checkUpdate(
    manual?: boolean
  ): Promise<{ hasUpdate: boolean; version?: string; url?: string; portable?: boolean }>
  /** 当前更新状态（启动时自动检查的结果可能早于渲染层订阅） */
  getUpdateState(): Promise<UpdateState>
  /** 下载并安装更新（便携版打开 Releases 页） */
  downloadUpdate(): Promise<{ ok: boolean; message: string }>
  listTemplates(): Promise<{ id: string; name: string; description: string }[]>
  applyTemplate(templateId: string, root: string): Promise<void>
  pushToSync(text: string): Promise<void>

  // 窗口控制（自绘标题栏）
  windowMinimize(): void
  windowToggleMaximize(): Promise<boolean>
  windowClose(): void
  windowIsMaximized(): Promise<boolean>

  // 事件订阅（main → renderer）
  onEvent(cb: (event: LidowEvent) => void): () => void
}

/** 应用内更新状态：main 主动推送，渲染层据此显示提示与下载进度 */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  message?: string
  portable?: boolean
  /** 是否用户手动触发（自动检查失败不应弹提示） */
  manual?: boolean
}

export type LidowEvent =
  | { type: 'session-updated'; sessionId: string }
  | { type: 'update-state'; state: UpdateState }
  /** 项目初始化完成：询问是否切到纯净模式（可稍后从左侧栏进入） */
  | { type: 'ui-pure-suggestion'; sessionId: string; webContentsId?: number; providerId?: string }
  /** 网页侧会话标题变化（平台自动命名/用户重命名），只更新元数据，不清流式文本 */
  | { type: 'session-title'; sessionId: string; title: string }
  /** 仅发给服务端隐藏宿主渲染器：为 Web 客户端打开/绑定 provider 页面 */
  | { type: 'host-open-session'; sessionId: string }
  /** 网页侧点击了属于其他项目的对话：渲染层同步项目/会话 */
  | {
      type: 'web-session-activated'
      sessionId: string
      projectId: string
      providerId: string
      accountId?: string
    }
  /** 网页端对话被删除：渲染层移除对应会话（纯净模式列表同步） */
  | { type: 'session-deleted'; sessionId: string; title: string }
  /** 自动续接：任务已迁移到新会话，渲染层应把标签/活动会话切过去 */
  | { type: 'session-switched'; fromSessionId: string; sessionId: string }
  | { type: 'turn-chunk'; sessionId: string; turnId: string; text: string; tps?: number }
  | { type: 'tool-start'; sessionId: string; result: ToolResult }
  | {
      type: 'tool-confirm-required'
      sessionId: string
      result: ToolResult
      callId: string
      name: string
      input: Record<string, unknown>
      reason: string
    }
  | { type: 'plan-proposed'; sessionId: string; plan: TaskPlan }
  | { type: 'overlay-event'; providerId: string; event: unknown }
  | { type: 'ui-input'; sessionId: string; text: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'ui-panel'; panel: 'chat' | 'web'; open: boolean }
  | { type: 'think-chunk'; sessionId: string; think: string }
  | { type: 'ui-toggle-pure' }
  /** 全局热键：新建会话（渲染层按当前平台建会话） */
  | { type: 'ui-new-session' }
  | { type: 'toggle-state'; think: boolean; search: boolean }
  /** 项目列表变化（网页内首次引导完成初始化后需要刷新下拉与目录状态） */
  | { type: 'projects-changed'; sessionId: string }

export const IPC_INVOKE_PREFIX = 'lidow:'
export const IPC_EVENT = 'lidow:event'
export const IPC_OVERLAY = 'lidow:overlay'
export const IPC_OVERLAY_CMD = 'lidow:overlay-cmd'
