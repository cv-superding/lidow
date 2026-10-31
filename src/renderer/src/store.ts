import { create } from 'zustand'
import { api } from './api'
import { waitWebviewWcId, webviewWcId } from './webviews'
import type { LidowEvent, UpdateState } from '@shared/ipc'
import type {
  AppSettings,
  DomAdapter,
  McpToolInfo,
  MemoryEntry,
  InstalledPlugin,
  ProjectInfo,
  ProviderDescriptor,
  Session,
  SessionMeta,
  SkillMeta,
  AgentMeta,
  RuleEntry,
  TaskPlan,
  TaskItem,
  QuickCommand,
  KnowledgeBase,
  AuditEntry,
  MarketPlugin,
  McpServerConfig
} from '@shared/types'

/** 右侧工具侧栏的面板（对齐 Qoder：文件 / 任务 / 终端 / 审阅） */
export type AuxPanel = 'files' | 'tasks' | 'terminal' | 'review'

/**
 * Web 版（Docker 原生网页界面）：浏览器里没有 Electron webview，
 * provider 页面由服务端隐藏宿主负责创建/绑定，这里只跑会话与对话 UI。
 */
export const WEB_MODE =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { __LIDOW_WEB__?: boolean }).__LIDOW_WEB__ === true)

/** 审阅面板里的单个文件改动 */
export interface ReviewFile {
  path: string
  patch: string
  add: number
  del: number
}

export interface SessionDeleteRequest {
  id: string
  title: string
  providerId: string
  providerName: string
  /** 是否已有关联网页端对话（没有时只删本地） */
  hasWebChat: boolean
}

export type ViewId =
  | 'home'
  | 'projects'
  | 'sessions'
  | 'files'
  | 'tasks'
  | 'skills'
  | 'agents'
  | 'mcp'
  | 'plugins'
  | 'quick'
  | 'memory'
  | 'knowledge'
  | 'audit'
  | 'settings'

/**
 * 内置平台在「没有显式建账号」时，登录态落在 persist:lidow-<id>-default。
 * 这个隐式账号也要能在多开菜单里被选中，否则已登录的默认分区永远无法复用。
 */
export const DEFAULT_ACCOUNT_ID = '__default__'

/** 归一化账号 id：'' 与 '__default__' 指向同一个默认分区 */
export function accountKeyOf(accountId?: string): string {
  return !accountId || accountId === DEFAULT_ACCOUNT_ID ? '' : accountId
}

/** 统一的项目解析：与 main 的 activeProjectId 对齐（修多项目时取错 projects[0]） */
export function useProject(s: LidowState): ProjectInfo | null {
  // 只认 activeProjectId；不兜底 projects[0] —— 静默落到别的项目会导致
  // 会话建错位置（用户视角是"绑不上/网页未连接"），宁可返回 null 走建项目流程。
  return s.projects.find((p) => p.id === s.activeProjectId) ?? null
}

interface WebTab {
  id: string
  providerId: string
  providerName: string
  /** '' = 隐式默认账号分区，'__default__' = 显式选择默认账号 */
  accountId: string
  /** 账号显示名（多账号时标签上区分） */
  accountName?: string
  partition: string
  overlayPath: string
  home: string
  sessionId: string
  /** webview attach 后记录的 webContentsId（重绑会话时必需） */
  wcId?: number
  /** 无会话时也要下发的平台适配器（登录态轮询与首次引导都依赖它） */
  adapter?: DomAdapter
  connected: boolean
  loggedIn: boolean
}

interface LidowState {
  booted: boolean
  version: string
  settings: AppSettings
  projects: ProjectInfo[]
  /** 当前项目（与 main 的 activeProjectId 对齐，避免多项目时读错会话列表） */
  activeProjectId: string | null
  providers: ProviderDescriptor[]
  sessions: SessionMeta[]
  activeSession: Session | null
  tabs: WebTab[]
  activeTabId: string | null
  view: ViewId
  /** 打开设置页时要定位的分组（添加平台入口用），消费后清空 */
  settingsSection: string | null
  requestSettings(section?: string): void
  rightOpen: boolean
  /** 纯净模式侧栏宽度（拖拽分隔线调整，持久化到 localStorage） */
  sidebarWidth: number
  setSidebarWidth(w: number): void
  /** 工作台左栏是否为展开态（悬停展开 / 拖拽后固定） */
  railPinned: boolean
  setRailPinned(v: boolean): void
  /** 右侧工具侧栏当前面板；null = 收起 */
  auxPanel: AuxPanel | null
  auxWidth: number
  openAux(panel: AuxPanel): void
  toggleAux(panel: AuxPanel): void
  closeAux(): void
  setAuxWidth(w: number): void
  pureMode: boolean
  /** 纯净模式主区当前面板（home=网页对话；其余为该面板视图），不改变 pureMode */
  pureView: ViewId
  /** 项目初始化完成后的「是否进入纯净模式」建议弹窗 */
  pureSuggestion: boolean
  /** 删除会话确认：本地与网页端一起删除 */
  sessionDelete: SessionDeleteRequest | null
  streamingText: string
  streamingTps: number
  /** 当前流式回复的思考过程（折叠块显示，结束时清空） */
  thinkingText: string
  /** 已发送、等待网页开始回复的会话（用于“正在思考”加载态） */
  pendingReplySessionId: string
  pendingSince: number
  confirmRequest: { callId: string; reason: string; sessionId?: string } | null
  plan: TaskPlan | null
  notices: { level: string; message: string; ts: number }[]
  /** 应用内更新状态（main 自动检查 + 下载进度） */
  updateState: UpdateState
  /** 用户点「稍后」隐藏的版本（本次运行内不再主动弹） */
  updateDismissedVersion: string
  skills: SkillMeta[]
  agents: AgentMeta[]
  rules: RuleEntry[]
  memoryList: MemoryEntry[]
  mcpServers: McpServerConfig[]
  mcpTools: McpToolInfo[]
  installedPlugins: InstalledPlugin[]
  /** 网页开关状态（深度思考 / 智能搜索），由 overlay 轮询上报 */
  toggleState: {
    think: boolean
    search: boolean
    thinkAvailable: boolean
    searchAvailable: boolean
  }
  marketResults: MarketPlugin[]
  /** 市场搜索失败原因（网络不通等），空态时必须可见而不是无声无息 */
  marketWarning: string
  /** 内置精选插件（本地直装） */
  builtinPlugins: MarketPlugin[]
  kbs: KnowledgeBase[]
  audits: AuditEntry[]
  quickCmds: QuickCommand[]
  todos: TaskItem[]
  fileTree: Awaited<ReturnType<typeof api.readFileTree>>
  selectedFile: {
    path: string
    content: string
    kind?: 'text' | 'image' | 'pdf' | 'html' | 'binary'
    dataUrl?: string
    mime?: string
    size?: number
  } | null
  /** 右栏审阅：当前任务的 diff 文件列表 */
  reviewFiles: ReviewFile[]
  reviewActivePath: string
  openReview(files: ReviewFile[]): void
  setReviewFile(path: string): void

  boot(): Promise<void>
  setView(v: ViewId): void
  toggleRight(): void
  setPure(on: boolean): void
  setPureView(v: ViewId): void
  dismissPureSuggestion(): void
  requestSessionDelete(s: SessionMeta): void
  cancelSessionDelete(): void
  performSessionDelete(): Promise<void>
  applyTheme(s: AppSettings): void
  openProject(root: string): Promise<void>
  refreshProviders(): Promise<void>
  refreshSessions(): Promise<void>
  createSession(providerId: string, accountId?: string): Promise<void>
  openSession(id: string): Promise<void>
  openProviderTab(providerId: string, sessionId?: string, accountId?: string): Promise<void>
  closeTab(id: string): void
  setActiveTab(id: string): void
  bindTabSession(tabId: string, sessionId: string, webContentsId: number): Promise<void>
  setTabWcId(tabId: string, wcId: number): void
  sendPrompt(text: string): Promise<void>
  stop(level: 'generate' | 'tool' | 'auto-loop' | 'all'): Promise<void>
  answerConfirm(ok: boolean): Promise<void>
  notice(message: string, level?: 'info' | 'warn' | 'error'): void
  scheduleNoticeRemoval(ts: number): void
  checkUpdate(manual?: boolean): Promise<void>
  downloadUpdate(): Promise<void>
  dismissUpdate(): void
  refreshAll(): Promise<void>
  handleEvent(e: LidowEvent): void
}

/** boot 进行中的 promise：并发/重复调用共享同一次（防监听器重复注册） */
let bootPromise: Promise<void> | null = null
/** 会话/标签切换序号：异步 getSession 返回时用来丢弃过期响应 */
let sessionSeq = 0

export const useStore = create<LidowState>((set, get) => ({
  booted: false,
  version: '',
  settings: {
    theme: 'dark',
    accent: '#8dff4f',
    desktopPet: true,
    language: 'zh-CN',
    pureMode: false,
    dangerConfirm: true,
    deleteProtection: true,
    batchDeleteThreshold: 200,
    webSendIntervalMs: 1000,
    apiServer: { enabled: false, host: '127.0.0.1', port: 6080, token: '' },
    permissionMode: 'autonomous',
    ssrfProtection: true,
    commandTimeoutMs: 30000,
    sandboxTimeoutMs: 60000,
    outputBufferLimit: 1048576,
    compactThreshold: 600000,
    autoCompact: true,
    injectSystemPromptEveryTurn: false,
    watchdog: { enabled: true, idleMs: 90000, maxRetries: 3, prompt: '请继续' },
    retry: {
      enabled: true,
      delayMinMs: 4000,
      delayMaxMs: 10000,
      maxRetries: 10,
      delay429Ms: 120000,
      maxRetries429: 40,
      prompt:
        '刚才的回复被平台中断了。请从中断处继续输出剩余内容，不要从头重写；' +
        '如果内容已经完整，请直接给出最终收尾摘要。'
    },
    autoContinue: { enabled: false, handoffPrompt: '' },
    globalHotkeys: {},
    securityMod: { enabled: true, ctfInject: false, refusalRewrite: 'off', maxRewrites: 2 },
    sync: {}
  },
  projects: [],
  activeProjectId: null,
  providers: [],
  sessions: [],
  activeSession: null,
  tabs: [],
  activeTabId: null,
  view: 'home',
  settingsSection: null,
  rightOpen: true,
  // 记住上次拖拽的侧栏宽度（localStorage 读不到时用默认 268）
  sidebarWidth: (() => {
    try {
      const raw = Number(window.localStorage.getItem('lidow:sidebarWidth'))
      return Number.isFinite(raw) && raw >= 200 && raw <= 520 ? raw : 268
    } catch {
      return 268
    }
  })(),
  railPinned: false,
  auxPanel: null,
  auxWidth: (() => {
    try {
      const raw = Number(window.localStorage.getItem('lidow:auxWidth'))
      return Number.isFinite(raw) && raw >= 280 && raw <= 620 ? raw : 340
    } catch {
      return 340
    }
  })(),
  pureMode: false,
  pureView: 'home',
  pureSuggestion: false,
  sessionDelete: null,
  streamingText: '',
  streamingTps: 0,
  thinkingText: '',
  pendingReplySessionId: '',
  pendingSince: 0,
  confirmRequest: null,
  plan: null,
  notices: [],
  updateState: { phase: 'idle' },
  updateDismissedVersion: '',
  skills: [],
  agents: [],
  rules: [],
  memoryList: [],
  mcpServers: [],
  mcpTools: [],
  installedPlugins: [],
  toggleState: { think: false, search: false, thinkAvailable: false, searchAvailable: false },
  marketResults: [],
  marketWarning: '',
  builtinPlugins: [],
  kbs: [],
  audits: [],
  quickCmds: [],
  todos: [],
  fileTree: [],
  selectedFile: null,
  reviewFiles: [],
  reviewActivePath: '',

  async boot() {
    // 幂等：React StrictMode 会让 effect 跑两次，重复注册监听器会导致
    // 每条事件被处理多遍（实测：右下角同一条通知出现两次）
    if (get().booted || bootPromise) return
    bootPromise = (async () => {
      const state = await api.getAppState()
      set({
        booted: true,
        version: state.version,
        settings: state.settings,
        // 启动默认回工作台平台选择页，不自动继承上次的纯净模式/管理页
        pureMode: false,
        pureView: 'home',
        view: 'home',
        tabs: [],
        activeTabId: null,
        activeSession: null,
        projects: state.projects,
        activeProjectId: state.activeProjectId
      })
      get().applyTheme(state.settings)
      api.onEvent((e) => get().handleEvent(e))
      // main 的自动检查可能早于本窗口订阅：补拉一次当前状态
      void api
        .getUpdateState()
        .then((u) => set({ updateState: u }))
        .catch(() => undefined)
      // 启动即加载快捷指令：此前只有访问「快捷指令」管理页后才写进 store，
      // 直接进纯净模式输入 / 看不到已保存的自定义指令。
      void api
        .listQuickCommands()
        .then((c) => set({ quickCmds: c }))
        .catch(() => undefined)
      if (state.projects.length > 0) {
        await get().refreshProviders()
        await get().refreshSessions()
      } else {
        // 没有项目也要有平台列表：空态里要能选平台先进 AI 页面，
        // 初始化引导由 overlay 注入在网页里（cuckoo 同款）
        await get().refreshProviders()
      }
    })()
    try {
      await bootPromise
    } catch (e) {
      // 不能把已 reject 的 promise 留在 bootPromise 里：否则后续 boot() 直接 return，
      // 应用会永久停在「正在启动…」。这里复位并放行渲染，让用户至少能操作/重试。
      bootPromise = null
      set({ booted: true })
      get().notice(`启动失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  },

  setView(v) {
    set({ view: v, rightOpen: v === 'home' ? get().rightOpen : false })
  },
  requestSettings(section) {
    set({ view: 'settings', settingsSection: section ?? 'appearance' })
  },
  toggleRight() {
    set({ rightOpen: !get().rightOpen })
  },
  openAux(panel) {
    set({ auxPanel: panel })
  },
  toggleAux(panel) {
    set({ auxPanel: get().auxPanel === panel ? null : panel })
  },
  closeAux() {
    set({ auxPanel: null })
  },
  setAuxWidth(w) {
    const next = Math.min(620, Math.max(280, Math.round(w)))
    set({ auxWidth: next })
    try {
      window.localStorage.setItem('lidow:auxWidth', String(next))
    } catch {
      /* 隐私模式忽略 */
    }
  },
  openReview(files) {
    if (files.length === 0) return
    set({ auxPanel: 'review', reviewFiles: files, reviewActivePath: files[0]!.path })
  },
  setReviewFile(path) {
    set({ reviewActivePath: path })
  },
  setSidebarWidth(w) {
    const next = Math.min(520, Math.max(200, Math.round(w)))
    set({ sidebarWidth: next })
    try {
      window.localStorage.setItem('lidow:sidebarWidth', String(next))
    } catch {
      /* 隐私模式忽略 */
    }
  },
  setRailPinned(v) {
    set({ railPinned: v })
  },
  setPureView(v) {
    set({ pureView: v })
  },
  dismissPureSuggestion() {
    set({ pureSuggestion: false })
  },
  requestSessionDelete(s) {
    const providerName = get().providers.find((p) => p.id === s.providerId)?.name ?? s.providerId
    set({
      sessionDelete: {
        id: s.id,
        title: s.title,
        providerId: s.providerId,
        providerName,
        hasWebChat: Boolean(s.providerUrl)
      }
    })
  },
  cancelSessionDelete() {
    set({ sessionDelete: null })
  },
  async performSessionDelete() {
    const req = get().sessionDelete
    if (!req) return
    set({ sessionDelete: null })
    get().notice(req.hasWebChat ? '正在删除会话并同步网页端…' : '正在删除本地会话…')
    try {
      const res = await api.deleteSession(req.id, true)
      set((st) => ({
        ...(st.activeSession?.id === req.id
          ? {
              activeSession: null,
              plan: null,
              streamingText: '',
              streamingTps: 0,
              thinkingText: '',
              pendingReplySessionId: '',
              confirmRequest: null
            }
          : {}),
        tabs: st.tabs.map((t) => (t.sessionId === req.id ? { ...t, sessionId: '' } : t))
      }))
      await get().refreshSessions()
      get().notice(
        res.message ?? '会话已删除',
        res.webDeleted === false && req.hasWebChat ? 'warn' : 'info'
      )
    } catch (e) {
      get().notice(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  },
  setPure(on) {
    // 进入纯净模式时回到对话主区；同时关掉初始化后的模式建议弹窗
    set({ pureMode: on, pureView: on ? 'home' : get().pureView, pureSuggestion: false })
    void api.setPureMode(on)
    // 净模式进入时以「网页实际绑定的会话」为准：activeSession 可能落后于
    // 标签（自动续接/换绑后），直接用旧会话会打开错误的对话窗口。
    if (!on) return
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const providerId = tab?.providerId ?? s.activeSession?.providerId ?? s.providers[0]?.id
    if (!providerId) return
    // 标签没有绑定会话时，只能复用同平台的 activeSession，避免把 A 平台会话绑到 B 平台页面
    const fallbackId = tab
      ? s.activeSession?.providerId === providerId
        ? s.activeSession.id
        : ''
      : (s.activeSession?.id ?? '')
    const sessionId = tab?.sessionId || fallbackId
    // 确保有后台 webview 承载（webview 是对话驱动通道）
    void s.openProviderTab(providerId, sessionId, tab?.accountId ?? s.activeSession?.accountId)
    if (!sessionId) return
    // 拉全量 turns：store 里的会话可能只有元信息或落后于落盘内容
    void api
      .getSession(sessionId)
      .then((sess) => {
        if (!sess || !get().pureMode) return
        const cur = get().tabs.find((t) => t.id === get().activeTabId)
        if (cur?.sessionId && cur.sessionId !== sessionId) return // 期间又切了标签
        set({ activeSession: sess })
        // 进入纯净模式时网页可能还停在新建对话/别的对话：落到本会话的网页 URL，
        // 保证纯净窗口与网页窗口显示同一条对话（用户明确要求二者绑定）。
        if (sess.providerUrl) void api.landSession(sessionId).catch(() => undefined)
        void api
          .getActivePlan(sessionId)
          .then((plan) => {
            if (get().activeSession?.id === sessionId) set({ plan })
          })
          .catch(() => undefined)
      })
      .catch(() => undefined)
  },

  applyTheme(s) {
    const root = document.documentElement
    // 旧版 warm（暖沙米黄）已废弃：历史配置自动迁移到 graphite，避免继续看到发黄的界面
    const raw = s.theme === ('warm' as string) ? 'graphite' : s.theme
    const theme =
      raw === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : raw
    root.classList.remove('dark', 'light', 'midnight', 'graphite', 'warm')
    root.classList.add(theme)
    // 旧版默认荧光绿（#8dff4f）与新设计系统冲突：用户没主动改过的话，
    // 会一直把品牌色覆盖成刺眼的绿。仅对该历史默认值回落，自定义色保持不动。
    const legacyAccents = new Set(['#8dff4f', '#59d915', '#b8860b'])
    const accent = legacyAccents.has(s.accent?.toLowerCase?.() ?? '') ? '#4f6bed' : s.accent
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 86%, black)`)
  },

  async openProject(root) {
    const before = get().activeProjectId
    try {
      await api.openProject(root)
      const state = await api.getAppState()
      const changed = before !== state.activeProjectId
      sessionSeq++
      set((s) => ({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSession: null,
        sessions: [],
        plan: null,
        streamingText: '',
        streamingTps: 0,
        thinkingText: '',
        pendingReplySessionId: '',
        confirmRequest: null,
        reviewFiles: [],
        reviewActivePath: '',
        // 切项目后标签上还挂着旧项目的会话（主进程已统一解绑）：清掉 sessionId，
        // 让 WebviewTab 重新下发新项目的配置，避免初始化/发送复用旧会话。
        tabs: changed ? s.tabs.map((t) => ({ ...t, sessionId: '' })) : s.tabs
      }))
      await get().refreshProviders()
      await get().refreshSessions()
    } catch (e) {
      get().notice(`打开项目失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  },

  async refreshProviders() {
    const project = useProject(get())
    // 没有项目也拉一次：空态里要能选平台先进 AI 页面（引导在网页里弹），
    // 主进程对无 projectId 的请求返回内置平台表。
    set({ providers: await api.listProviders(project?.id ?? '') })
  },

  async refreshSessions() {
    const project = useProject(get())
    if (!project) return
    set({ sessions: await api.listSessions(project.id) })
  },

  async createSession(providerId, accountId) {
    const project = useProject(get())
    if (!project) {
      // 没有项目就没有工作目录，会话无法落盘、工具无根可执行。
      // 之前这里静默 return，用户点平台只看到网页、AI 也拿不到工具上下文。
      get().notice('请先初始化项目（选择工作目录），再开始对话', 'warn')
      return
    }
    if (project.missing) {
      get().notice('项目目录不存在，请到「工作区」重新选择目录', 'warn')
      return
    }
    // 优先用调用方给出的账号；否则沿用当前平台标签的账号（多账号下新建任务
    // 不应悄悄跳回默认账号的页面）。
    const activeTab = get().tabs.find((t) => t.id === get().activeTabId)
    const provider = get().providers.find((p) => p.id === providerId)
    let account = accountId
    if (account === undefined) {
      if (activeTab && activeTab.providerId === providerId) {
        // 沿用当前标签的账号；隐式默认分区必须存成 __default__，否则下次打开
        // 会因为 accounts[0] 已变成新账号而跳到未登录分区。
        account = activeTab.accountId || DEFAULT_ACCOUNT_ID
      } else {
        // 没有当前标签：用户选定的默认账号优先，否则最近活动账号/默认分区
        account =
          provider?.defaultAccountId ?? provider?.activeAccountId ?? DEFAULT_ACCOUNT_ID
      }
    }
    let s: Session
    try {
      s = await api.createSession(project.id, providerId, undefined, account)
    } catch (e) {
      get().notice(`创建会话失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      return
    }
    // 关键：新建后必须把新会话设为 activeSession，
    // 否则纯净模式发送时 activeSession 为 null（历史上导致每次点击都新建一个空会话）。
    set({
      activeSession: s,
      view: 'home',
      pureView: 'home',
      reviewFiles: [],
      reviewActivePath: '',
      streamingText: '',
      streamingTps: 0,
      thinkingText: '',
      pendingReplySessionId: '',
      confirmRequest: null
    })
    await get().refreshSessions()
    if (WEB_MODE) {
      const ok = await api.hostAttachSession(s.id)
      if (!ok) get().notice('服务端网页宿主未就绪，AI 页面可能还未打开', 'warn')
      return
    }
    await get().openProviderTab(providerId, s.id, account)
  },

  async openSession(id) {
    const seq = ++sessionSeq
    const [s, plan] = await Promise.all([
      api.getSession(id),
      api.getActivePlan(id).catch(() => null)
    ])
    if (seq !== sessionSeq) return // 期间用户又切了会话/标签/项目
    const same = get().activeSession?.id === id
    set({
      activeSession: s,
      view: 'home',
      pureView: 'home',
      rightOpen: true,
      plan,
      ...(same
        ? {}
        : {
            streamingText: '',
            streamingTps: 0,
            thinkingText: '',
            pendingReplySessionId: '',
            confirmRequest: null,
            reviewFiles: [],
            reviewActivePath: ''
          })
    })
    // 打开会话后立刻把承载网页绑定到该会话：
    // 否则纯净模式直接发送会报「网页未连接」（loop 找不到 channel）。
    if (s) {
      try {
        if (WEB_MODE) {
          await api.hostAttachSession(s.id)
        } else {
          // 旧会话没有 accountId 时按默认分区打开，不能落到 accounts[0] 的新账号
          await get().openProviderTab(s.providerId, s.id, s.accountId ?? DEFAULT_ACCOUNT_ID)
        }
        // 网页可能停在新对话/别的对话：切回会话时强制落到它自己的平台 URL，
        // 否则纯净模式显示的是这条会话，网页窗口却是另一条（实测元宝脱钩）。
        if (s.providerUrl) await api.landSession(s.id).catch(() => undefined)
      } catch {
        /* 平台未配置时忽略，发送时还会再试 */
      }
    }
  },

  async openProviderTab(providerId, sessionId, accountId) {
    if (WEB_MODE) {
      if (sessionId) void api.hostAttachSession(sessionId)
      return
    }
    const { providers } = get()
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return
    // 未指定账号 = 沿用该平台的当前账号；指定账号则以调用方为准（含隐式默认账号）。
    // '' 被显式传入时表示「默认分区」，用哨兵值避免主进程回退到 accounts[0]。
    // 未指定账号时也不能回退到 accounts[0]：新加的账号通常是未登录分区，
    // 会让老会话/默认登录态被切到需要重新登录的账号上。
    const requested = accountId === '' ? DEFAULT_ACCOUNT_ID : accountId
    const target = requested ?? provider.activeAccountId ?? DEFAULT_ACCOUNT_ID
    const targetKey = accountKeyOf(target)
    // 同一平台同一账号只保留一个标签：再次选择账号应该是切回已有页面，
    // 而不是用同样的 partition 再造一个 webview（看起来像重新登录）。
    const existing = get().tabs.find(
      (t) => t.providerId === providerId && accountKeyOf(t.accountId) === targetKey
    )
    if (existing) {
      // 空标签（只有网页、还没绑会话）要清掉旧平台的 activeSession，
      // 否则纯净模式面板会继续显示上一个平台的会话和模型。
      if (sessionId) set({ activeTabId: existing.id })
      else get().setActiveTab(existing.id)
      if (sessionId) {
        // wcId 必须取自该标签自己的 webview：多标签时页面上有多个 <webview>，
        // 按 DOM 顺序取第一个会把 A 平台的会话绑到 B 平台的页面。
        let wcId = webviewWcId(existing.id)
        if (wcId <= 0) wcId = await waitWebviewWcId(existing.id, 40)
        if (wcId > 0) {
          set((s) => ({ tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, wcId } : t)) }))
        }
        await get().bindTabSession(existing.id, sessionId, wcId)
      }
      return
    }
    // partition 由账号决定：选了已有账号就复用它的持久化分区（登录态还在），
    // 只有新增账号 / 默认分区未登录时才会落到登录页。
    const info = await api.attachWebview(providerId, target)
    const account = provider.accounts.find((a) => a.id === target)
    const tab: WebTab = {
      id: targetKey ? `tab_${providerId}__${targetKey}` : `tab_${providerId}`,
      providerId,
      providerName: provider.name,
      accountId: target,
      accountName:
        account?.label ?? (provider.accounts.length > 0 && !targetKey ? '默认账号' : undefined),
      partition: info.partition,
      overlayPath: info.overlayPath,
      home: info.home,
      sessionId: sessionId ?? '',
      adapter: info.adapter,
      connected: false,
      loggedIn: false
    }
    // 用函数式更新并按 id 去重：两次并发 attach（双击/纯净模式与点击重叠）
    // 会生成同一个确定性 tab.id，直接 push 会产生重复 key 和互相覆盖的 webview。
    set((s) =>
      s.tabs.some((t) => t.id === tab.id)
        ? { activeTabId: tab.id }
        : { tabs: [...s.tabs, tab], activeTabId: tab.id }
    )
    // 首次创建：webview 尚未渲染/attach，等它自己的 wcId 就绪后绑定。
    if (sessionId) {
      const wcId = await waitWebviewWcId(tab.id, 60)
      if (wcId > 0) await get().bindTabSession(tab.id, sessionId, wcId)
    } else {
      get().setActiveTab(tab.id)
    }
  },

  closeTab(id) {
    const { tabs, activeTabId } = get()
    const next = tabs.filter((t) => t.id !== id)
    set({ tabs: next, activeTabId: activeTabId === id ? (next[0]?.id ?? null) : activeTabId })
  },

  setActiveTab(id) {
    const seq = ++sessionSeq
    set({ activeTabId: id })
    // 切换网页标签 = 切换当前会话：不同步的话发送会把旧会话的提示词
    // 写进新标签的平台页面（跨平台串台），顶栏导出等操作也指向旧会话。
    const tab = get().tabs.find((t) => t.id === id)
    const sid = tab?.sessionId
    if (!sid) {
      // 空标签（还没绑定会话）不能继续沿用旧 activeSession，否则新建任务会走错平台
      set({
        activeSession: null,
        plan: null,
        streamingText: '',
        streamingTps: 0,
        thinkingText: '',
        pendingReplySessionId: '',
        confirmRequest: null
      })
      return
    }
    if (sid === get().activeSession?.id) return
    // 先清掉旧会话的流式/确认/审阅状态，避免异步加载期间把旧内容画到新标签下
    set({
      activeSession: null,
      plan: null,
      streamingText: '',
      streamingTps: 0,
      thinkingText: '',
      pendingReplySessionId: '',
      confirmRequest: null,
      reviewFiles: [],
      reviewActivePath: ''
    })
    void Promise.all([api.getSession(sid), api.getActivePlan(sid).catch(() => null)]).then(
      ([sess, plan]) => {
        if (seq !== sessionSeq || get().activeTabId !== id) return // 期间又切走了
        set({ activeSession: sess, plan: sess ? plan : null })
      }
    )
  },

  async bindTabSession(tabId, sessionId, webContentsId) {
    const prev = get().tabs.find((t) => t.id === tabId)
    // 幂等：同会话同 wcId 已绑定 → 不再做任何事。
    // 缺了这句，WebTabs 的补绑 effect 会「绑定→更新tab→effect重跑→再绑定」死循环，
    // 每秒打爆主进程几十次 bindSession + hook 注入（实测应用因此假死）。
    if (prev && prev.sessionId === sessionId && webContentsId > 0 && prev.wcId === webContentsId)
      return
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, sessionId, wcId: webContentsId > 0 ? webContentsId : t.wcId } : t
      )
    }))
    if (webContentsId > 0) {
      // 主进程 bindSession 会解除同一 webview 上的旧会话绑定（单绑定不变量），
      // 并在首次绑定/换绑时负责 landSession（落到新对话或会话自己的 URL）。
      await api.bindSession(sessionId, webContentsId)
    } else {
      // 没有 wcId 就等于没绑定：主进程收不到 bindSession，hook 不注入，
      // 网页里无论发什么都到不了 lidow（AI 会说「我没有工作目录」）。
      get().notice('网页尚未就绪，未能绑定会话（请稍后重试发送）', 'warn')
    }
  },

  setTabWcId(tabId, wcId) {
    const cur = get().tabs.find((t) => t.id === tabId)
    if (!cur || cur.wcId === wcId) return
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, wcId } : t)) })
  },

  async sendPrompt(text) {
    // 没有项目就没有工作目录：AI 只会答「我没有文件系统访问」，工具也无根可落。
    // 在发送前拦住并引导初始化，比让用户看到一条误导性回复更好。
    if (!get().projects.length) {
      get().notice('请先初始化项目（选择工作目录），AI 才有可以操作的文件系统', 'warn')
      return
    }
    // 新一轮任务开始：清掉上一轮可能迟到的思考/流式残留，避免旧内容显示在新任务下
    set({ thinkingText: '', streamingText: '', streamingTps: 0 })
    let { activeSession } = get()
    // 没有活动会话：自动新建（纯净模式直接发送的兜底）
    if (!activeSession) {
      const pid = get().providers[0]?.id
      if (!pid) {
        get().notice('请先选择一个 AI 平台', 'warn')
        return
      }
      await get().createSession(pid)
      activeSession = get().activeSession
      if (!activeSession) return
    }
    if (WEB_MODE) {
      // 服务端宿主已在 createSession/openSession 时绑定好网页，直接交给主进程循环
      set({ pendingReplySessionId: activeSession.id, pendingSince: Date.now() })
      try {
        await api.sendPrompt(activeSession.id, text)
      } catch (e) {
        set({ pendingReplySessionId: '' })
        throw e
      }
      return
    }
    let { activeTabId, tabs } = get()
    let tab = tabs.find((t) => t.id === activeTabId)
    // 活动标签必须属于当前会话的平台（多账号时还要属于同一个账号）；
    // 否则按会话的平台/账号切换或打开标签。不同步会把 A 平台的提示词
    // 直接发进 B 平台的页面，或发进同平台另一个账号（串台）。
    if (
      !tab ||
      tab.providerId !== activeSession.providerId ||
      accountKeyOf(tab.accountId) !== accountKeyOf(activeSession.accountId ?? DEFAULT_ACCOUNT_ID)
    ) {
      await get().openProviderTab(
        activeSession.providerId,
        activeSession.id,
        activeSession.accountId ?? DEFAULT_ACCOUNT_ID
      )
      ;({ activeTabId, tabs } = get())
      tab = tabs.find((t) => t.id === activeTabId)
    }
    if (!tab) {
      get().notice('没有可用的网页标签（平台未配置或被关闭）', 'warn')
      return
    }
    const tabId = tab.id
    // 关键兜底：webview 已存在但从未成功绑定（wcId<=0 时 bindTabSession 静默跳过）
    // → 从该标签自己的 webview 补绑，否则 loop 永远「网页未连接」。
    // 注意不能用 document.querySelector('webview')：多标签时会拿到别的平台页面。
    let wcId = webviewWcId(tabId)
    if (wcId <= 0) wcId = await waitWebviewWcId(tabId, 66)
    if (wcId > 0) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, wcId, sessionId: activeSession.id } : t))
      }))
      await api.bindSession(activeSession.id, wcId)
    } else {
      get().notice('网页尚未就绪，未能绑定会话（请稍后重试发送）', 'warn')
    }
    // 首包到达前显示「正在思考」；turn-chunk/think-chunk/tool-start 会清掉
    if (wcId > 0) set({ pendingReplySessionId: activeSession.id, pendingSince: Date.now() })
    // 网页可能被用户切到了别的对话/新对话：发送前先落回本会话的网页 URL，
    // 否则这条消息会进错上下文，网页窗口和纯净窗口的历史也会分叉。
    if (activeSession.providerUrl) {
      await api.landSession(activeSession.id).catch(() => undefined)
    }
    try {
      await api.sendPrompt(activeSession.id, text)
    } catch (e) {
      set({ pendingReplySessionId: '' })
      throw e
    }
  },

  async stop(level) {
    set({ pendingReplySessionId: '' })
    // 只停当前会话：之前没有 sessionId，会连带停掉另一个标签的任务
    await api.stop(get().activeSession?.id ?? '', level)
  },

  async answerConfirm(ok) {
    const req = get().confirmRequest
    if (!req) return
    set({ confirmRequest: null })
    await api.confirmTool(req.callId, ok)
  },

  notice(message, level = 'info') {
    const ts = Date.now()
    set({ notices: [...get().notices.slice(-20), { level, message, ts }] })
    get().scheduleNoticeRemoval(ts)
  },
  // 通知 4.5s 后自动退场（以 ts 为幂等 id）
  scheduleNoticeRemoval(ts: number) {
    window.setTimeout(() => {
      set((s) => ({ notices: s.notices.filter((n) => n.ts !== ts) }))
    }, 4500)
  },

  async checkUpdate(manual = false) {
    const cur = get().updateState
    // main 正在下载/已下载：重复 check 只会打断流程
    if (cur.phase === 'checking' || cur.phase === 'downloading' || cur.phase === 'downloaded')
      return
    // 用户主动检查时重新展示提示，避免之前点过「稍后」后看不到结果
    if (manual) set({ updateDismissedVersion: '' })
    set({ updateState: { ...cur, phase: 'checking', manual, message: '' } })
    try {
      const r = await api.checkUpdate(manual)
      const latest = get().updateState
      // 事件可能已把状态推进到 available：不要被旧的回包覆盖
      if (latest.phase === 'downloading' || latest.phase === 'downloaded') return
      set({
        updateState: {
          ...latest,
          phase: r.hasUpdate ? 'available' : 'up-to-date',
          version: r.version ?? latest.version,
          portable: Boolean(r.portable),
          manual
        }
      })
    } catch (e) {
      set({
        updateState: {
          ...get().updateState,
          phase: 'error',
          manual,
          message: e instanceof Error ? e.message : String(e)
        }
      })
    }
  },

  async downloadUpdate() {
    const cur = get().updateState
    if (cur.phase === 'downloading' || cur.phase === 'downloaded') return
    // 用户点过更新才进入下载：失败必须弹错误，不能被自动检查的 manual=false 隐藏
    set({ updateState: { ...cur, phase: 'downloading', percent: 0, manual: true } })
    try {
      const r = await api.downloadUpdate()
      if (!r.ok)
        set({
          updateState: { ...get().updateState, phase: 'error', manual: true, message: r.message }
        })
      else if (get().updateState.phase !== 'downloaded') {
        // 便携版不会真的下载/安装：回退到 available，避免进度条永远停在 0%
        set({
          updateState: { ...get().updateState, phase: cur.portable ? 'available' : 'downloaded' }
        })
        get().notice(r.message)
      }
    } catch (e) {
      set({
        updateState: {
          ...get().updateState,
          phase: 'error',
          manual: true,
          message: e instanceof Error ? e.message : String(e)
        }
      })
    }
  },

  dismissUpdate() {
    const v = get().updateState.version
    set({ updateDismissedVersion: v ?? '' })
  },

  async refreshAll() {
    const s = get()
    await Promise.all([
      // 项目列表一并刷新：网页内引导初始化后（projects-changed）下拉才有新项目
      (async () => {
        const st = await api.getAppState()
        set({ projects: st.projects, activeProjectId: st.activeProjectId })
      })(),
      s.refreshSessions(),
      (async () =>
        set({
          skills: await api.listSkills(),
          agents: await api.listAgents(),
          rules: await api.listRules()
        }))(),
      (async () => set({ memoryList: await api.listMemory() }))(),
      (async () => {
        set({ mcpServers: await api.listMcpServers(), mcpTools: await api.listMcpTools() })
      })(),
      (async () => set({ installedPlugins: await api.listInstalledPlugins() }))(),
      (async () => set({ kbs: await api.listKnowledgeBases() }))(),
      (async () => set({ audits: await api.listAudit(undefined, 100) }))(),
      (async () => set({ quickCmds: await api.listQuickCommands() }))(),
      (async () => set({ todos: await api.listTodos().catch(() => []) }))()
    ])
  },

  handleEvent(e) {
    const s = get()
    switch (e.type) {
      case 'update-state':
        set({ updateState: e.state })
        break
      case 'session-title':
        set((st) => ({
          sessions: st.sessions.map((m) => (m.id === e.sessionId ? { ...m, title: e.title } : m)),
          activeSession:
            st.activeSession?.id === e.sessionId
              ? { ...st.activeSession, title: e.title }
              : st.activeSession
        }))
        break
      case 'session-deleted': {
        // 网页侧删除对话 → 主进程删除本地会话后广播：纯净模式/会话列表同步移除
        set((st) => ({
          sessions: st.sessions.filter((m) => m.id !== e.sessionId),
          sessionDelete: st.sessionDelete?.id === e.sessionId ? null : st.sessionDelete,
          tabs: st.tabs.map((t) => (t.sessionId === e.sessionId ? { ...t, sessionId: '' } : t)),
          ...(st.activeSession?.id === e.sessionId
            ? {
                activeSession: null,
                plan: null,
                streamingText: '',
                streamingTps: 0,
                thinkingText: '',
                pendingReplySessionId: '',
                confirmRequest: null,
                reviewFiles: [],
                reviewActivePath: ''
              }
            : {})
        }))
        void get().refreshSessions()
        break
      }
      case 'ui-pure-suggestion': {
        // 已在纯净模式里就不用再问一次
        if (get().pureMode) break
        // 初始化是主进程直接建会话并绑定网页的，渲染层标签可能还不知道这个 session。
        // 必须按 webContentsId 找对应标签，不能盲写当前活动标签（多平台会串台）。
        const sid = e.sessionId
        const st0 = get()
        const target =
          (e.webContentsId !== undefined
            ? st0.tabs.find((t) => t.wcId === e.webContentsId)
            : undefined) ??
          st0.tabs.find((t) => e.providerId && t.providerId === e.providerId && !t.sessionId)
        if (target) {
          set((st) => ({
            pureSuggestion: true,
            tabs: st.tabs.map((t) => (t.id === target.id ? { ...t, sessionId: sid } : t))
          }))
        } else {
          set({ pureSuggestion: true })
        }
        void api
          .getSession(sid)
          .then((sess) => {
            if (!sess || get().pureMode) return
            // 只在该会话对应的标签仍是当前标签时接管，避免覆盖用户刚切到的会话
            if (target && get().activeTabId === target.id) set({ activeSession: sess })
          })
          .catch(() => undefined)
        break
      }
      case 'host-open-session': {
        // 仅服务端隐藏宿主处理：为 Web 客户端打开对应平台页面并绑定会话
        if (WEB_MODE) break
        void (async () => {
          const sess = await api.getSession(e.sessionId).catch(() => null)
          if (sess)
            await get().openProviderTab(
              sess.providerId,
              sess.id,
              sess.accountId ?? DEFAULT_ACCOUNT_ID
            )
        })()
        break
      }
      case 'providers-changed': {
        // 网页侧检测到账号名/登录态：刷新平台卡片与账号选择器
        if (e.projectId === get().activeProjectId) {
          void api.listProviders(e.projectId).then((providers) => set({ providers }))
        }
        break
      }
      case 'session-updated': {
        // 只清当前正在看的会话的残留流文本：后台会话（子代理/续接）落盘时
        // 不能把用户眼前正在滚动的流式输出打没
        if (e.sessionId === get().activeSession?.id) {
          set({ streamingText: '', streamingTps: 0, thinkingText: '' })
        }
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === get().activeSession?.id) {
            set({ activeSession: sess })
            // 回复轮已落盘（assistant），清掉「等待首包」加载态
            if (sess.turns[sess.turns.length - 1]?.role === 'assistant') {
              set({ pendingReplySessionId: '' })
            }
          }
        })
        void get().refreshSessions()
        break
      }
      case 'web-session-activated': {
        // 用户在网页侧栏点了另一个项目的对话：主进程已完成项目切换与 webview 重绑
        void (async () => {
          const sess = await api.getSession(e.sessionId).catch(() => null)
          if (!sess) return
          const app = await api.getAppState()
          const sessions = await api.listSessions(e.projectId)
          set((st) => ({
            projects: app.projects,
            activeProjectId: app.activeProjectId,
            activeSession: sess,
            sessions,
            view: 'home',
            pureView: 'home',
            plan: null,
            streamingText: '',
            streamingTps: 0,
            thinkingText: '',
            pendingReplySessionId: '',
            confirmRequest: null,
            reviewFiles: [],
            reviewActivePath: '',
            tabs: st.tabs.map((t) =>
              t.id === st.activeTabId
                ? {
                    ...t,
                    providerId: e.providerId,
                    sessionId: e.sessionId,
                    accountId: e.accountId ?? t.accountId
                  }
                : t
            )
          }))
          await get().refreshProviders()
          await get().refreshAll()
        })()
        break
      }
      case 'session-switched': {
        // 自动续接：主进程已把网页绑定到新会话，视图和标签状态都要跟上，
        // 否则后续消息会重新绑回旧会话、续接后的回复也看不到。
        set((st) => ({
          pendingReplySessionId:
            st.pendingReplySessionId === e.fromSessionId ? e.sessionId : st.pendingReplySessionId,
          tabs: st.tabs.map((t) =>
            t.sessionId === e.fromSessionId ? { ...t, sessionId: e.sessionId } : t
          )
        }))
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && get().activeSession?.id === e.fromSessionId)
            set({ activeSession: sess, plan: null })
        })
        void get().refreshSessions()
        break
      }
      case 'think-chunk':
        // 子代理/后台会话的思考流不进当前视图（session 过滤，防串台）
        if (e.sessionId !== s.activeSession?.id) break
        set({ thinkingText: e.think, pendingReplySessionId: '' })
        break
      case 'turn-chunk':
        if (e.sessionId !== s.activeSession?.id) break
        set({ streamingText: e.text, streamingTps: e.tps ?? 0, pendingReplySessionId: '' })
        break
      case 'tool-start':
        if (e.sessionId === s.pendingReplySessionId) set({ pendingReplySessionId: '' })
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === s.activeSession?.id) set({ activeSession: sess })
        })
        break
      case 'tool-confirm-required':
        // 只记录待确认项，不切视图：纯净模式自带内联确认卡（ChatPanel 内），
        // 强制 pureMode:false 会把用户踢出正在看的对话界面（实测严重打断）
        set({ confirmRequest: { callId: e.callId, reason: e.reason, sessionId: e.sessionId } })
        break
      case 'plan-proposed':
        // 计划卡片同样在纯净模式内联呈现，不强制退出。
        // 只显示当前会话的计划（子代理/后台会话提交的计划不弹到眼前）
        if (e.sessionId === s.activeSession?.id) set({ plan: e.plan })
        break
      case 'notice': {
        const ts = Date.now()
        set({ notices: [...s.notices.slice(-20), { level: e.level, message: e.message, ts }] })
        // 任务被忽略时不会产生回复轮：清掉等待态，避免「正在思考」永久停留
        if (e.level === 'warn' && e.message.includes('已有任务在执行'))
          set({ pendingReplySessionId: '' })
        get().scheduleNoticeRemoval(ts)
        break
      }
      case 'ui-panel': {
        // 悬浮球「打开面板」= 进入纯净模式对话界面（面板语义已废弃，球是唯一入口时此路径必须可用）
        set({ pureMode: true, pureView: 'home' })
        break
      }
      case 'toggle-state':
        set({
          toggleState: {
            think: e.think,
            search: e.search,
            thinkAvailable: Boolean(e.thinkAvailable),
            searchAvailable: Boolean(e.searchAvailable)
          }
        })
        break
      case 'ui-toggle-pure': {
        // 复用 setPure 的完整进入逻辑（pureView 归位、绑定/加载当前会话），
        // 只 set pureMode 会停在设置页或显示旧会话。
        get().setPure(!get().pureMode)
        break
      }
      case 'ui-new-session': {
        // 全局热键：用当前会话的平台新建任务（没有会话时用第一个平台）
        const st = get()
        const pid = st.activeSession?.providerId ?? st.providers[0]?.id
        if (pid) void st.createSession(pid)
        else get().notice('请先在「工作台」选择一个 AI 平台', 'warn')
        break
      }
      case 'projects-changed': {
        // 网页内初始化选了新目录：主进程已切换活动项目并解绑旧会话。
        // 渲染层必须同时清掉旧项目的 activeSession / 标签会话，否则后续发送
        // 会把旧项目的会话重新绑到网页上。
        void (async () => {
          const before = get().activeProjectId
          const st = await api.getAppState()
          const changed = before !== st.activeProjectId
          set((s) => ({
            projects: st.projects,
            activeProjectId: st.activeProjectId,
            ...(changed
              ? {
                  activeSession: null,
                  sessions: [],
                  plan: null,
                  tabs: s.tabs.map((t) => ({ ...t, sessionId: '' }))
                }
              : {})
          }))
          await s.refreshAll()
        })()
        break
      }
      default:
        break
    }
  }
}))
