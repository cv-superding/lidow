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
  QuickCommand,
  KnowledgeBase,
  AuditEntry,
  MarketPlugin,
  McpServerConfig
} from '@shared/types'

export type ViewId = 'home' | 'sessions' | 'files' | 'plugins' | 'memory' | 'knowledge' | 'audit' | 'settings'

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
  providers: ProviderDescriptor[]
  sessions: SessionMeta[]
  activeSession: Session | null
  tabs: WebTab[]
  activeTabId: string | null
  view: ViewId
  rightOpen: boolean
  pureMode: boolean
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
  fileTree: Awaited<ReturnType<typeof api.readFileTree>>
  selectedFile: { path: string; content: string } | null

  boot(): Promise<void>
  setView(v: ViewId): void
  toggleRight(): void
  setPure(on: boolean): void
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
  refreshAll(): Promise<void>
  handleEvent(e: LidowEvent): void
}

export const useStore = create<LidowState>((set, get) => ({
  booted: false,
  version: '',
  settings: {
    theme: 'dark',
    accent: '#5b8cff',
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
  providers: [],
  sessions: [],
  activeSession: null,
  tabs: [],
  activeTabId: null,
  view: 'home',
  rightOpen: true,
  pureMode: false,
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
  fileTree: [],
  selectedFile: null,

  async boot() {
    const state = await api.getAppState()
    set({ booted: true, version: state.version, settings: state.settings, projects: state.projects })
    get().applyTheme(state.settings)
    api.onEvent((e) => get().handleEvent(e))
    const active = state.projects[0]
    if (active) {
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
  setPure(on) {
    set({ pureMode: on })
    void api.setPureMode(on)
  },

  applyTheme(s) {
    const root = document.documentElement
    root.classList.toggle('dark', s.theme === 'dark')
    root.style.setProperty('--accent', s.accent)
  },

  async openProject(root) {
    await api.openProject(root)
    const state = await api.getAppState()
    set({ projects: state.projects, activeSession: null, sessions: [] })
    await get().refreshProviders()
    await get().refreshSessions()
  },

  async refreshProviders() {
    const active = get().projects.find((p) => p.lastOpenedAt === Math.max(...get().projects.map((x) => x.lastOpenedAt)))
    if (!active) return
    set({ providers: await api.listProviders(active.id) })
  },

  async refreshSessions() {
    const project = get().projects[0]
    if (!project) return
    set({ sessions: await api.listSessions(project.id) })
  },

  async createSession(providerId) {
    const project = get().projects[0]
    if (!project) return
    const s = await api.createSession(project.id, providerId)
    await get().refreshSessions()
    await get().openProviderTab(providerId, s.id)
  },

  async openSession(id) {
    const s = await api.getSession(id)
    set({ activeSession: s, view: 'home', rightOpen: true, plan: await api.getActivePlan(id) })
  },

  async openProviderTab(providerId, sessionId) {
    const { providers, tabs } = get()
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return
    const existing = tabs.find((t) => t.providerId === providerId)
    if (existing) {
      set({ activeTabId: existing.id })
      if (sessionId) await get().bindTabSession(existing.id, sessionId, existing.wcId ?? -1)
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
    set({ tabs: tabs.map((t) => (t.id === tabId ? { ...t, sessionId, wcId: webContentsId > 0 ? webContentsId : t.wcId } : t)) })
    if (webContentsId > 0) await api.bindSession(sessionId, webContentsId)
  },

  setTabWcId(tabId, wcId) {
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, wcId } : t)) })
  },

  async sendPrompt(text) {
    const { activeSession, activeTabId, tabs } = get()
    if (!activeSession) return
    const tab = tabs.find((t) => t.id === activeTabId)
    if (tab && !tab.sessionId) {
      await get().bindTabSession(tab.id, activeSession.id, -1)
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
      (async () => set({ quickCmds: await api.listQuickCommands() }))()
    ])
  },

  handleEvent(e) {
    const s = get()
    switch (e.type) {
      case 'session-updated':
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
        set({ confirmRequest: { callId: e.callId, reason: e.reason } })
        break
      case 'plan-proposed':
        set({ plan: e.plan })
        break
      case 'notice':
        set({ notices: [...s.notices.slice(-20), { level: e.level, message: e.message, ts: Date.now() }] })
        break
      default:
        break
    }
  }
}))
