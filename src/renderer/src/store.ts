import { create } from 'zustand'
import { api } from './api'
import type { LidowEvent } from '@shared/ipc'
import type {
  AppSettings,
  McpToolInfo,
  MemoryEntry,
  PluginManifest,
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

export type ViewId = 'home' | 'sessions' | 'files' | 'tasks' | 'plugins' | 'memory' | 'knowledge' | 'audit' | 'settings'

/** 统一的项目解析：与 main 的 activeProjectId 对齐（修多项目时取错 projects[0]） */
export function useProject(s: LidowState): ProjectInfo | null {
  return s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0] ?? null
}

interface WebTab {
  id: string
  providerId: string
  providerName: string
  accountId: string
  partition: string
  overlayPath: string
  home: string
  sessionId: string
  /** webview attach 后记录的 webContentsId（重绑会话时必需） */
  wcId?: number
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
  pureMode: boolean
  /** 纯净模式主区当前面板（home=网页对话；其余为该面板视图），不改变 pureMode */
  pureView: ViewId
  streamingText: string
  streamingTps: number
  confirmRequest: { callId: string; reason: string } | null
  plan: TaskPlan | null
  notices: { level: string; message: string; ts: number }[]
  skills: SkillMeta[]
  agents: AgentMeta[]
  rules: RuleEntry[]
  memoryList: MemoryEntry[]
  mcpServers: McpServerConfig[]
  mcpTools: McpToolInfo[]
  installedPlugins: PluginManifest[]
  marketResults: MarketPlugin[]
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
  createSession(providerId: string): Promise<void>
  openSession(id: string): Promise<void>
  openProviderTab(providerId: string, sessionId?: string): Promise<void>
  closeTab(id: string): void
  setActiveTab(id: string): void
  bindTabSession(tabId: string, sessionId: string, webContentsId: number): Promise<void>
  setTabWcId(tabId: string, wcId: number): void
  sendPrompt(text: string): Promise<void>
  stop(level: 'generate' | 'tool' | 'auto-loop' | 'all'): Promise<void>
  answerConfirm(ok: boolean): Promise<void>
  notice(message: string, level?: 'info' | 'warn' | 'error'): void
  scheduleNoticeRemoval(ts: number): void
  refreshAll(): Promise<void>
  handleEvent(e: LidowEvent): void
}

export const useStore = create<LidowState>((set, get) => ({
  booted: false,
  version: '',
  settings: {
    theme: 'dark',
    accent: '#8dff4f',
    language: 'zh-CN',
    pureMode: false,
    dangerConfirm: true,
    ssrfProtection: true,
    commandTimeoutMs: 30000,
    sandboxTimeoutMs: 60000,
    outputBufferLimit: 1048576,
    compactThreshold: 60000,
    autoCompact: true,
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
  pureMode: false,
  pureView: 'home',
  streamingText: '',
  streamingTps: 0,
  confirmRequest: null,
  plan: null,
  notices: [],
  skills: [],
  agents: [],
  rules: [],
  memoryList: [],
  mcpServers: [],
  mcpTools: [],
  installedPlugins: [],
  marketResults: [],
  kbs: [],
  audits: [],
  quickCmds: [],
  todos: [],
  fileTree: [],
  selectedFile: null,

  async boot() {
    const state = await api.getAppState()
    set({ booted: true, version: state.version, settings: state.settings, pureMode: state.settings.pureMode, projects: state.projects, activeProjectId: state.activeProjectId })
    get().applyTheme(state.settings)
    api.onEvent((e) => get().handleEvent(e))
    if (state.projects.length > 0) {
      await get().refreshProviders()
      await get().refreshSessions()
    }
  },

  setView(v) {
    set({ view: v, rightOpen: v === 'home' ? get().rightOpen : false })
  },
  toggleRight() {
    set({ rightOpen: !get().rightOpen })
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
    const theme =
      s.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : s.theme
    root.classList.remove('dark', 'light', 'midnight', 'warm')
    root.classList.add(theme)
    root.style.setProperty('--accent', s.accent)
  },

  async openProject(root) {
    await api.openProject(root)
    const state = await api.getAppState()
    set({ projects: state.projects, activeProjectId: state.activeProjectId, activeSession: null, sessions: [] })
    await get().refreshProviders()
    await get().refreshSessions()
  },

  async refreshProviders() {
    const project = useProject(get())
    if (!project) return
    set({ providers: await api.listProviders(project.id) })
  },

  async refreshSessions() {
    const project = useProject(get())
    if (!project) return
    set({ sessions: await api.listSessions(project.id) })
  },

  async createSession(providerId) {
    const project = useProject(get())
    if (!project) return
    const s = await api.createSession(project.id, providerId)
    // 关键：新建后必须把新会话设为 activeSession，
    // 否则纯净模式发送时 activeSession 为 null（历史上导致每次点击都新建一个空会话）。
    set({ activeSession: s, view: 'home', pureView: 'home' })
    await get().refreshSessions()
    await get().openProviderTab(providerId, s.id)
  },

  async openSession(id) {
    const s = await api.getSession(id)
    set({ activeSession: s, view: 'home', pureView: 'home', rightOpen: true, plan: await api.getActivePlan(id) })
    // 打开会话后立刻把承载网页绑定到该会话：
    // 否则纯净模式直接发送会报「网页未连接」（loop 找不到 channel）。
    if (s) {
      try {
        await get().openProviderTab(s.providerId, s.id)
      } catch {
        /* 平台未配置时忽略，发送时还会再试 */
      }
    }
  },

  async openProviderTab(providerId, sessionId) {
    const { providers, tabs } = get()
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return
    const existing = tabs.find((t) => t.providerId === providerId)
    if (existing) {
      set({ activeTabId: existing.id })
      if (sessionId) {
        // webview 可能还在 attach：等 wcId 就绪再绑定，否则主进程收不到 bindSession，
        // loop 就会报「网页未连接」（纯净模式新建会话后立刻发送的常见路径）。
        let wcId = existing.wcId ?? -1
        for (let i = 0; wcId <= 0 && i < 40; i++) {
          await new Promise((r) => setTimeout(r, 150))
          wcId = get().tabs.find((t) => t.id === existing.id)?.wcId ?? -1
        }
        await get().bindTabSession(existing.id, sessionId, wcId)
      }
      return
    }
    const info = await api.attachWebview(providerId, provider.activeAccountId ?? provider.accounts[0]?.id ?? '')
    const tab: WebTab = {
      id: `tab_${providerId}`,
      providerId,
      providerName: provider.name,
      accountId: provider.activeAccountId ?? provider.accounts[0]?.id ?? '',
      partition: info.partition,
      overlayPath: info.overlayPath,
      home: info.home,
      sessionId: sessionId ?? '',
      connected: false,
      loggedIn: false
    }
    set({ tabs: [...tabs, tab], activeTabId: tab.id })
  },

  closeTab(id) {
    const { tabs, activeTabId } = get()
    const next = tabs.filter((t) => t.id !== id)
    set({ tabs: next, activeTabId: activeTabId === id ? next[0]?.id ?? null : activeTabId })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
  },

  async bindTabSession(tabId, sessionId, webContentsId) {
    const { tabs } = get()
    const prev = tabs.find((t) => t.id === tabId)
    const switched = prev && prev.sessionId && prev.sessionId !== sessionId
    set({ tabs: tabs.map((t) => (t.id === tabId ? { ...t, sessionId, wcId: webContentsId > 0 ? webContentsId : t.wcId } : t)) })
    if (webContentsId > 0) {
      await api.bindSession(sessionId, webContentsId)
      // 会话切换 = 换一个网页会话承载：重置页面到新对话（净模式切换会话的关键）
      if (switched) void api.newChat(sessionId)
    }
  },

  setTabWcId(tabId, wcId) {
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, wcId } : t)) })
  },

  async sendPrompt(text) {
    const { activeSession } = get()
    let { activeTabId, tabs } = get()
    if (!activeSession) {
      get().notice('请先新建会话（选择平台）', 'warn')
      return
    }
    let tab = tabs.find((t) => t.id === activeTabId)
    // 纯净模式首次发送时可能还没有承载网页：按会话的平台自动打开
    if (!tab) {
      await get().openProviderTab(activeSession.providerId, activeSession.id)
      ;({ activeTabId, tabs } = get())
      tab = tabs.find((t) => t.id === activeTabId)
    }
    // 会话与承载网页不一致时重绑（净模式切换会话后直接发送的场景）
    if (tab && tab.sessionId !== activeSession.id) {
      await get().bindTabSession(tab.id, activeSession.id, tab.wcId ?? -1)
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


  async refreshAll() {
    const s = get()
    await Promise.all([
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
      case 'session-updated':
        set({ streamingText: '', streamingTps: 0 }) // 流已落盘，清除残留流文本（修重复渲染）
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === s.activeSession?.id) set({ activeSession: sess })
        })
        void s.refreshSessions()
        break
      case 'turn-chunk':
        set({ streamingText: e.text, streamingTps: e.tps ?? 0 })
        break
      case 'tool-start':
        void api.getSession(e.sessionId).then((sess) => {
          if (sess && sess.id === s.activeSession?.id) set({ activeSession: sess })
        })
        break
      case 'tool-confirm-required':
        // 需要用户确认时自动把面板推到眼前（否则 AI 一直等待而用户看不到审批卡）
        set({ confirmRequest: { callId: e.callId, reason: e.reason }, pureMode: false, view: 'home', rightOpen: true })
        break
      case 'plan-proposed':
        set({ plan: e.plan, pureMode: false, view: 'home', rightOpen: true })
        break
      case 'notice': {
        const ts = Date.now()
        set({ notices: [...s.notices.slice(-20), { level: e.level, message: e.message, ts }] })
        get().scheduleNoticeRemoval(ts)
        break
      }
      case 'ui-panel': {
        // 悬浮球"打开面板"：退出净模式并展开右侧对话面板
        set({ pureMode: false, view: 'home', rightOpen: e.panel === 'chat' ? e.open : get().rightOpen })
        break
      }
      case 'ui-toggle-pure': {
        set({ pureMode: !get().pureMode })
        break
      }
      default:
        break
    }
  }
}))
