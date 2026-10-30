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
  /** 一句话摘要（文件路径 / 命令 / URL），折叠列表里展示关键信息 */
  summary?: string
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
  /** 模型思考过程：默认折叠，只在展开时显示（提升为可查看的活动记录） */
  think?: string
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
  /**
   * 系统提示词是否已在这个网页对话里发过。
   * 网页版会保留同一对话的历史，每轮重复注入只会污染上下文。
   */
  systemPromptSent?: boolean
  archived?: boolean
  /**
   * 平台侧对话 URL（如 DeepSeek 的 /a/chat/s/<uuid>）。
   * 换绑 webview 时导航回它 —— 没有这个映射，子代理跑完后页面停在
   * 子代理的对话里，父会话后续消息会发进错误的上下文。
   */
  providerUrl?: string
  /** 用户手动命名过：网页自动标题不再覆盖 */
  titleLocked?: boolean
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
  /** 运行时检测：项目根目录已不存在（不写入 projects.json，启动时重新计算） */
  missing?: boolean
  /** 运行时统计：该项目已关联的网页版对话数量（用于移除项目的清理提示） */
  webChatCount?: number
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
  /**
   * 输入框下方的平台自带功能（纯净模式底栏按平台渲染）。
   * 每个平台不一样：DeepSeek 是「深度思考/智能搜索」，豆包是「对话/项目/技能/快速」。
   * keywords 用于在网页里定位那个按钮（点击时转发）。
   */
  composerActions?: { label: string; keywords: string[] }[]
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
  /** 分类目录（.lidow/skills/<category>/<name>/SKILL.md） */
  category?: string
  /** 关闭后仍保留文件，但不进入 AI 摘要和斜杠菜单 */
  enabled?: boolean
}

export interface SkillDraft {
  name: string
  description: string
  body: string
  scope: 'project' | 'user'
  category?: string
}

export interface SkillTrashItem {
  id: string
  name: string
  description: string
  scope: 'project' | 'user'
  /** 原技能目录/文件路径 */
  path: string
  trashPath: string
  category?: string
  deletedAt: number
}

export interface GitHubSkillInstallResult {
  repo: string
  installed: { name: string; path: string }[]
  skipped: string[]
}

/** 其他 Agent/CLI 已有技能（只读扫描，导入后复制到 Lidow） */
export interface ExternalSkillMeta {
  name: string
  description: string
  source: string
  sourceId: string
  path: string
  category?: string
}

export interface ExternalSkillImportResult {
  imported: { name: string; path: string }[]
  skipped: string[]
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
  /** builtin = 内置精选（本地直装，不走网络） */
  source: 'github' | 'gitee' | 'builtin'
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

export type ThemeMode = 'light' | 'dark' | 'midnight' | 'graphite' | 'system'
export type StopLevel = 'generate' | 'tool' | 'auto-loop' | 'all'

export interface AppSettings {
  theme: ThemeMode
  accent: string
  /** 鲸鱼娘桌宠（素材来自 dsh-pet，可拖动/点击互动） */
  desktopPet: boolean
  language: 'zh-CN' | 'en-US'
  pureMode: boolean
  dangerConfirm: boolean
  /** 删除保护：文件先移入系统回收站/废纸篓（失败时回退到项目 .lidow/trash） */
  deleteProtection: boolean
  /** 单个任务删除达到该数量时，执行前统一审批 */
  batchDeleteThreshold: number
  /** Lidow 连续向同一个 AI 网页发送消息的最小间隔（毫秒） */
  webSendIntervalMs: number
  /**
   * 权限模式（对齐 ZCode 的四档）：
   *  - plan      ：编辑前先出计划，用户确认后才动
   *  - ask       ：改文件/执行命令前都问
   *  - autonomous：只在有风险时问
   *  - full      ：减少确认次数（危险命令仍拦）
   */
  permissionMode: 'plan' | 'ask' | 'autonomous' | 'full'
  ssrfProtection: boolean
  commandTimeoutMs: number
  sandboxTimeoutMs: number
  outputBufferLimit: number
  /** 自动压缩阈值（字符数） */
  compactThreshold: number
  autoCompact: boolean
  /** 每轮重复注入系统提示词（默认关闭：只在初始化/新会话首条消息发一次） */
  injectSystemPromptEveryTurn: boolean
  /** 看门狗：SSE 流静默超过该毫秒数判定卡住，自动发「请继续」催 AI */
  watchdog: {
    enabled: boolean
    /** 静默阈值（毫秒） */
    idleMs: number
    /** 最大催次数；负数=不限 */
    maxRetries: number
    /** 催继续用的提示词 */
    prompt: string
  }
  /** 失败自动重试 */
  retry: {
    enabled: boolean
    /** 首次重试延迟（毫秒），逐次翻倍 */
    delayMinMs: number
    /** 延迟上限（毫秒） */
    delayMaxMs: number
    /** 普通失败最大重试次数；负数=不限 */
    maxRetries: number
    /** 429 限流专用等待（毫秒）与次数 */
    delay429Ms: number
    maxRetries429: number
    /** 重试时发回给 AI 的提示词 */
    prompt: string
  }
  /** 上下文耗尽后自动续接：把摘要带到新会话继续 */
  autoContinue: {
    enabled: boolean
    /** 续接时附加的交接提示词 */
    handoffPrompt: string
  }
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

/** 网页侧项目文件夹：项目 → 已建过网页对话的会话 */
export interface ProjectFolderChat {
  sessionId: string
  title: string
  url: string
}

export interface ProjectFolderProject {
  id: string
  name: string
  root: string
  chats: ProjectFolderChat[]
}

export interface ProjectFolderData {
  projects: ProjectFolderProject[]
  activeProjectId: string | null
}

export interface OverlayCommand {
  kind:
    | 'send'
    | 'new-chat'
    | 'extract'
    | 'get-input'
    | 'set-input'
    | 'clear'
    | 'stop'
    | 'configure'
    | 'set-project'
    | 'tool-mask'
    | 'reset-first-run'
    | 'toggle-think'
    | 'toggle-search'
    | 'upload-file'
    | 'click-keywords'
    | 'watch-chats'
    | 'project-folders'
    | 'open-chat'
  text?: string
  /** open-chat：要切换到的对话 URL */
  url?: string
  /** watch-chats：当前项目下需要监听“网页侧是否被删除”的对话 URL */
  urls?: string[]
  /** project-folders：网页侧项目文件夹数据（DeepSeek 侧栏） */
  folders?: ProjectFolderData
  /** configure：下发当前 provider 的 DOM 适配器 */
  adapter?: DomAdapter
  /** configure：网络层 hook 源码（注入主世界，拦截 SSE 获取回复，不依赖 DOM） */
  hookSource?: string
  /**
   * set-project：当前项目目录（null/空 = 未初始化）。
   * 网页侧据此决定是否显示「初始化项目」引导浮窗 ——
   * 与 cuckoo 的 first-time-dialog 同款：引导必须出现在用户准备开口的
   * 那个输入框附近，而不是我们自己的侧栏菜单里。
   */
  projectRoot?: string | null
  /** set-project：当前会话/项目是否已有对话记录（已初始化则不再弹首次引导） */
  initialized?: boolean
  /** tool-mask：是否显示「工具执行中」遮罩（cuckoo 同款，防止执行期间乱点页面） */
  show?: boolean
  /** click-keywords：要在页面里点击的按钮文案候选（平台功能各不相同） */
  keywords?: string[]
}

export type OverlayEvent =
  | { type: 'ready' }
  | { type: 'nav'; url: string; title?: string }
  | { type: 'login-state'; loggedIn: boolean }
  | { type: 'stream-start' }
  | { type: 'stream-chunk'; text: string }
  | { type: 'stream-end'; text: string }
  /** DOM 仍在生成但没有新文本（思考/停顿）：重置看门狗与截断宽限，避免误判卡死 */
  | { type: 'stream-heartbeat' }
  | { type: 'send-result'; ok: boolean; error?: string }
  | { type: 'float-menu-action'; action: string; url?: string }
  /** 网页开关状态（深度思考 / 智能搜索）——chip 高亮用 */
  | { type: 'toggle-state'; think: boolean; search: boolean }
  /** 网络层 hook：流式增量（token 级，来自 SSE 原始帧） */
  | { type: 'net-stream'; text: string; think?: string; finished: boolean }
  /** 网络层 hook：一轮回复完整结束（status 区分 stopped/error/finished） */
  | { type: 'net-response'; text: string; status: 'finished' | 'stopped' | 'error'; reason?: string; tokens?: number }
  /** 网络层 hook：请求失败 */
  | { type: 'net-error'; text: string; reason: string }
  /** 用户在网页输入框里亲手发送的消息（纯净模式同步用） */
  | { type: 'user-message'; text: string }
  /** 页面重挂载后的最后一条 AI 回答（重启/重载后补齐缺失的最终答复） */
  | { type: 'page-snapshot'; text: string }
  /** 网页侧用户删除了对话：主进程据此同步移除本地会话 */
  | { type: 'chat-deleted'; url: string }
  /** 用户点击网页侧项目对话：主进程切换到对应 Lidow 项目/会话 */
  | { type: 'activate-chat'; url: string }
  /** 程序化 SPA 切换对话的结果（找不到侧栏链接时主进程回退 loadURL） */
  | { type: 'open-chat-result'; ok: boolean }
