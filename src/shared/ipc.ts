import type {
  AppSettings,
  AuditEntry,
  FileNode,
  KnowledgeBase,
  MarketPlugin,
  McpServerConfig,
  McpToolInfo,
  MemoryEntry,
  PluginManifest,
  ProjectInfo,
  ProviderDescriptor,
  QuickCommand,
  Session,
  SessionMeta,
  SkillMeta,
  AgentMeta,
  RuleEntry,
  TaskPlan,
  ToolResult,
  StopLevel
} from './types'

/** renderer → main 可调用接口（preload contextBridge 实现同名方法） */
export interface LidowApi {
  // 应用
  getAppState(): Promise<{ projects: ProjectInfo[]; activeProjectId: string | null; settings: AppSettings; version: string }>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickDirectory(): Promise<string | null>
  openProject(root: string): Promise<ProjectInfo>
  closeProject(projectId: string): Promise<void>
  quit(): void

  // Provider / 账号
  listProviders(projectId: string): Promise<ProviderDescriptor[]>
  addProvider(desc: Omit<ProviderDescriptor, 'builtIn' | 'enabled' | 'accounts'>): Promise<ProviderDescriptor>
  removeProvider(projectId: string, providerId: string): Promise<void>
  addAccount(projectId: string, providerId: string, label: string): Promise<ProviderDescriptor>
  switchAccount(projectId: string, providerId: string, accountId: string): Promise<ProviderDescriptor>
  removeAccount(projectId: string, providerId: string, accountId: string): Promise<ProviderDescriptor>
  updateProviderAdapter(projectId: string, providerId: string, adapter: ProviderDescriptor['adapter']): Promise<ProviderDescriptor>

  // 会话
  listSessions(projectId: string, providerId?: string): Promise<SessionMeta[]>
  getSession(sessionId: string): Promise<Session | null>
  createSession(projectId: string, providerId: string, parentSessionId?: string): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  compactSession(sessionId: string): Promise<Session>

  // Agent 循环
  sendPrompt(sessionId: string, text: string): Promise<void>
  stop(level: StopLevel): Promise<void>
  confirmTool(callId: string, approved: boolean, rememberChoice?: boolean): Promise<void>
  confirmPlan(planId: string, approved: boolean, edits?: { id: string; title: string; detail: string }[]): Promise<void>
  abortPlan(planId: string): Promise<void>

  // 工具/文件
  readFileTree(projectId: string, dir: string, depth: number): Promise<FileNode[]>
  readFileContent(projectId: string, relPath: string): Promise<string>
  openPathInSystem(path: string): Promise<void>

  // Skills / Agents / Rules
  listSkills(): Promise<SkillMeta[]>
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
  listInstalledPlugins(): Promise<PluginManifest[]>
  searchMarket(query: string, category?: string): Promise<MarketPlugin[]>
  installPlugin(id: string): Promise<PluginManifest[]>
  uninstallPlugin(id: string): Promise<PluginManifest[]>
  togglePlugin(id: string, enabled: boolean): Promise<PluginManifest[]>

  // DSH
  dshCoverage(): Promise<{ total: number; implemented: string[]; missing: string[] }>

  // 任务拆解
  getActivePlan(sessionId: string): Promise<TaskPlan | null>

  // 审计
  listAudit(sessionId?: string, limit?: number): Promise<AuditEntry[]>
  revertAudit(entryId: string): Promise<boolean>

  // 知识库
  listKnowledgeBases(): Promise<KnowledgeBase[]>
  addKnowledgeBase(name: string, root: string): Promise<KnowledgeBase>
  removeKnowledgeBase(id: string): Promise<void>
  searchKnowledge(kbId: string, query: string, limit?: number): Promise<{ path: string; score: number; snippet: string }[]>

  // 快捷指令
  listQuickCommands(): Promise<QuickCommand[]>
  saveQuickCommand(cmd: QuickCommand): Promise<QuickCommand[]>
  deleteQuickCommand(id: string): Promise<QuickCommand[]>

  // 视图控制
  attachWebview(providerId: string, accountId: string): Promise<{ partition: string; overlayPath: string; home: string }>
  bindSession(sessionId: string, webContentsId: number): Promise<void>
  setPureMode(on: boolean): Promise<void>
  checkUpdate(): Promise<{ hasUpdate: boolean; version?: string; url?: string }>
  listTemplates(): Promise<{ id: string; name: string; description: string }[]>
  applyTemplate(templateId: string, root: string): Promise<void>
  pushToSync(text: string): Promise<void>

  // 事件订阅（main → renderer）
  onEvent(cb: (event: LidowEvent) => void): () => void
}

export type LidowEvent =
  | { type: 'session-updated'; sessionId: string }
  | { type: 'turn-chunk'; sessionId: string; turnId: string; text: string; tps?: number }
  | { type: 'tool-start'; sessionId: string; result: ToolResult }
  | { type: 'tool-confirm-required'; sessionId: string; result: ToolResult; callId: string; name: string; input: Record<string, unknown>; reason: string }
  | { type: 'plan-proposed'; sessionId: string; plan: TaskPlan }
  | { type: 'overlay-event'; providerId: string; event: unknown }
  | { type: 'ui-input'; sessionId: string; text: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }

export const IPC_INVOKE_PREFIX = 'lidow:'
export const IPC_EVENT = 'lidow:event'
export const IPC_OVERLAY = 'lidow:overlay'
export const IPC_OVERLAY_CMD = 'lidow:overlay-cmd'
