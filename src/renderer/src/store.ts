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
  rightOpen: boolean
  /** 纯净模式右侧文件预览面板是否展开（默认收起，避免空白边条） */
  previewOpen: boolean
  setPreviewOpen(open: boolean): void
  /** 纯净模式侧栏宽度（拖拽分隔线调整，持久化到 localStorage） */
  sidebarWidth: number
  setSidebarWidth(w: number): void
  /** 工作台左栏是否为展开态（悬停展开 / 拖拽后固定） */
  railPinned: boolean
  setRailPinned(v: boolean): void
  /** 纯净模式右侧文件预览宽度（拖拽调整） */
  previewWidth: number
  setPreviewWidth(w: number): void
  pureMode: boolean
  /** 纯净模式主区当前面板（home=网页对话；其余为该面板视图），不改变 pureMode */
  pureView: ViewId
  streamingText: string
  streamingTps: number
  /** 当前流式回复的思考过程（折叠块显示，结束时清空） */
  thinkingText: string
  confirmRequest: { callId: string; reason: string } | null
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
  toggleState: { think: boolean; search: boolean }
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
  selectedFile: { path: string; content: string } | null

  boot(): Promise<void>
  setView(v: ViewId): void
  toggleRight(): void
  setPure(on: boolean): void
  setPureView(v: ViewId): void
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

export const useStore = create<LidowState>((set, get) => ({
  booted: false,
  version: '',
  settings: {
    theme: 'dark',
    accent: '#8dff4f',
    language: 'zh-CN',
    pureMode: false,
    dangerConfirm: true,
    permissionMode: 'autonomous',
    ssrfProtection: true,
    commandTimeoutMs: 30000,
    sandboxTimeoutMs: 60000,
    outputBufferLimit: 1048576,
    compactThreshold: 60000,
    autoCompact: true,
    watchdog: { enabled: true, idleMs: 90000, maxRetries: 3, prompt: '请继续' },
    retry: {
      enabled: true,
      delayMinMs: 4000,
      delayMaxMs: 10000,
      maxRetries: 10,
      delay429Ms: 120000,
      maxRetries429: 40,
      prompt: '刚才的回复似乎中断了，请重新完整回答上一个问题。'
    },
    autoContinue: { enabled: true, handoffPrompt: '' },
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
  rightOpen: true,
  previewOpen: false,
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
  previewWidth: (() => {
    try {
      const raw = Number(window.localStorage.getItem('lidow:previewWidth'))
      return Number.isFinite(raw) && raw >= 220 && raw <= 640 ? raw : 320
    } catch {
      return 320
    }
  })(),
  pureMode: false,
  pureView: 'home',
  streamingText: '',
  streamingTps: 0,
  thinkingText: '',
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
  toggleState: { think: false, search: false },
  marketResults: [],
  marketWarning: '',
  builtinPlugins: [],
  kbs: [],
  audits: [],
  quickCmds: [],
  todos: [],
  fileTree: [],
  selectedFile: null,

  async boot() {
    // 幂等：React StrictMode 会让 effect 跑两次，重复注册监听器会导致
    // 每条事件被处理多遍（实测：右下角同一条通知出现两次）
    if (get().booted || bootPromise) return
    bootPromise = (async () => {
    const state = await api.getAppState()
    set({ booted: true, version: state.version, settings: state.settings, pureMode: state.settings.pureMode, projects: state.projects, activeProjectId: state.activeProjectId })
    get().applyTheme(state.settings)
    api.onEvent((e) => get().handleEvent(e))
    // main 的自动检查可能早于本窗口订阅：补拉一次当前状态
    void api
      .getUpdateState()
      .then((u) => set({ updateState: u }))
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
  toggleRight() {
    set({ rightOpen: !get().rightOpen })
  },
  setPreviewOpen(open) {
    set({ previewOpen: open })
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
  setPreviewWidth(w) {
    const next = Math.min(640, Math.max(220, Math.round(w)))
    set({ previewWidth: next })
    try {
      window.localStorage.setItem('lidow:previewWidth', String(next))
    } catch {
      /* 隐私模式忽略 */
    }
  },
  setPureView(v) {
    set({ pureView: v })
  },
  setPure(on) {
    // 进入纯净模式时回到对话主区
    set({ pureMode: on, pureView: on ? 'home' : get().pureView })
    void api.setPureMode(on)
    // 净模式进入时确保活动会话有后台 webview 承载（对话驱动依赖页面）
    if (on) {
      const s = get()
      const session = s.activeSession ?? null
      const providerId = session?.providerId ?? s.providers[0]?.id
      if (providerId) void s.openProviderTab(providerId, session?.id)
    }
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
      set((s) => ({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSession: null,
        sessions: [],
        plan: null,
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
    // 优先用调用方给出的账号；否则沿用当前平台标签的账号（多账号下新建任务
    // 不应悄悄跳回默认账号的页面）。
    const activeTab = get().tabs.find((t) => t.id === get().activeTabId)
    let account = accountId
    if (account === undefined && activeTab && activeTab.providerId === providerId) {
      // 标签用的是隐式默认分区时，若已存在账号记录，'' 会被主进程解析成 accounts[0]，
      // 必须显式传 __default__，否则会话在下次打开时会跳到另一个账号。
      const hasAccounts = (get().providers.find((p) => p.id === providerId)?.accounts.length ?? 0) > 0
      account = activeTab.accountId || (hasAccounts ? DEFAULT_ACCOUNT_ID : '')
    }
    const s = await api.createSession(project.id, providerId, undefined, account)
    // 关键：新建后必须把新会话设为 activeSession，
    // 否则纯净模式发送时 activeSession 为 null（历史上导致每次点击都新建一个空会话）。
    set({ activeSession: s, view: 'home', pureView: 'home' })
    await get().refreshSessions()
    await get().openProviderTab(providerId, s.id, account)
  },

  async openSession(id) {
    const s = await api.getSession(id)
    set({ activeSession: s, view: 'home', pureView: 'home', rightOpen: true, plan: await api.getActivePlan(id) })
    // 打开会话后立刻把承载网页绑定到该会话：
    // 否则纯净模式直接发送会报「网页未连接」（loop 找不到 channel）。
    if (s) {
      try {
        await get().openProviderTab(s.providerId, s.id, s.accountId)
      } catch {
        /* 平台未配置时忽略，发送时还会再试 */
      }
    }
  },


  async openProviderTab(providerId, sessionId, accountId) {
    const { providers } = get()
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return
    // 未指定账号 = 沿用该平台的当前账号；指定账号则以调用方为准（含隐式默认账号）。
    // '' 被显式传入时表示「默认分区」，用哨兵值避免主进程回退到 accounts[0]。
    const requested = accountId === '' ? DEFAULT_ACCOUNT_ID : accountId
    const target = requested ?? provider.activeAccountId ?? provider.accounts[0]?.id ?? ''
    const targetKey = accountKeyOf(target)
    // 同一平台同一账号只保留一个标签：再次选择账号应该是切回已有页面，
    // 而不是用同样的 partition 再造一个 webview（看起来像重新登录）。
    const existing = get().tabs.find((t) => t.providerId === providerId && accountKeyOf(t.accountId) === targetKey)
    if (existing) {
      set({ activeTabId: existing.id })
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
      accountName: account?.label ?? (provider.accounts.length > 0 && !targetKey ? '默认账号' : undefined),
      partition: info.partition,
      overlayPath: info.overlayPath,
      home: info.home,
      sessionId: sessionId ?? '',
      adapter: info.adapter,
      connected: false,
      loggedIn: false
    }
    // 用函数式更新：两次并发打开（双击平台/纯净模式与点击重叠）不会互相覆盖
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    // 首次创建：webview 尚未渲染/attach，等它自己的 wcId 就绪后绑定。
    if (sessionId) {
      const wcId = await waitWebviewWcId(tab.id, 60)
      if (wcId > 0) await get().bindTabSession(tab.id, sessionId, wcId)
    }
  },

  closeTab(id) {
    const { tabs, activeTabId } = get()
    const next = tabs.filter((t) => t.id !== id)
    set({ tabs: next, activeTabId: activeTabId === id ? next[0]?.id ?? null : activeTabId })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
    // 切换网页标签 = 切换当前会话：不同步的话发送会把旧会话的提示词
    // 写进新标签的平台页面（跨平台串台），顶栏导出等操作也指向旧会话。
    const tab = get().tabs.find((t) => t.id === id)
    const sid = tab?.sessionId
    if (!sid || sid === get().activeSession?.id) return
    void api.getSession(sid).then(async (sess) => {
      if (!sess) return
      set({ activeSession: sess })
      try {
        set({ plan: await api.getActivePlan(sid) })
      } catch {
        /* 计划读取失败不影响会话切换 */
      }
    })
  },

  async bindTabSession(tabId, sessionId, webContentsId) {
    const prev = get().tabs.find((t) => t.id === tabId)
    // 幂等：同会话同 wcId 已绑定 → 不再做任何事。
    // 缺了这句，WebTabs 的补绑 effect 会「绑定→更新tab→effect重跑→再绑定」死循环，
    // 每秒打爆主进程几十次 bindSession + hook 注入（实测应用因此假死）。
    if (prev && prev.sessionId === sessionId && webContentsId > 0 && prev.wcId === webContentsId) return
    const switched = prev && prev.sessionId && prev.sessionId !== sessionId
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sessionId, wcId: webContentsId > 0 ? webContentsId : t.wcId } : t))
    }))
    if (webContentsId > 0) {
      // 主进程 bindSession 会解除同一 webview 上的旧会话绑定（单绑定不变量）
      await api.bindSession(sessionId, webContentsId)
      // 会话切换 = 换一个网页会话承载：重置页面到新对话（净模式切换会话的关键）
      // 切换会话必须落回该会话自己的对话：有平台侧 URL 导航回去（历史完整恢复），
      // 只发 newChat 的话旧会话永远是空的 —— 上下文全丢
      if (switched) void api.landSession(sessionId)
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
    let { activeTabId, tabs } = get()
    let tab = tabs.find((t) => t.id === activeTabId)
    // 活动标签必须属于当前会话的平台（多账号时还要属于同一个账号）；
    // 否则按会话的平台/账号切换或打开标签。不同步会把 A 平台的提示词
    // 直接发进 B 平台的页面，或发进同平台另一个账号（串台）。
    if (
      !tab ||
      tab.providerId !== activeSession.providerId ||
      (activeSession.accountId && accountKeyOf(tab.accountId) !== accountKeyOf(activeSession.accountId))
    ) {
      await get().openProviderTab(activeSession.providerId, activeSession.id, activeSession.accountId)
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
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, wcId, sessionId: activeSession.id } : t)) }))
      await api.bindSession(activeSession.id, wcId)
    } else {
      get().notice('网页尚未就绪，未能绑定会话（请稍后重试发送）', 'warn')
    }
    await api.sendPrompt(activeSession.id, text)
  },

  async stop(level) {
    await api.stop(level)
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
    if (cur.phase === 'checking' || cur.phase === 'downloading' || cur.phase === 'downloaded') return
    set({ updateState: { ...cur, phase: 'checking', manual, message: '' } })
    try {
      const r = await api.checkUpdate()
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
    set({ updateState: { ...cur, phase: 'downloading', percent: 0 } })
    try {
      const r = await api.downloadUpdate()
      if (!r.ok) set({ updateState: { ...get().updateState, phase: 'error', message: r.message } })
      else if (get().updateState.phase !== 'downloaded') {
        // 便携版不会真的下载/安装：回退到 available，避免进度条永远停在 0%
        set({ updateState: { ...get().updateState, phase: cur.portable ? 'available' : 'downloaded' } })
        get().notice(r.message)
      }
    } catch (e) {
      set({
        updateState: { ...get().updateState, phase: 'error', message: e instanceof Error ? e.message : String(e) }
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
      (async () => set({ skills: await api.listSkills(), agents: await api.listAgents(), rules: await api.listRules() }))(),
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
      case 'session-updated':
        // 只清当前正在看的会话的残留流文本：后台会话（子代理/续接）落盘时
        // 不能把用户眼前正在滚动的流式输出打没
        if (e.sessionId === s.activeSession?.id) {
          set({ streamingText: '', streamingTps: 0, thinkingText: '' })
        }
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === s.activeSession?.id) set({ activeSession: sess })
        })
        void s.refreshSessions()
        break
      case 'session-switched': {
        // 自动续接：主进程已把网页绑定到新会话，视图和标签状态都要跟上，
        // 否则后续消息会重新绑回旧会话、续接后的回复也看不到。
        set((st) => ({
          tabs: st.tabs.map((t) => (t.sessionId === e.fromSessionId ? { ...t, sessionId: e.sessionId } : t))
        }))
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && get().activeSession?.id === e.fromSessionId) set({ activeSession: sess, plan: null })
        })
        void get().refreshSessions()
        break
      }
      case 'think-chunk':
        // 子代理/后台会话的思考流不进当前视图（session 过滤，防串台）
        if (e.sessionId !== s.activeSession?.id) break
        set({ thinkingText: e.think })
        break
      case 'turn-chunk':
        if (e.sessionId !== s.activeSession?.id) break
        set({ streamingText: e.text, streamingTps: e.tps ?? 0 })
        break
      case 'tool-start':
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === s.activeSession?.id) set({ activeSession: sess })
        })
        break
      case 'tool-confirm-required':
        // 只记录待确认项，不切视图：纯净模式自带内联确认卡（ChatPanel 内），
        // 强制 pureMode:false 会把用户踢出正在看的对话界面（实测严重打断）
        set({ confirmRequest: { callId: e.callId, reason: e.reason } })
        break
      case 'plan-proposed':
        // 计划卡片同样在纯净模式内联呈现，不强制退出。
        // 只显示当前会话的计划（子代理/后台会话提交的计划不弹到眼前）
        if (e.sessionId === s.activeSession?.id) set({ plan: e.plan })
        break
      case 'notice': {
        const ts = Date.now()
        set({ notices: [...s.notices.slice(-20), { level: e.level, message: e.message, ts }] })
        get().scheduleNoticeRemoval(ts)
        break
      }
      case 'ui-panel': {
        // 悬浮球「打开面板」= 进入纯净模式对话界面（面板语义已废弃，球是唯一入口时此路径必须可用）
        set({ pureMode: true, pureView: 'home' })
        break
      }
      case 'toggle-state':
        set({ toggleState: { think: e.think, search: e.search } })
        break
      case 'ui-toggle-pure': {
        const next = !get().pureMode
        set({ pureMode: next })
        // 热键切换也要落盘：否则重启后又回到旧模式
        void api.setPureMode(next)
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
