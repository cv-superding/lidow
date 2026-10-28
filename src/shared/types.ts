/** Lidow 核心数据模型 — main / preload / renderer 三端共享 */

export type Role = 'user' | 'assistant' | 'tool' | 'system'

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'error'

/** 工具调用（AI 产出） */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具展示卡片类型：diff / 终端 / 表格 / 富文本 */
export type ToolDisplay =
  | { kind: 'diff'; path: string; patch: string }
  | { kind: 'terminal'; cmd: string; cwd: string; exitCode: number | null; output: string }
  | { kind: 'table'; columns: string[]; rows: string[][]; rowCount: number }
  | { kind: 'files'; pattern: string; files: string[]; truncated: boolean }
  | { kind: 'text'; text: string }

export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  /** 回传给 AI 的观察结果文本 */
  output: string
  /** 渲染端可视化卡片（不回传 AI） */
  display?: ToolDisplay
  durationMs: number
  error?: string
}

export interface ChatTurn {
  id: string
  role: Role
  text: string
  ts: number
  status: TurnStatus
  toolResults?: ToolResult[]
  /** 生成速度 tokens/s（近似：按字符/4） */
  tps?: number
}

export interface SessionMeta {
  id: string
  projectId: string
  title: string
  providerId: string
  accountId?: string
  createdAt: number
  updatedAt: number
  /** 会话血缘：由哪个会话派生 */
  parentSessionId?: string
  /** 已压缩轮次数量（这些轮次已被摘要替代） */
  compactedTurns: number
  archived?: boolean
}

export interface Session extends SessionMeta {
  turns: ChatTurn[]
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  createdAt: number
  lastOpenedAt: number
}

// ---------- Provider ----------

/** 各平台 DOM 适配器：候选选择器列表，命中即用；全部失效时用户可在设置中编辑 */
export interface DomAdapter {
  /** 聊天输入框 */
  input: string[]
  /** 发送按钮（找不到则回退模拟 Enter） */
  send: string[]
  /** 消息容器 */
  messages: string[]
  /** 单条消息气泡（相对容器） */
  bubble: string[]
  /** 流式生成中的标志（存在=仍在生成；通常为停止按钮） */
  streamingFlag: string[]
  /** 新建会话按钮 */
  newChat: string[]
  /** 已登录标志（存在=已登录） */
  loginFlag: string[]
}

export interface ProviderAccount {
  id: string
  label: string
  /** Electron partition 名，一个账号一个独立 session 持久化登录态 */
  partition: string
}

export interface ProviderDescriptor {
  id: string
  name: string
  home: string
  adapter: DomAdapter
  builtIn: boolean
  enabled: boolean
  accounts: ProviderAccount[]
  activeAccountId?: string
}

// ---------- Prompt 体系 ----------

export interface SkillMeta {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  body?: string
}

export interface AgentMeta {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  body?: string
}

export interface RuleEntry {
  name: string
  scope: 'project' | 'user'
  path: string
  content: string
}

export interface MemoryEntry {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  /** 来源：AI remember 工具 / 手动 / 正文标记 */
  source: 'ai' | 'manual' | 'marker'
}

// ---------- 任务拆解 ----------

export interface TaskItem {
  id: string
  title: string
  detail: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  createdAt: number
}

export interface TaskPlan {
  id: string
  sessionId: string
  goal: string
  items: TaskItem[]
  status: 'draft' | 'confirmed' | 'running' | 'done' | 'aborted'
  createdAt: number
}

// ---------- 审计 ----------

export interface AuditEntry {
  id: string
  ts: number
  sessionId: string
  kind: 'file-write' | 'file-delete' | 'command' | 'tool'
  summary: string
  detail: Record<string, unknown>
  /** 文件类操作可回滚的备份路径 */
  backupPath?: string
  reverted?: boolean
}

// ---------- 插件 ----------

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  category?: string
  /** 打包内容：技能/代理/规则/MCP/自定义平台/网页脚本/DSH 服务 */
  provides?: string[]
  entry?: string
  dsh?: string
  platform?: string
  webScript?: string
}

export interface InstalledPlugin extends PluginManifest {
  installedAt: number
  enabled: boolean
  dir: string
}

export interface MarketPlugin {
  id: string
  name: string
  description: string
  version: string
  author: string
  stars?: number
  category?: string
  repoUrl: string
  source: 'github' | 'gitee'
  installed?: boolean
}

// ---------- MCP ----------

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
}

// ---------- 应用 ----------

export type ThemeMode = 'light' | 'dark' | 'midnight' | 'warm' | 'system'
export type StopLevel = 'generate' | 'tool' | 'auto-loop' | 'all'

export interface AppSettings {
  theme: ThemeMode
  accent: string
  language: 'zh-CN' | 'en-US'
  pureMode: boolean
  dangerConfirm: boolean
  ssrfProtection: boolean
  commandTimeoutMs: number
  sandboxTimeoutMs: number
  outputBufferLimit: number
  /** 自动压缩阈值（字符数） */
  compactThreshold: number
  autoCompact: boolean
  globalHotkeys: Record<string, string>
  securityMod: {
    enabled: boolean
    ctfInject: boolean
    refusalRewrite: 'off' | 'local' | 'api'
    rewriteApi?: string
    maxRewrites: number
    /** AI 回复拦截：自定义正则列表（每行一条，任意命中即拦截，不再执行工具） */
    customPatterns?: string[]
    /** 拦截后的提示语 */
    customNotice?: string
  }
  sync: {
    feishu?: { webhookUrl: string; enabled: boolean }
    wecom?: { webhookUrl: string; enabled: boolean }
    dingtalk?: { webhookUrl: string; enabled: boolean }
  }
}

export interface KnowledgeBase {
  id: string
  name: string
  root: string
  enabled: boolean
  fileCount: number
}

export interface QuickCommand {
  id: string
  name: string
  /** 触发词（斜杠菜单） */
  trigger: string
  /** 发送给 AI 的提示词模板，{{input}} 占位 */
  template: string
  enabled: boolean
}

export interface FileNode {
  path: string
  name: string
  type: 'dir' | 'file'
  children?: FileNode[]
}

export interface OverlayCommand {
  kind: 'send' | 'new-chat' | 'extract' | 'get-input' | 'set-input' | 'clear' | 'stop' | 'configure'
  text?: string
  /** configure：下发当前 provider 的 DOM 适配器 */
  adapter?: DomAdapter
  /** configure：网络层 hook 源码（注入主世界，拦截 SSE 获取回复，不依赖 DOM） */
  hookSource?: string
}

export type OverlayEvent =
  | { type: 'ready' }
  | { type: 'nav'; url: string }
  | { type: 'login-state'; loggedIn: boolean }
  | { type: 'stream-start' }
  | { type: 'stream-chunk'; text: string }
  | { type: 'stream-end'; text: string }
  | { type: 'send-result'; ok: boolean; error?: string }
  | { type: 'float-menu-action'; action: string }
  /** 网络层 hook：流式增量（token 级，来自 SSE 原始帧） */
  | { type: 'net-stream'; text: string; think?: string; finished: boolean }
  /** 网络层 hook：一轮回复完整结束（status 区分 stopped/error/finished） */
  | { type: 'net-response'; text: string; status: 'finished' | 'stopped' | 'error'; tokens?: number }
  /** 网络层 hook：请求失败 */
  | { type: 'net-error'; text: string; reason: string }
