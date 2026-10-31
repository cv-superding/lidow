import { app, BrowserWindow, Notification, session, shell, webContents } from 'electron'
import type { WebContents } from 'electron'
import { existsSync, mkdirSync, readdirSync, writeFileSync, cpSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import { ToolRegistry } from '@main/tools/registry'
import { createEcosystemTools } from '@main/tools/ecosystem'
import type { ToolContext, ToolDef } from '@main/tools/types'
import { ProviderRegistry } from '@main/providers/registry'
import { SessionStore } from '@main/session/store'
import { ProjectChatIndex, type ProjectChatRef } from '@main/session/projectChats'
import { OverlayManager } from '@main/bridge/overlayManager'
import { AgentLoop, type LoopSessionStore } from '@main/bridge/loop'
import { listAgents } from '@main/ecosystem/skills'
import { MemoryStore } from '@main/ecosystem/memory'
import { AuditLedger } from '@main/ecosystem/audit'
import { TaskPlanStore } from '@main/ecosystem/taskPlan'
import { KnowledgeManager, QuickCommandStore } from '@main/ecosystem/knowledge'
import { McpManager } from '@main/mcp/manager'
import { DshHost } from '@main/dsh/host'
import { PluginManager } from '@main/plugins/manager'
import { SyncService } from '@main/sync/service'
import { CredentialVault } from '@main/infra/vault'
import { JobScheduler } from '@main/infra/jobs'
import { HotkeyManager, checkForUpdate, listTemplates } from '@main/app/platform'
import {
  isDirectoryPickerOpen,
  parentWindowFor,
  showDirectoryPicker
} from '@main/app/directoryPicker'
import { isProjectRootAvailable } from '@main/app/projectFs'
import { applyChromeClientHints, chromeUserAgent, isGoogleAuthUrl } from '@main/app/googleAuth'
import { findSystemBrowser, runSystemBrowserLogin } from '@main/app/systemBrowserLogin'
import { buildSystemPrompt } from '@main/prompt/build'
import { registerRuntimeServices } from '@main/dsh/services'
import type {
  AppSettings,
  FileNode,
  ProjectFolderData,
  ProjectFolderProject,
  ModelPickerInfo,
  ProjectInfo,
  ProviderDescriptor,
  Session,
  SessionMeta
} from '@shared/types'
import { HOOKS, buildHookSource } from '@main/providers/hooks'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'graphite',
  accent: '#4f6bed',
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
  commandTimeoutMs: 30_000,
  sandboxTimeoutMs: 60_000,
  outputBufferLimit: 1024 * 1024,
  compactThreshold: 600_000,
  watchdog: {
    enabled: true,
    idleMs: 90_000,
    maxRetries: 3,
    prompt: '请继续'
  },
  retry: {
    enabled: true,
    delayMinMs: 4000,
    delayMaxMs: 10_000,
    maxRetries: 10,
    delay429Ms: 120_000,
    maxRetries429: 40,
    prompt:
      '刚才的回复被平台中断了。请从中断处继续输出剩余内容，不要从头重写；' +
      '如果内容已经完整，请直接给出最终收尾摘要。'
  },
  autoContinue: {
    enabled: false,
    handoffPrompt:
      '【上下文交接】以上内容来自上一轮会话的压缩摘要，并非完整上下文，可能丢失细节。' +
      '请先读取项目文件核实关键结论，再继续推进未完成的任务。'
  },
  autoCompact: true,
  injectSystemPromptEveryTurn: false,
  globalHotkeys: HotkeyManager.defaults(),
  securityMod: { enabled: true, ctfInject: false, refusalRewrite: 'off', maxRewrites: 2 },
  sync: {}
}

/** 旧版默认重试文案：升级时替换掉它，避免网页里继续插“重新完整回答” */
const OLD_RETRY_PROMPT = '刚才的回复似乎中断了，请重新完整回答上一个问题。'

/** 循环所需的会话存储门面：按会话所属项目动态路由（修复上游 #24 串扰的根） */
/** 平台首页/新对话的通用标题：不能拿来覆盖会话名 */
const GENERIC_CHAT_TITLES = new Set([
  '新会话',
  '新对话',
  'new chat',
  'deepseek',
  '探索未至之境',
  'chatgpt',
  'claude',
  '豆包',
  '通义千问',
  '文心一言',
  'kimi',
  '智谱清言'
])

/**
 * 网页标题 → 会话名：去掉平台后缀（如「读文件 - DeepSeek」），过滤首页通用标题。
 * 平台会按内容自动命名，用户也可能在网页侧重命名，Lidow 侧栏应跟随网页。
 */
function isGenericTitlePart(part: string, providerName: string): boolean {
  const p = part.toLowerCase()
  return (
    GENERIC_CHAT_TITLES.has(p) ||
    p === providerName.toLowerCase() ||
    p.includes('探索未至之境') ||
    p.includes('into the unknown') ||
    p.includes('抖音旗下') ||
    p.includes('腾讯旗下') ||
    p.includes('全能ai助手')
  )
}

function cleanChatTitle(raw: string | undefined, providerName: string): string {
  let t = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const parts = t
    .split(/\s+[-|·]\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (parts.length > 1) {
    // 只剔除尾部平台名/首页标语，避免把「ChatGPT - 使用指南」这类
    // 以平台名开头的真实标题削成「使用指南」。
    while (parts.length > 1 && isGenericTitlePart(parts[parts.length - 1]!, providerName))
      parts.pop()
    t = parts.join(' - ').trim()
  }
  if (!t || isGenericTitlePart(t, providerName)) return ''
  return t.slice(0, 60)
}

/** 平台对话 URL 归一化：忽略查询串/哈希/尾斜杠，用于双向删除匹配 */
function chatUrlKey(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

/** 账号归一化：空值/__default__ 都代表隐式默认分区 */
/** 平台首条消息前的临时对话 URL（豆包 local_xxx、ChatGPT local-chatgpt:xxx） */
function isTransientChatUrl(raw: string | undefined): boolean {
  if (!raw) return false
  try {
    const u = new URL(raw)
    return u.pathname
      .split('/')
      .some((seg) => /^local[-_]/i.test(decodeURIComponent(seg)))
  } catch {
    return false
  }
}

/** 同一会话的 URL 变化（新对话页 → 具体对话 id），不是切到另一条对话 */
function isConversationUpgrade(oldUrl: string | undefined, newUrl: string): boolean {
  const a = chatUrlKey(oldUrl)
  const b = chatUrlKey(newUrl)
  if (!a || !b) return true
  if (a === b) return true
  // 元宝 /chat/<bot> → /chat/<bot>/<chatId>，首条消息后 URL 才补上会话 id
  if (b.startsWith(a + '/')) return true
  // 豆包 local_xxx / ChatGPT local-chatgpt:xxx 会在首条消息后换成正式会话 id
  if (isTransientChatUrl(oldUrl)) return true
  // Kimi 首条消息前是 /chat/p<临时id>，发送后换成正式 UUID 会话
  const lastSeg = (raw: string): string => {
    try {
      const parts = new URL(raw).pathname.split('/').filter(Boolean)
      return decodeURIComponent(parts[parts.length - 1] || '')
    } catch {
      return ''
    }
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const oldSeg = lastSeg(oldUrl || '')
  const newSeg = lastSeg(newUrl)
  if (oldSeg && newSeg && !uuid.test(oldSeg) && uuid.test(newSeg)) return true
  return false
}

function accountKey(accountId?: string): string {
  return accountId && accountId !== '__default__' ? accountId : '__default__'
}

function routedSessionFacade(resolve: (sessionId: string) => SessionStore): LoopSessionStore {
  return {
    appendTurn: (id, t) => resolve(id).appendTurn(id, t),
    patchTurn: (id, tid, p) => resolve(id).patchTurn(id, tid, p),
    update: (id, fn) => resolve(id).update(id, fn),
    get: (id) => resolve(id).get(id)
  }
}

/** 全量运行时上下文：main 进程内一切管理器的聚合点 */
export class AppContext {
  settings!: JsonStore<AppSettings>
  private projectStore!: JsonStore<{ projects: ProjectInfo[]; activeProjectId: string | null }>
  projects: ProjectInfo[] = []

  tools = new ToolRegistry()
  memory!: MemoryStore
  audit!: AuditLedger
  plans = new TaskPlanStore()
  knowledge!: KnowledgeManager
  quickCommands!: QuickCommandStore
  mcp!: McpManager
  dsh!: DshHost
  plugins!: PluginManager
  sync!: SyncService
  vault!: CredentialVault
  jobs!: JobScheduler
  overlay = new OverlayManager()
  loop!: AgentLoop
  hotkeys!: HotkeyManager

  emitFn?: (event: unknown) => void

  private pendingConfirms = new Map<string, (ok: boolean) => void>()
  /** 各会话最近一次思考流（net hook 上报的是累计文本）：随 assistant turn 落盘，UI 折叠展示 */
  private thinkBuffers = new Map<string, string>()
  private projectDirs = new Map<string, string>()
  /** webContents → 平台/账号：首次初始化时没有会话绑定，靠它建对话到正确的平台 */
  private wcProviders = new Map<number, { providerId: string; accountId?: string }>()
  private googleAuthWindows = new Map<number, BrowserWindow>()
  /** 系统浏览器登录一次只跑一个：独立配置不能被两个实例同时占用 */
  private systemLoginBusy = false
  /** 本地删除网页对话进行中的 URL：忽略 overlay 反向回调，避免同名事件重复删/竞态 */
  private webChatDeletesInFlight = new Map<string, number>()
  /** Google 登录提示节流（iframe/主页面可能连续导航） */
  private lastGoogleLoginNoticeAt = 0
  private sessionStores = new Map<string, SessionStore>()
  private projectChats!: ProjectChatIndex
  private providerRegistries = new Map<string, ProviderRegistry>()
  private dshKv!: JsonStore<Record<string, Record<string, unknown>>>
  /** 服务端权威 token 消耗（按平台累计，持久化 token-stats.json） */
  private tokenUsage!: JsonStore<Record<string, number>>
  /** 插件网页脚本（providerId → code），loadAllPlugins 填充、configure 时注入 */
  private webScripts = new Map<string, string[]>()
  lastSessionId = ''

  init(): void {
    const userData = app.getPath('userData')
    this.settings = new JsonStore<AppSettings>(join(userData, 'settings.json'), DEFAULT_SETTINGS)
    // 只迁移旧默认值；用户自定义过的重试文案保持原样
    if (this.settings.get().retry?.prompt === OLD_RETRY_PROMPT) {
      this.settings.update((s) => ({
        ...s,
        retry: { ...s.retry, prompt: DEFAULT_SETTINGS.retry.prompt }
      }))
    }
    this.overlay.setSendIntervalProvider(() => this.settings.get().webSendIntervalMs ?? 1000)
    this.projectStore = new JsonStore<{ projects: ProjectInfo[]; activeProjectId: string | null }>(
      join(userData, 'projects.json'),
      {
        projects: [],
        activeProjectId: null
      }
    )
    this.projects = this.projectStore.get().projects
    for (const p of this.projects) this.projectDirs.set(p.id, p.root)
    // 启动时对全部已知项目补跑脚手架（幂等）：旧项目也能获得 .lidow/skills 等目录。
    // 只处理仍然存在的目录 —— 已删除的测试目录不能因为这条逻辑被重新创建出来。
    for (const p of this.projects) {
      if (isProjectRootAvailable(p.root)) this.initProjectScaffold(p.root)
    }
    // 目录被删除/移动的项目保留记录（工作区可重新选择目录或移除），
    // 但活动项目不能指向它：否则启动后会用空目录建会话、初始化检测也会错位。
    for (const p of this.projects) {
      if (!isProjectRootAvailable(p.root)) {
        Logger.warn('project', `项目目录不存在，保留记录待处理: ${p.root}`)
      }
    }
    const activeId = this.projectStore.get().activeProjectId
    const active = this.projects.find((p) => p.id === activeId)
    if (active && !isProjectRootAvailable(active.root)) {
      const fallback = [...this.projects]
        .filter((p) => isProjectRootAvailable(p.root))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
      this.projectStore.set({ projects: this.projects, activeProjectId: fallback?.id ?? null })
      Logger.warn(
        'project',
        `活动项目目录不存在，已切换到${fallback ? `: ${fallback.root}` : '无项目（等待重新初始化）'}`
      )
    }

    this.projectChats = new ProjectChatIndex(userData)
    // 目录还在的项目：把本地会话里已有的网页对话地址补进索引，
    // 这样之后即使目录被删除，也还能在「移除项目」时清理网页端会话。
    for (const p of this.projects) {
      if (!isProjectRootAvailable(p.root)) continue
      try {
        const registry = this.providerRegistryOf(p.id)
        const refs = this.sessionStoreOf(p.id)
          .list()
          .filter((m) => Boolean(m.providerUrl))
          .map((m) => ({
            sessionId: m.id,
            providerId: m.providerId,
            accountId: m.accountId,
            partition: registry.partitionOf(m.providerId, m.accountId),
            home: registry.get(m.providerId)?.home,
            url: m.providerUrl!,
            title: m.title,
            updatedAt: m.updatedAt
          }))
        this.projectChats.mergeProject(p.id, refs)
      } catch {
        /* 项目目录不可读：跳过 */
      }
    }

    this.memory = new MemoryStore(userData)
    this.audit = new AuditLedger(userData)
    this.knowledge = new KnowledgeManager(userData)
    this.quickCommands = new QuickCommandStore(userData)
    this.mcp = new McpManager(userData)
    this.plugins = new PluginManager(userData, () => this.toolCtx(''))
    this.sync = new SyncService(() => this.settings.get())

    this.vault = new CredentialVault(userData)
    this.jobs = new JobScheduler()
    this.jobs.setRunner(async (job) => {
      const ctx = this.toolCtx('')
      const def = this.tools.get('bash')
      if (!def) throw new Error('bash 工具不可用')
      const out = await def.run({ command: job.action }, ctx)
      if (!out.ok) throw new Error(out.error ?? out.output)
    })

    this.dsh = new DshHost({
      tools: this.tools,
      execTool: this.tools.get('bash')!,
      projectRoot: () => this.activeProject()?.root ?? '',
      providers: () => [...this.providerRegistries.values()].flatMap((r) => r.list()),
      tokenStats: () => ({ totalChars: 0, tps: 0 }),
      slots: { register: () => undefined, list: () => [] },
      sessions: () => {
        const p = this.activeProject()
        return p ? this.sessionStoreOf(p.id) : null
      },
      activeProjectId: () => this.activeProject()?.id ?? null,
      plans: this.plans,
      readFileTree: (root, rel, depth) => this.readFileTree(root, rel, depth),
      settings: { get: () => this.settings.get(), patch: (p) => this.settings.set(p) },
      onHotkeysChange: () => this.hotkeys.applyAll(),
      vault: this.vault,
      jobs: this.jobs
    })

    this.dshKv = new JsonStore<Record<string, Record<string, unknown>>>(
      join(userData, 'dsh-kv.json'),
      {}
    )
    this.tokenUsage = new JsonStore<Record<string, number>>(join(userData, 'token-stats.json'), {})
    registerRuntimeServices(this.dsh, {
      kv: this.dshKv,
      emit: (event) => this.emit(event as { type: string; sessionId: string }),
      requestConfirm: (reason) => this.requestConfirm(this.lastSessionId || 'global', reason),
      activeSession: () => this.sessionOf(this.lastSessionId),
      activeProject: () => this.activeProject(),
      appendTurn: (sessionId, role, text) => {
        this.sessionStoreOf(this.sessionProjectOf(sessionId)).appendTurn(sessionId, {
          id: `turn_${nanoid(8)}`,
          role,
          text,
          ts: Date.now(),
          status: 'done'
        })
        this.emit({ type: 'session-updated', sessionId })
      },
      pluginManager: this.plugins,
      mcp: this.mcp,
      runShell: async (command) => {
        const out = await this.tools.get('bash')!.run({ command }, this.toolCtx(''))
        return { ok: out.ok, output: out.output, error: out.error }
      },
      llmProviders: () => [...this.providerRegistries.values()].flatMap((r) => r.list()),
      promptFragments: () => this.promptFragments(),
      knowledge: this.knowledge
    })

    this.registerEcosystemTools()
    this.registerMcpTool()
    this.registerAgentTool()
    this.registerKbTool()

    this.loop = new AgentLoop({
      store: routedSessionFacade((id) => this.sessionStoreOf(this.sessionProjectOf(id))),
      // 自动续接要新建会话：必须走真实 SessionStore（门面没有 create）
      createSession: (projectId, providerId, parentSessionId, accountId) =>
        this.sessionStoreOf(projectId).create(projectId, providerId, parentSessionId, accountId),
      tools: this.tools,
      // 按会话取根目录：任务运行中切换活动项目不能把工具写到另一个项目
      toolCtxBase: (sessionId) => this.toolCtx(sessionId),
      confirm: (sessionId, reason) => this.requestConfirm(sessionId, reason),
      sendToPage: (sessionId, text) => this.overlay.sendToPage(sessionId, text),
      waitPageIdle: (sessionId) => this.overlay.waitPageIdle(sessionId),
      awaitReply: (sessionId, onChunk) => this.overlay.awaitReply(sessionId, onChunk),
      interruptPage: (sessionId) => this.overlay.interruptPage(sessionId),
      abandonReply: (sessionId) => this.overlay.abandonReply(sessionId),
      emit: (event) => this.emit(event),
      settings: () => this.settings.get(),
      securityMod: () => {
        const m = this.settings.get().securityMod
        // enabled 是总开关：开启后即使 refusalRewrite 还是历史默认值 'off'，
        // 也按本地改写执行；否则设置里的「安全 MOD」开关开/关没有任何区别。
        const mode = !m.enabled ? 'off' : m.refusalRewrite === 'api' ? 'api' : 'local'
        return {
          mode,
          ctfInject: m.ctfInject,
          maxRewrites: m.maxRewrites,
          rewriteApi: m.rewriteApi,
          customPatterns: m.customPatterns ?? [],
          customNotice: m.customNotice ?? ''
        }
      },
      captureMemory: (content) =>
        this.memory.add(content.slice(0, 40), content, ['标记'], 'marker'),
      systemPromptFor: (sessionId) => this.systemPromptFor(sessionId),
      takeThinking: (sessionId) => this.takeThinking(sessionId),
      // 自动续接：新会话需要自己的网页绑定。这里只做主进程侧绑定，
      // 前端会通过 session-updated 事件跟上（切到新会话视图）。
      rebindToSession: async (sessionId: string, fromSessionId?: string) =>
        this.rebindWebview(sessionId, fromSessionId),
      // 工具执行遮罩：本地执行期间盖住网页（防误操作 + 明确状态）
      toolMask: (sessionId, show, text) => {
        this.overlay.sendCmd(sessionId, { kind: 'tool-mask', show, text })
      },
      // 任务完成通知：仅在窗口失焦时弹系统通知（前台用户看得见，不打扰）
      notifyDone: (sessionId, snippet) => this.notifyIfHidden(sessionId, snippet)
    })

    this.hotkeys = new HotkeyManager(() => this.settings.get().globalHotkeys)
    this.hotkeys.registerAction('show-window', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
    })
    this.hotkeys.registerAction('stop-all', () => this.stopAll('all'))
    this.hotkeys.registerAction('new-session', () =>
      this.emit({ type: 'ui-new-session', sessionId: '' })
    )
    this.hotkeys.registerAction('toggle-pure', () =>
      this.emit({ type: 'ui-toggle-pure', sessionId: '' })
    )
    this.hotkeys.applyAll()

    this.overlay.setThinkChunkHandler((sessionId, think) => {
      // 缓存最新累计思考：loop 在回复结束后取走并写入 turn.think（折叠展示）
      if (think) this.thinkBuffers.set(sessionId, think.slice(0, 20_000))
      this.emit({ type: 'think-chunk', sessionId, think })
    })
    this.overlay.setToggleStateHandler((think, search, thinkAvailable, searchAvailable) => {
      this.emit({
        type: 'toggle-state',
        sessionId: '',
        think,
        search,
        thinkAvailable,
        searchAvailable
      })
    })
    // 用户在网页输入框里自己发消息时，回复没有经过 lidow 的 send/await 通道。
    // 常驻接管：回复里若带工具块就执行，否则提示用户改用原生输入框。
    this.overlay.setPageReplyHandler((sessionId, text) => {
      void this.loop.adoptExternalReply(sessionId, text)
    })
    // 网页里亲手发的用户消息也要出现在纯净模式（双向同步的另一半）
    this.overlay.setPageUserMessageHandler((sessionId, text) =>
      this.recordWebUserMessage(sessionId, text)
    )
    // 页面重挂载时补齐最后一条 AI 回答：重启会中断流，之后网页上已有的最终答案
    // 不会再产生网络事件，不补的话纯净模式会停在思考片段。
    this.overlay.setPageSnapshotHandler((sessionId, text, think) =>
      this.loop.syncExternalReply(sessionId, text, think)
    )
    // 服务端权威 token 统计（SSE accumulated_token_usage 差值），按平台累计持久化
    this.overlay.setTokenUsageHandler((sessionId, tokens) => {
      const session = this.sessionOf(sessionId)
      const key = session?.providerId ?? 'other'
      this.tokenUsage.update((d) => ({ ...d, [key]: (d[key] ?? 0) + tokens }))
    })
    this.overlay.setFloatActionHandler((sessionId, action) => {
      if (action === 'open-panel') {
        // 悬浮球左键单击 → 展开对话面板并把窗口提到前台（回归修复：此前无该分支，点击无任何反应）
        this.emit({ type: 'ui-panel', sessionId, panel: 'chat', open: true })
        this.focusWindow()
        return
      }
      const level =
        action === 'stop-generate' ? 'generate' : action === 'stop-tool' ? 'tool' : 'all'
      this.loop.stop(sessionId, level)
    })
    this.overlay.onReady = (sessionId) => this.configureOverlay(sessionId)
    // 账号显示名/登录态：网页里检测到后写回平台账号，卡片和账号选择器不再是「账号 N」
    this.overlay.onLoginState = (webContentsId, loggedIn) =>
      this.updateAccountMetaFromWeb(webContentsId, { loggedIn })
    this.overlay.onProfileName = (webContentsId, name) =>
      this.updateAccountMetaFromWeb(webContentsId, { label: name })
    // 登录成功 → 把「有没有工作目录」推给该网页，由 overlay 决定是否弹首次引导。
    // 这一步必须放在登录之后：登录页没有输入框，那时弹引导用户既看不懂也用不上。
    this.overlay.onInitProject = (webContentsId) => void this.pickAndOpenProject(webContentsId)
    // 「使用此目录，开始」：把系统提示词 + 工作目录自动发进这个对话。
    // 初始化时必须自动输入一段提示词 —— 否则 AI 不知道自己绑定了本地工具，
    // 会答「我没有文件系统访问权限」。
    this.overlay.onConfirmProject = (webContentsId) => void this.sendInitPrompt(webContentsId)
    // 「延续上个对话」：压缩当前会话 → 摘要作为新对话的第一条消息。
    // 等于同一项目的上下文接力：新窗口从上次的进度接着干。
    this.overlay.onContinueProject = (webContentsId) =>
      void this.continueProjectInNewChat(webContentsId)
    this.overlay.onOpenExternal = (webContentsId, url) => {
      const target = url || webContents.fromId(webContentsId)?.getURL()
      if (target) void shell.openExternal(target)
    }
    // 记录会话 ↔ 平台对话 URL：换绑 webview 时才能导航回正确的对话。
    // 没有这个映射，子代理/自动续接切回父会话后页面停在别人的对话里。
    this.overlay.onNav = (sessionId, url, title) => {
      const session = this.sessionOf(sessionId)
      if (!session) {
        Logger.info('nav', `未绑定会话的导航（忽略）: ${url.slice(0, 60)}`)
        return
      }
      const registry = this.providerRegistryOf(session.projectId)
      const descriptor = registry.get(session.providerId)
      const home = descriptor?.home ?? ''
      const loginPage = /\/sign_?in|\/login/i.test(url)
      const onHome = Boolean(home) && url.split('#')[0] === home
      // 登录页/首页不算对话页，不覆盖已记录的对话 URL
      const shouldRecordUrl = !loginPage && !onHome && url !== session.providerUrl
      // 会话已经有本地历史，网页却切到了另一条对话：不能把新 URL 写进来，
      // 否则本地旧历史会和新网页对话混在同一个会话里（实测元宝出现两条对话合并）。
      // 也不能继续把新对话的回复接管进旧会话，先解绑；下次在纯净模式选回该会话
      // 或发送时会重新绑定并落到它自己的 URL。
      if (
        shouldRecordUrl &&
        session.providerUrl &&
        session.turns.length > 0 &&
        !isConversationUpgrade(session.providerUrl, url)
      ) {
        Logger.warn(
          'nav',
          `会话已有历史，网页切到另一条对话：解除绑定 session=${sessionId.slice(-6)} → ${url.slice(0, 70)}`
        )
        this.overlay.unbindSession(sessionId)
        return
      }
      if (shouldRecordUrl) {
        // 同一网页对话不能同时归属两个 Lidow 会话；否则两边发送都会写进同一个
        // 平台对话，历史互相污染。网页侧手动切换对话时宁可忽略这次导航。
        const conflict = this.sessionStoreOf(session.projectId)
          .list()
          .find((m) => m.id !== sessionId && m.providerUrl === url)
        if (conflict) {
          Logger.warn(
            'nav',
            `忽略重复对话 URL session=${sessionId.slice(-6)} 已属于 ${conflict.id.slice(-6)}`
          )
          return
        }
      }
      const cleanTitle = cleanChatTitle(title, descriptor?.name ?? session.providerId)
      // 用户手动命名的会话保持原名，网页按首条消息自动生成的标题不覆盖
      const nextTitle =
        session.titleLocked || !cleanTitle || cleanTitle === session.title
          ? session.title
          : cleanTitle
      const nextUrl = shouldRecordUrl ? url : session.providerUrl
      if (nextUrl === session.providerUrl && nextTitle === session.title) return
      this.sessionStoreOf(session.projectId).update(sessionId, (x) => ({
        ...x,
        providerUrl: nextUrl,
        title: nextTitle
      }))
      // 持久索引：目录以后被删除也能找回这条网页对话
      if (nextUrl) {
        this.projectChats.upsert(session.projectId, {
          sessionId,
          providerId: session.providerId,
          accountId: session.accountId,
          partition: registry.partitionOf(session.providerId, session.accountId),
          home: descriptor?.home,
          url: nextUrl,
          title: nextTitle,
          updatedAt: Date.now()
        })
      }
      if (shouldRecordUrl) {
        Logger.info(
          'nav',
          `providerUrl 已记录 session=${sessionId.slice(-6)} → ${url.slice(0, 70)}`
        )
      }
      if (nextTitle !== session.title) {
        Logger.info('nav', `会话标题同步自网页: ${session.title} → ${nextTitle}`)
        this.emit({ type: 'session-title', sessionId, title: nextTitle })
      }
      const wcId = this.overlay.wcIdOfSession(sessionId)
      if (wcId !== undefined) this.syncChatWatchToWebview(wcId, session.projectId)
    }
    this.overlay.onChatDeleted = (webContentsId, url) =>
      this.handleWebChatDeleted(webContentsId, url)
    this.overlay.onActivateChat = (webContentsId, url, reload) =>
      void this.activateWebChat(webContentsId, url, reload)
    this.overlay.onNativeNewChat = (webContentsId) => this.handleNativeNewChat(webContentsId)
    this.overlay.onAnyReady = (webContentsId) => this.syncChatWatchToWebview(webContentsId)
    this.overlay.onLogin = (webContentsId) => {
      const project = this.activeProject()
      const root = project?.root ?? null
      const sid = this.overlay.sessionOfWebContents(webContentsId)
      const session = sid ? this.sessionOf(sid) : null
      this.overlay.sendCmdToWebContents(webContentsId, {
        kind: 'set-project',
        projectRoot: root,
        // 初始化是「项目级」状态：项目里任一历史会话有轮次，就不该再弹引导。
        // 之前只看当前绑定会话的轮次，新建空会话后会误判成未初始化（实测反复弹窗）。
        // 绑定会话时按项目判断；尚未绑定（新开网页/新窗口）则显示初始化入口，
        // 让用户能把这个新对话接到当前项目（项目已有历史也允许再开一个）。
        // 新网页/新会话必须给初始化入口；只有当前会话确实已有对话/已初始化才压掉
        initialized:
          this.settings.get().pureMode || (session ? this.sessionInitialized(session) : false)
      })
      // 未初始化时把窗口提到前台，引导摆在用户眼前（"强制第一步"）
      if (!root) this.focusWindow()
    }

    app.on('web-contents-created', (_e, wc) => {
      wc.on('destroyed', () => {
        this.overlay.disposeWebContents(wc.id)
        this.wcProviders.delete(wc.id)
      })
      // Google 登录失败有时发生在平台承载的子页面/弹层里，overlay 未必能注入；
      // 主进程侧再兜底提示一次，避免用户只看到 Google 的报错页。
      if (wc.getType() === 'webview') {
        const webServerMode = process.env.LIDOW_WEB_SERVER === '1'
        // Google OAuth 在嵌入 webview 里会被拒绝；桌面版改用同一分区的独立顶层窗口。
        // Web 版（Docker）宿主窗口不可见，只能提示改用邮箱登录或导入 Cookie。
        if (!webServerMode) {
          // 覆盖三种入口：window.open 弹窗、页面跳转、服务端 302。
          wc.setWindowOpenHandler(({ url }) => {
            if (isGoogleAuthUrl(url)) {
              this.openGoogleAuthWindow(wc, url)
              return { action: 'deny' }
            }
            return { action: 'allow' }
          })
          const routeGoogleAuth = (event: { preventDefault(): void }, url: string): void => {
            if (!isGoogleAuthUrl(url)) return
            event.preventDefault()
            this.openGoogleAuthWindow(wc, url)
          }
          wc.on('will-navigate', routeGoogleAuth)
          wc.on('will-redirect', routeGoogleAuth)
        }
        const warnGoogle = (url: string): void => {
          if (!isGoogleAuthUrl(url)) return
          if (Date.now() - this.lastGoogleLoginNoticeAt < 20_000) return
          this.lastGoogleLoginNoticeAt = Date.now()
          this.emit({
            type: 'notice',
            sessionId: '',
            level: 'warn',
            message: webServerMode
              ? 'Google 不允许在应用内浏览器完成登录：请改用邮箱/验证码，或在系统浏览器登录后导入 Cookie。'
              : 'Google 登录页加载在了嵌入页面里：已尝试用独立窗口打开；若没有弹出可重试，或改用邮箱登录。'
          })
        }
        wc.on('did-navigate', (_event, url) => warnGoogle(url))
        wc.on('did-frame-navigate', (_event, url) => warnGoogle(url))
      }
      // 嵌入式 webview 环境漂白：UA 去除 Electron 标识，对齐真实 Chrome（缓解平台"使用环境异常"误判）
      if (wc.getType() === 'webview') {
        try {
          const ua = chromeUserAgent()
          wc.setUserAgent(ua)
          // 同一分区的子 frame/弹窗也要用 Chrome UA，否则 Google 会按 Electron UA 拒绝登录
          wc.session.setUserAgent(ua, 'zh-CN,zh;q=0.9,en;q=0.8')
        } catch {
          /* 忽略 */
        }
      }
    })

    void this.mcp.connectAll()
    // 插件运行时：启动即加载所有已启用插件。必须在末尾——
    // 此前放在构造中段，providerRegistries 还是空的（懒创建），
    // 无 platform 的网页脚本拿不到任何注入目标；dshKv 也尚未赋值。
    for (const p of this.projects) {
      // 目录已删除的项目不要创建 registry：写入 providers.json 会顺手把目录建回来
      if (isProjectRootAvailable(p.root)) this.providerRegistryOf(p.id)
    }
    void this.loadAllPlugins()
    Logger.info('context', 'AppContext 初始化完成')
  }

  /**
   * 用户在网页里点了平台自己的「开启新对话」。
   * 这个动作走平台内部路由，主进程原先收不到信号：webview 仍绑着旧会话，
   * 新对话的消息会被记到旧会话，且重新加载后 projectInitialized 仍为 true，
   * 初始化引导被压掉（用户反复反馈的“新对话没有初始化入口”）。
   * 这里解绑旧会话并下发未初始化状态；用户确认初始化时会新建并绑定会话。
   */
  private handleNativeNewChat(webContentsId: number): void {
    const sessionId = this.overlay.sessionOfWebContents(webContentsId)
    if (sessionId) {
      if (this.loop.isRunning(sessionId)) {
        this.emit({
          type: 'notice',
          sessionId,
          level: 'warn',
          message: '网页已开启新对话：原会话正在执行的任务将停止回传'
        })
      }
      this.overlay.unbindSession(sessionId)
      Logger.info('nav', `网页开启新对话：解绑 ${sessionId.slice(-6)}`)
    }
    const project = this.activeProject()
    this.overlay.sendCmdToWebContents(webContentsId, {
      kind: 'set-project',
      projectRoot: project?.root ?? null,
      initialized: false
    })
    this.syncChatWatchToWebview(webContentsId)
  }

  private focusWindow(): void {
    // 目录选择框打开时不要抢焦点：否则原生对话框会被主窗口压到后面
    if (isDirectoryPickerOpen()) return
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** 设置变更后刷新已打开网页的 hook 配置（每轮注入开关 / 系统提示词） */
  refreshProviderHooks(): void {
    for (const sessionId of this.overlay.boundSessionIds()) {
      const session = this.sessionOf(sessionId)
      if (!session) continue
      const provider = this.providerRegistryOf(session.projectId).get(session.providerId)
      const spec = provider ? HOOKS[provider.id] : undefined
      if (!spec) continue
      void this.overlay.injectHook(
        sessionId,
        buildHookSource(
          spec,
          this.systemPromptFor(sessionId),
          this.settings.get().injectSystemPromptEveryTurn
        )
      )
    }
  }

  /**
   * Google 对 Electron 环境有服务端风控：UA/UA-CH 能过登录页，提交邮箱后仍会跳 rejected。
   * 桌面端优先用系统 Chrome/Edge 完成登录（真实浏览器），再把 Provider Cookie 同步回该分区；
   * 没有系统浏览器或调试通道不可用时，退回同分区顶层窗口。
   */
  private openGoogleAuthWindow(source: WebContents, url: string): void {
    const existing = this.googleAuthWindows.get(source.id)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    if (this.systemLoginBusy) {
      this.emit({
        type: 'notice',
        sessionId: '',
        level: 'warn',
        message: '已有一个 Google 登录窗口在进行中，请先完成它再登录下一个账号。'
      })
      return
    }
    let sourceOrigin = ''
    try {
      sourceOrigin = new URL(source.getURL()).origin
    } catch {
      /* 来源未知时走嵌入窗口 */
    }
    const browserPath = sourceOrigin ? findSystemBrowser() : null
    if (!browserPath) {
      this.openEmbeddedGoogleAuthWindow(source, url)
      return
    }
    this.systemLoginBusy = true
    this.emit({
      type: 'notice',
      sessionId: '',
      level: 'info',
      message:
        'Google 不允许应用内登录：已用系统浏览器打开平台首页。请在浏览器里点「登录」→「使用 Google 账户继续」；Google 可能要求验证码/两步验证，完成后会自动同步。'
    })
    void runSystemBrowserLogin({
      browserPath,
      sourceOrigin,
      session: source.session
    })
      .then((result) => {
        if (result === 'synced') {
          if (!source.isDestroyed()) {
            try {
              // 登录后直接回平台首页：原地址可能还停在 auth/login_with 中间页
              void source.loadURL(`${sourceOrigin}/`).catch(() => {
                try {
                  source.reload()
                } catch {
                  /* 页面已关闭 */
                }
              })
            } catch {
              /* 页面已关闭 */
            }
          }
          this.focusWindow()
          this.emit({
            type: 'notice',
            sessionId: '',
            level: 'info',
            message: '登录成功，登录态已从系统浏览器同步到 Lidow。'
          })
          return
        }
        if (result === 'rejected') {
          this.emit({
            type: 'notice',
            sessionId: '',
            level: 'error',
            message:
              'Google 在系统浏览器里仍拒绝了这个账号的第三方登录（常见于账号风控或高级保护）。请改用平台的邮箱/密码登录，或换一个 Google 账号。'
          })
          return
        }
        if (result === 'aborted') {
          this.emit({
            type: 'notice',
            sessionId: '',
            level: 'warn',
            message: '登录未完成（浏览器已关闭或超时），可重试或改用邮箱/验证码登录。'
          })
          return
        }
        this.openEmbeddedGoogleAuthWindow(source, url)
      })
      .catch((e) => {
        Logger.warn(
          'auth',
          `系统浏览器 Google 登录异常: ${e instanceof Error ? e.message : String(e)}`
        )
        this.openEmbeddedGoogleAuthWindow(source, url)
      })
      .finally(() => {
        this.systemLoginBusy = false
      })
  }

  /**
   * 嵌入窗口兜底：同一 partition 起独立顶层窗口，窗口关闭后重载网页。
   * Google 可能仍按环境拒绝，主要用于没有系统 Chrome/Edge 的环境。
   */
  private openEmbeddedGoogleAuthWindow(source: WebContents, url: string): void {
    const existing = this.googleAuthWindows.get(source.id)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    const win = new BrowserWindow({
      width: 520,
      height: 780,
      show: false,
      title: 'Google 登录（完成后会自动同步）',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: source.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.webContents.setUserAgent(chromeUserAgent())
    this.googleAuthWindows.set(source.id, win)
    const reloadSource = (): void => {
      if (!source.isDestroyed()) {
        try {
          source.reload()
        } catch {
          /* 页面已关闭 */
        }
      }
      this.focusWindow()
    }
    win.on('closed', () => {
      this.googleAuthWindows.delete(source.id)
      reloadSource()
    })
    let origin = ''
    try {
      origin = new URL(source.getURL()).origin
    } catch {
      /* 来源未知时只能等用户手动关闭 */
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      // 等平台把 Set-Cookie 落盘后再关窗口，closed 事件会重载网页
      setTimeout(() => {
        if (!win.isDestroyed()) win.close()
      }, 800)
    }
    win.webContents.on('did-navigate', (_event, target) => {
      try {
        const u = new URL(target)
        if (
          origin &&
          u.origin === origin &&
          !/\/(?:auth|login|signin|sign-in|oauth)/i.test(u.pathname)
        )
          finish()
      } catch {
        /* 忽略无效 URL */
      }
    })
    // 某些网络环境里 Google 仍可能拒绝（策略会动态调整），给出明确退路
    win.webContents.on('did-finish-load', () => {
      void win.webContents
        .executeJavaScript(`(document.body && document.body.innerText || '').slice(0, 2500)`)
        .then((text) => {
          if (
            !/无法登录|可能不安全|browser or app may not be secure|disallowed_useragent/i.test(
              String(text)
            )
          )
            return
          Logger.warn('auth', 'Google 登录在独立窗口仍被拒绝')
          this.emit({
            type: 'notice',
            sessionId: '',
            level: 'warn',
            message: 'Google 仍拒绝了独立窗口登录，请改用邮箱/验证码登录。'
          })
        })
        .catch(() => undefined)
    })
    // 先把 UA 品牌补成真正的 Chrome，再发首个 Google 请求：判定发生在请求到达时。
    // 必须先有个空白页面，否则 CDP 命令没有 renderer 可执行，会一直挂住。
    const openAuthPage = async (): Promise<void> => {
      try {
        await win.loadURL('about:blank')
      } catch {
        /* 空白页加载失败也继续尝试 */
      }
      const hinted = await applyChromeClientHints(win.webContents)
      if (!hinted) Logger.warn('auth', 'UA client hints 覆盖失败，Google 可能仍拒绝登录')
      if (win.isDestroyed()) return
      // 先显示再加载：loadURL 可能因重定向 reject，窗口不能因此一直藏着
      win.show()
      try {
        await win.loadURL(url)
      } catch (e) {
        Logger.warn('auth', `Google 登录窗口打开失败: ${String(e)}`)
      }
    }
    void openAuthPage()
    Logger.info('auth', `Google 登录改用独立窗口: ${new URL(url).host}`)
  }

  /**
   * 把网页载体切到指定会话（自动续接与子代理共用）。
   *
   * webview 每个平台只有一个，靠 bindings 换绑。关键是换绑后页面必须落到
   * 目标会话「自己的」对话上：有 providerUrl 就导航回去（平台会从服务端
   * 恢复完整历史），全新会话才开新聊天。否则子代理跑完切回父会话时，
   * 页面停在子代理的对话里，父会话后续消息全部发进错误上下文。
   */
  private async rebindWebview(sessionId: string, fromSessionId?: string): Promise<void> {
    // 必须用调用方指定的来源会话取 webview：全局 lastSessionId 可能已被
    // 另一个标签的发送/切换改走，多标签下会把子代理提示送进别人的对话。
    const prev = fromSessionId ?? this.lastSessionId
    const prevWcId = prev ? this.overlay.wcIdOfSession(prev) : undefined
    if (prev && prev !== sessionId) this.overlay.unbindSession(prev)
    this.lastSessionId = sessionId
    if (prevWcId) this.overlay.bindSession(sessionId, prevWcId)
    this.configureOverlay(sessionId)
    if (prev !== sessionId) await this.landSession(sessionId)
  }

  /**
   * 让页面落到目标会话「自己的」对话上（cuckoo 的 navigateSession 同款）。
   * 有 providerUrl → 导航回去（平台从服务端恢复完整历史）；
   * 全新会话 → 开新聊天。切回旧会话时若不做这一步，页面停在别的对话里，
   * 后续消息全部发进错误上下文。
   */
  async landSession(sessionId: string): Promise<void> {
    const wcId = this.overlay.wcIdOfSession(sessionId)
    const wc = wcId ? webContents.fromId(wcId) : undefined
    if (!wc) return
    const session = this.sessionOf(sessionId)
    if (session?.providerUrl) {
      if (wc.getURL() !== session.providerUrl)
        await wc.loadURL(session.providerUrl).catch(() => undefined)
      return
    }
    // 没有平台对话 URL：这个会话要开一条新的网页对话，旧对话里的系统提示词
    // 不再有效，必须重置标记，否则后续消息会误以为 prompt 已经发过。
    if (session) {
      this.sessionStoreOf(session.projectId).update(sessionId, (s) => ({
        ...s,
        providerUrl: undefined,
        systemPromptSent: false
      }))
    }
    this.overlay.sendCmd(sessionId, { kind: 'new-chat' })
  }

  /** 任务完成系统通知：窗口失焦才弹（前台用户看得见结果，不打扰） */
  private notifyIfHidden(sessionId: string, snippet: string): void {
    try {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win && win.isFocused()) return
      if (!Notification.isSupported()) return
      const session = this.sessionOf(sessionId)
      new Notification({
        title: `Lidow 任务完成${session ? `：${session.title.slice(0, 20)}` : ''}`,
        body: snippet || 'AI 已给出最终答复',
        silent: false
      }).show()
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  /**
   * 插件运行时接线。
   *
   * 之前的状态：市场能装、能卸，但装上的插件从来没有被执行过 ——
   * 没有任何代码在启动或安装后遍历插件目录加载 entry/dsh/webScript，
   * 用户装的是一个"摆设"。这里补齐加载链路：
   *  - dsh      → DSH host.loadPluginEntry（导出 register(ctx)，ctx 含全部兼容服务）
   *  - entry    → 动态 import 后调 register(pluginApi)
   *  - webScript→ 按平台登记，webview configure 时注入页面
   */
  async loadAllPlugins(): Promise<void> {
    this.webScripts.clear()
    for (const p of this.plugins.list()) {
      if (!p.enabled) continue
      try {
        if (p.dsh) {
          await this.dsh.loadPluginEntry(join(p.dir, p.dsh))
          Logger.info('plugins', `DSH 扩展已加载: ${p.id}`)
        }
        if (p.entry) {
          const mod = (await import(pathToFileURL(join(p.dir, p.entry)).href)) as {
            register?: (api: unknown) => void | Promise<void>
          }
          if (typeof mod.register === 'function') {
            await mod.register({
              id: p.id,
              log: (msg: string) => Logger.info(`plugin:${p.id}`, msg),
              notify: (message: string) =>
                this.emit({ type: 'notice', sessionId: '', level: 'info', message })
            })
          }
          Logger.info('plugins', `插件入口已加载: ${p.id}`)
        }
        if (p.webScript) {
          const code = readFileSync(join(p.dir, p.webScript), 'utf-8')
          // platform 缺省 = 注入所有平台的网页（此前错误地用了项目 id 当 key，
          // 无 platform 的脚本永远匹配不上任何 webview）
          const targets = p.platform
            ? [p.platform]
            : [
                ...new Set(
                  [...this.providerRegistries.values()].flatMap((r) => r.list().map((x) => x.id))
                )
              ]
          for (const id of targets) {
            const arr = this.webScripts.get(id) ?? []
            arr.push(code)
            this.webScripts.set(id, arr)
          }
          Logger.info('plugins', `网页脚本已登记: ${p.id} → ${targets.join(',')}`)
        }
      } catch (e) {
        Logger.warn(
          'plugins',
          `插件 ${p.id} 加载失败: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }

  /** 已启用插件的网页脚本（providerId → code 列表），configure 时注入 webview */
  webScriptsOf(providerId: string): string[] {
    return this.webScripts.get(providerId) ?? []
  }

  private apiEventListeners = new Set<
    (event: { type: string; sessionId: string; [k: string]: unknown }) => void
  >()

  /** 内置 HTTP API 等进程内订阅者：与渲染层事件同源，不经过 IPC/SSE */
  onEvent(
    listener: (event: { type: string; sessionId: string; [k: string]: unknown }) => void
  ): () => void {
    this.apiEventListeners.add(listener)
    return () => this.apiEventListeners.delete(listener)
  }

  emit(event: { type: string; sessionId: string; [k: string]: unknown }): void {
    this.emitFn?.(event)
    for (const listener of this.apiEventListeners) {
      try {
        listener(event)
      } catch {
        /* 订阅方异常不能影响主事件流 */
      }
    }
  }

  /** 向 webview 下发对应 provider 的 DOM 适配器（bindSession 与 ready 双路径调用） */
  configureOverlay(sessionId: string): void {
    const session = this.sessionOf(sessionId)
    if (!session) return
    const provider = this.providerRegistryOf(session.projectId).get(session.providerId)
    if (!provider) return
    this.overlay.sendCmd(sessionId, {
      kind: 'configure',
      sessionId,
      adapter: provider.adapter
    })
    // 告诉网页侧有没有工作目录：没有就由 overlay 在页面里弹初始化引导
    // （cuckoo 的 first-time-dialog 同款位置，用户准备说话的地方）。
    // 用「会话所属项目」而不是全局 activeProject —— 多项目并行时，
    // 全局值可能指向另一个项目，会让当前会话明明没目录却看不到引导。
    const ownProject = this.projects.find((p) => p.id === session.projectId)
    // 已有轮次的会话 / 纯净模式（网页被对话面板遮住，弹窗只会藏在后面）不再弹引导。
    // 新会话在普通视图下仍会提示一次初始化；退出纯净模式会重新下发并补弹。
    const pure = this.settings.get().pureMode
    this.overlay.sendCmd(sessionId, {
      kind: 'set-project',
      projectRoot: ownProject?.root ?? null,
      // 页面级判断：新窗口/新对话（空会话）即使项目已有历史，也要出初始化入口；
      // 已有 providerUrl/轮次/已发过系统提示词的会话才不再提示。
      initialized: pure || this.sessionInitialized(session)
    })
    // 网络层 hook 由主进程注入主世界（preload 的 webFrame 在隔离世界，hook 不到页面 fetch）。
    // 同时把系统提示词带进去：用户在网页输入框里自己发消息时，hook 会把它拼进请求体，
    // 这样 AI 也拿得到工具协议与工作目录（否则它会答「我没有文件系统访问权限」）。
    const spec = HOOKS[provider.id]
    if (spec) {
      void this.overlay.injectHook(
        sessionId,
        buildHookSource(
          spec,
          this.systemPromptFor(sessionId),
          this.settings.get().injectSystemPromptEveryTurn
        )
      )
    }
    // 插件网页脚本：登记后按「页面加载完成」时机注入（直接 executeJs 会在
    // 页面加载期打在 about:blank 上静默丢失；刷新后也由 did-finish-load 重放）
    this.overlay.setWebScripts(sessionId, this.webScriptsOf(provider.id))
    void this.overlay.injectWebScripts(sessionId).catch((e) => {
      Logger.warn('plugins', `网页脚本注入失败: ${e instanceof Error ? e.message : String(e)}`)
    })
    const wcId = this.overlay.wcIdOfSession(sessionId)
    if (wcId !== undefined) this.syncChatWatchToWebview(wcId, session.projectId)
  }

  /** 把网页侧登录态/账号名写回 provider 账号（默认分区或显式账号） */
  private updateAccountMetaFromWeb(
    webContentsId: number,
    patch: { label?: string; loggedIn?: boolean }
  ): void {
    const sid = this.overlay.sessionOfWebContents(webContentsId)
    if (!sid) return
    const current = this.sessionOf(sid)
    if (!current) return
    const reg = this.providerRegistryOf(current.projectId)
    const provider = reg.get(current.providerId)
    if (!provider) return
    const accountId = current.accountId
    let changed = false
    if (!accountId || accountId === '__default__') {
      const labelChanged = Boolean(patch.label && patch.label !== provider.defaultAccountLabel)
      const loginChanged =
        patch.loggedIn !== undefined && patch.loggedIn !== provider.defaultLoggedIn
      if (labelChanged || loginChanged) {
        reg.setDefaultAccountMeta(provider.id, patch)
        changed = true
      }
    } else {
      const account = provider.accounts.find((a) => a.id === accountId)
      if (!account) return
      // 自动名（账号 N 或上次检测到的名字）可被网页侧更新；
      // 以后用户手动命名（labelAuto=false）不会被覆盖
      const labelChanged = Boolean(
        patch.label && account.labelAuto !== false && patch.label !== account.label
      )
      const loginChanged = patch.loggedIn !== undefined && patch.loggedIn !== account.loggedIn
      if (labelChanged || loginChanged) {
        reg.setAccountMeta(provider.id, accountId, patch)
        changed = true
      }
    }
    if (changed) {
      this.emit({ type: 'providers-changed', projectId: current.projectId, sessionId: '' })
    }
  }

  /** 账号登录态：优先用 Cookie 判断（无需打开网页）；判断不了的平台返回 undefined */
  private async partitionLoginState(
    projectId: string,
    providerId: string,
    accountId?: string
  ): Promise<boolean | undefined> {
    const reg = this.providerRegistryOf(projectId)
    const provider = reg.get(providerId)
    if (!provider) return undefined
    const patterns: Record<string, RegExp[]> = {
      chatgpt: [/^__Secure-next-auth\.session-token/, /^__Secure-authjs\.session-token/],
      gemini: [/^(SID|SSID|HSID|__Secure-1PSID|__Secure-3PSID)$/],
      claude: [/^sessionKey$/, /^__Secure-next-auth\.session-token/]
      // deepseek 等把登录态放 localStorage，Cookie 判断不了，交给页面上报
    }
    const pats = patterns[providerId]
    if (!pats) return undefined
    try {
      const ses = session.fromPartition(reg.partitionOf(providerId, accountId))
      const cookies = await ses.cookies.get({ url: provider.home })
      return cookies.some((c) => pats.some((re) => re.test(c.name)))
    } catch {
      return undefined
    }
  }

  /** 列表 + 登录态：ChatGPT/Gemini 用 Cookie 直接判断，其余用页面上报的持久值 */
  async listProvidersWithLogin(projectId: string): Promise<ProviderDescriptor[]> {
    const reg = this.providerRegistryOf(projectId)
    const list = reg.list().map((p) => ({
      ...p,
      accounts: p.accounts.map((a) => ({ ...a }))
    }))
    await Promise.all(
      list.map(async (p) => {
        const def = await this.partitionLoginState(projectId, p.id)
        if (def !== undefined) p.defaultLoggedIn = def
        await Promise.all(
          p.accounts.map(async (a) => {
            const st = await this.partitionLoginState(projectId, p.id, a.id)
            if (st !== undefined) a.loggedIn = st
          })
        )
      })
    )
    return list
  }

  private registerEcosystemTools(): void {
    for (const t of createEcosystemTools({
      memory: this.memory,
      plans: this.plans,
      projectRoot: () => this.activeProject()?.root ?? '',
      currentSessionId: () => this.lastSessionId,
      onPlanProposed: (sessionId, plan) => this.emit({ type: 'plan-proposed', sessionId, plan })
    })) {
      this.tools.register(t)
    }
  }

  private registerMcpTool(): void {
    const mcpCall: ToolDef = {
      name: 'mcpCall',
      description: '调用 MCP 服务器的工具（listMcpTools 可查可用项）。',
      parameters: {
        server: { type: 'string', description: 'MCP 服务名', required: true },
        tool: { type: 'string', description: '工具名', required: true },
        args: { type: 'string', description: 'JSON 参数字符串' }
      },
      dangerLevel: 'safe',
      run: async (input) => {
        let args: Record<string, unknown>
        try {
          args = JSON.parse(String(input.args ?? '{}')) as Record<string, unknown>
        } catch {
          return { ok: false, output: '', error: 'args 必须是 JSON 字符串' }
        }
        try {
          const out = await this.mcp.callTool(String(input.server), String(input.tool), args)
          return { ok: true, output: out }
        } catch (e) {
          return { ok: false, output: '', error: String(e) }
        }
      }
    }
    this.tools.register(mcpCall)
  }

  private registerKbTool(): void {
    const kbSearch: ToolDef = {
      name: 'kbSearch',
      description: '检索已挂载的本地知识库。',
      parameters: {
        kb: { type: 'string', description: '知识库名', required: true },
        query: { type: 'string', description: '查询语句', required: true }
      },
      dangerLevel: 'safe',
      run: async (input) => {
        const kb = this.knowledge
          .list()
          .find((b) => b.name === String(input.kb) || b.id === String(input.kb))
        if (!kb) return { ok: false, output: '', error: `知识库不存在: ${String(input.kb)}` }
        const hits = this.knowledge.search(kb.id, String(input.query))
        if (hits.length === 0) return { ok: true, output: '知识库中无匹配内容' }
        return {
          ok: true,
          output: hits.map((h) => `[${h.path}] (相关度 ${h.score})\n${h.snippet}`).join('\n\n')
        }
      }
    }
    this.tools.register(kbSearch)
  }

  /**
   * 子代理执行器（cuckoo 的 subagent 能力）：
   * 开一个独立会话、复用当前网页载体跑完子任务，回收最终文本后清理现场。
   *
   * 与 cuckoo 开新窗口的实现不同——Lidow 单窗口，子代理在主循环「执行工具」
   * 的间隙里运行（此时主循环不在等回复，网页空闲），跑完把绑定切回父会话。
   * agents 目录（项目 .lidow/agents 与用户级）里的代理可用其系统提示词与人设。
   */
  private registerAgentTool(): void {
    const def: ToolDef = {
      name: 'runAgent',
      description:
        '派一个子代理独立完成子任务，返回它的最终答复。' +
        '适合：并行拆分子问题、隔离探索性工作、避免大量中间输出污染主对话上下文。' +
        'agent 参数可选，传 agents 目录里的代理名（缺省用通用子代理）。',
      parameters: {
        agent: {
          type: 'string',
          description: '代理名（agents 目录中定义，可省略）',
          required: false
        },
        task: { type: 'string', description: '要交给子代理完成的任务描述', required: true }
      },
      dangerLevel: 'safe',
      run: async (input, ctx) => {
        const task = String(input.task ?? '').trim()
        if (!task) return { ok: false, output: '', error: 'task 必填' }
        const agentName = String(input.agent ?? '').trim()

        // 以工具上下文里的会话为准：任务运行中切换活动会话不会把父子关系挂错
        const parentSessionId = ctx.sessionId || this.lastSessionId
        const parent = parentSessionId ? this.sessionOf(parentSessionId) : null
        const project = parent
          ? this.projects.find((p) => p.id === parent.projectId)
          : this.activeProject()
        if (!project) return { ok: false, output: '', error: '没有可用项目（子代理需要工作目录）' }
        if (!parentSessionId || !parent) return { ok: false, output: '', error: '当前没有活动会话' }

        // 代理定义：项目级优先于用户级
        let persona = ''
        if (agentName) {
          const agent = listAgents(project.root).find((a) => a.name === agentName)
          if (!agent) {
            return {
              ok: false,
              output: '',
              error: `未找到代理「${agentName}」，可用：${
                listAgents(project.root)
                  .map((a) => a.name)
                  .join(', ') || '（无）'
              }`
            }
          }
          persona = agent.body ?? ''
        }

        const providerId = parent.providerId
        const child = this.sessionStoreOf(project.id).create(
          project.id,
          providerId,
          undefined,
          parent.accountId
        )
        this.sessionStoreOf(project.id).update(child.id, (s) => ({
          ...s,
          title: `[子代理] ${agentName || '通用'}：${task.slice(0, 18)}`
        }))

        const prompt = [
          persona,
          '---',
          `任务：${task}`,
          '',
          '完成后直接给出最终结果（不要再调用工具）。'
        ]
          .filter(Boolean)
          .join('\n\n')

        Logger.info(
          'loop',
          `子代理启动 session=${child.id} agent=${agentName || '通用'} 任务=${task.slice(0, 40)}`
        )
        try {
          // 换绑网页 → 跑子任务 → 切回父会话（工具执行间隙网页本来就空闲）
          await this.rebindWebview(child.id, parentSessionId)
          await this.loop.run(child.id, prompt)
          const turns = this.sessionStoreOf(project.id).get(child.id)?.turns ?? []
          const last = [...turns].reverse().find((t) => t.role === 'assistant')
          const output = last?.text ?? ''
          Logger.info('loop', `子代理完成 session=${child.id} 输出 ${output.length} 字`)
          return {
            ok: true,
            output: output
              ? `【子代理${agentName ? ` ${agentName}` : ''}的最终答复】\n${output.slice(0, 8000)}`
              : '子代理没有产出文本回复（可能被中断）'
          }
        } catch (e) {
          return {
            ok: false,
            output: '',
            error: `子代理执行失败：${e instanceof Error ? e.message : String(e)}`
          }
        } finally {
          // 必须先把网页切回父会话、再清理子会话：父会话的绑定要靠子会话
          // 当前持有的 wcId 来恢复。先解绑的话 rebind 拿不到 wcId，父会话
          // 失去网页绑定，主循环下一轮直接报「网页未连接」。
          if (parentSessionId) {
            await this.rebindWebview(parentSessionId, child.id)
            this.emit({ type: 'session-updated', sessionId: parentSessionId })
          }
          this.overlay.unbindSession(child.id)
          this.sessionStoreOf(project.id).delete(child.id)
        }
      }
    }
    this.tools.register(def)
  }

  // ---------- 项目 ----------

  activeProject(): ProjectInfo | null {
    const id = this.projectStore.get().activeProjectId
    return this.projects.find((p) => p.id === id) ?? null
  }

  activeProjectId(): string | null {
    return this.projectStore.get().activeProjectId
  }

  /** 项目目录是否仍可用（存在且是文件夹） */
  projectAvailable(projectId: string): boolean {
    const project = this.projects.find((p) => p.id === projectId)
    return Boolean(project && isProjectRootAvailable(project.root))
  }

  /** 给渲染层的项目快照：带上运行时 missing 标记，不写回 projects.json */
  projectsSnapshot(): ProjectInfo[] {
    return this.projects.map((p) => ({
      ...p,
      missing: !isProjectRootAvailable(p.root),
      webChatCount: this.projectChatRefs(p.id).length
    }))
  }

  /** 项目关联的网页对话：本地会话 + 持久索引（目录删除后仍能找到网页端） */
  projectChatRefs(projectId: string): ProjectChatRef[] {
    const byUrl = new Map<string, ProjectChatRef>()
    for (const ref of this.projectChats.list(projectId)) byUrl.set(ref.url, ref)
    const project = this.projects.find((p) => p.id === projectId)
    if (project && isProjectRootAvailable(project.root)) {
      try {
        const store = this.sessionStoreOf(projectId)
        for (const m of store.list()) {
          if (!m.providerUrl) continue
          byUrl.set(m.providerUrl, {
            sessionId: m.id,
            providerId: m.providerId,
            accountId: m.accountId,
            url: m.providerUrl,
            title: m.title,
            updatedAt: m.updatedAt
          })
        }
      } catch {
        /* 目录不可读：只用索引 */
      }
    }
    return [...byUrl.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 网页对话确认删除后（本地或网页侧发起），从索引里移除，避免重复尝试 */
  forgetProjectChat(url: string | undefined): void {
    if (url) this.projectChats.removeByUrl(url)
  }

  /** 旧索引没有 partition：用同账号记录或默认分区兜底 */
  projectChatPartition(ref: ProjectChatRef): string {
    return (
      ref.partition ||
      this.projectChats.findPartition(ref.providerId, ref.accountId) ||
      `persist:lidow-${ref.providerId}-default`
    )
  }

  /** 旧索引没有 home：用同平台记录兜底 */
  projectChatHome(ref: ProjectChatRef): string | undefined {
    return ref.home || this.projectChats.findHome(ref.providerId)
  }

  /** 网页对话已删除、但项目还保留时：清掉本地会话的网页地址，避免下次重复删除 */
  clearSessionWebUrl(sessionId: string): void {
    if (!sessionId) return
    const session = this.sessionOf(sessionId)
    if (!session) return
    const project = this.projects.find((p) => p.id === session.projectId)
    if (!project || !isProjectRootAvailable(project.root)) return
    try {
      this.loop.stop(sessionId, 'all')
      this.sessionStoreOf(project.id).update(sessionId, (s) => ({ ...s, providerUrl: undefined }))
      this.emit({ type: 'session-updated', sessionId })
      const wcId = this.overlay.wcIdOfSession(sessionId)
      if (wcId !== undefined) {
        this.overlay.unbindSession(sessionId)
        this.overlay.sendCmdToWebContents(wcId, { kind: 'new-chat' })
      }
    } catch {
      /* 会话可能已被移除 */
    }
  }

  /** renderer 打开标签时登记该 webview 的平台/账号（无会话初始化时使用） */
  registerWebviewProvider(webContentsId: number, providerId: string, accountId?: string): void {
    if (!providerId) return
    this.wcProviders.set(webContentsId, { providerId, accountId })
  }

  webviewProvider(webContentsId: number): { providerId: string; accountId?: string } | undefined {
    return this.wcProviders.get(webContentsId)
  }

  /** 同一平台/账号的网页载体（会话已解绑时也用它执行网页端删除） */
  webContentsIdForProvider(providerId: string, accountId?: string): number | undefined {
    const want = accountKey(accountId)
    for (const [id, info] of this.wcProviders) {
      if (info.providerId !== providerId) continue
      if (accountKey(info.accountId) !== want) continue
      const wc = webContents.fromId(id)
      if (wc && !wc.isDestroyed()) return id
    }
    return undefined
  }

  /**
   * 网页侧「项目文件夹」数据：当前网页 origin 下，各 Lidow 项目已经绑定过的对话。
   * 只包含本地存在 providerUrl 的会话；未绑定/未发送过的空会话不入文件夹。
   */
  projectFoldersForWebContents(webContentsId: number): ProjectFolderData | null {
    const wc = webContents.fromId(webContentsId)
    let host = ''
    try {
      host = new URL(wc?.getURL() ?? '').host
    } catch {
      /* about:blank */
    }
    // 目前只在 DeepSeek 网页侧提供项目文件夹/时间线增强
    if (!/(^|\.)deepseek\.com$/i.test(host)) return null
    const info = this.wcProviders.get(webContentsId)
    const projects: ProjectFolderProject[] = []
    for (const project of this.projects) {
      let store: SessionStore
      try {
        store = this.sessionStoreOf(project.id)
      } catch {
        continue
      }
      const chats = store
        .list()
        .filter((m) => {
          if (!m.providerUrl) return false
          if (info?.providerId && m.providerId !== info.providerId) return false
          if (info?.accountId && accountKey(m.accountId) !== accountKey(info.accountId))
            return false
          try {
            return new URL(m.providerUrl).host === host
          } catch {
            return false
          }
        })
        .map((m) => ({ sessionId: m.id, title: m.title || '未命名会话', url: m.providerUrl! }))
      if (chats.length > 0)
        projects.push({ id: project.id, name: project.name, root: project.root, chats })
    }
    return { projects, activeProjectId: this.activeProjectId() }
  }

  syncProjectFoldersToWebview(webContentsId: number): void {
    const folders = this.projectFoldersForWebContents(webContentsId)
    if (!folders) return
    this.overlay.sendCmdToWebContents(webContentsId, { kind: 'project-folders', folders })
  }

  /**
   * 网页侧点击了一个已知项目对话：切换 Lidow 活动项目/会话并绑定当前 webview。
   * 页面点击已在 overlay 中 preventDefault，这里负责导航到目标对话。
   */
  async activateWebChat(webContentsId: number, rawUrl: string, reload = false): Promise<void> {
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return
    const key = chatUrlKey(rawUrl)
    if (!key) return
    const info = this.wcProviders.get(webContentsId)
    let found: { project: ProjectInfo; meta: SessionMeta } | null = null
    for (const project of this.projects) {
      let store: SessionStore
      try {
        store = this.sessionStoreOf(project.id)
      } catch {
        continue
      }
      for (const meta of store.list()) {
        if (chatUrlKey(meta.providerUrl) !== key) continue
        if (info?.providerId && meta.providerId !== info.providerId) continue
        if (info?.accountId && accountKey(meta.accountId) !== accountKey(info.accountId)) continue
        found = { project, meta }
        break
      }
      if (found) break
    }
    if (!found) {
      this.emit({
        type: 'notice',
        sessionId: '',
        level: 'warn',
        message: '这个网页对话不属于任何 Lidow 项目'
      })
      return
    }
    const { project, meta } = found
    const session = this.sessionStoreOf(project.id).get(meta.id)
    if (!session) return
    const prev = this.overlay.sessionOfWebContents(webContentsId)
    if (prev && prev !== session.id) {
      if (this.loop.isRunning(prev)) this.loop.stop(prev, 'all')
      this.overlay.unbindSession(prev)
    }
    project.lastOpenedAt = Date.now()
    this.projectStore.set({ projects: this.projects, activeProjectId: project.id })
    this.projectDirs.set(project.id, project.root)
    this.overlay.bindSession(session.id, webContentsId)
    this.lastSessionId = session.id
    this.registerWebviewProvider(webContentsId, session.providerId, session.accountId)
    this.configureOverlay(session.id)
    this.emit({
      type: 'web-session-activated',
      sessionId: session.id,
      projectId: project.id,
      providerId: session.providerId,
      accountId: session.accountId
    })
    this.emit({
      type: 'notice',
      sessionId: session.id,
      level: 'info',
      message: `已切回项目「${project.name}」：${session.title}`
    })
    // 先把新的活动项目推给网页：面板高亮立即更新，不用等导航完成
    this.syncProjectFoldersToWebview(webContentsId)
    const targetUrl = session.providerUrl || rawUrl
    if (chatUrlKey(wc.getURL()) === key) {
      // 项目文件夹点回“当前 URL”：页面可能停在上一次失败切换留下的旧对话，
      // 仅显式 reload 请求时强制重载对齐；原生侧栏点击仍保持无刷新。
      if (reload) {
        try {
          wc.reload()
        } catch {
          /* 页面已销毁 */
        }
      }
    } else {
      // 优先点侧栏里已有的链接做 SPA 切换；找不到才整页 loadURL。
      // 整页 reload 会让注入的项目文件夹消失 1~3 秒，用户感知就是“切对话很慢”。
      const opened = await this.overlay.openChatInPage(session.id, targetUrl)
      if (opened) {
        for (let i = 0; i < 15; i++) {
          if (chatUrlKey(wc.getURL()) === key) break
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      if (chatUrlKey(wc.getURL()) !== key) {
        await wc.loadURL(targetUrl).catch(() => undefined)
      }
    }
    this.syncProjectFoldersToWebview(webContentsId)
    Logger.info('project', `网页对话切回项目 ${project.name}: ${session.title}`)
  }

  /** 下发给网页的“本地会话地址”清单：用户在网页侧删除对话时据此反向同步 */
  syncChatWatchToWebview(webContentsId: number, projectId?: string): void {
    // 项目文件夹与删除监听一起刷新，保证标题/归属变化后网页侧栏同步
    this.syncProjectFoldersToWebview(webContentsId)
    const project = projectId ? this.projects.find((p) => p.id === projectId) : this.activeProject()
    if (!project) return
    const info = this.wcProviders.get(webContentsId)
    let urls: string[]
    try {
      const store = this.sessionStoreOf(project.id)
      const keys = new Set<string>()
      for (const m of store.list()) {
        if (info?.providerId && m.providerId !== info.providerId) continue
        if (info?.accountId && accountKey(m.accountId) !== accountKey(info.accountId)) continue
        const key = chatUrlKey(m.providerUrl)
        if (key) keys.add(key)
      }
      urls = [...keys]
    } catch {
      return
    }
    this.overlay.sendCmdToWebContents(webContentsId, { kind: 'watch-chats', urls })
  }

  /** 本地删除前打标：网页侧自动删除也会点「删除」，不能反向再触发一次 */
  markWebChatDeleteInFlight(rawUrl: string | undefined): void {
    const key = chatUrlKey(rawUrl)
    if (!key) return
    const stamp = Date.now()
    this.webChatDeletesInFlight.set(key, stamp)
    const timer = setTimeout(() => {
      if (this.webChatDeletesInFlight.get(key) === stamp) this.webChatDeletesInFlight.delete(key)
    }, 15_000)
    timer.unref?.()
  }

  private isWebChatDeleteInFlight(rawUrl: string): boolean {
    const key = chatUrlKey(rawUrl)
    const stamp = this.webChatDeletesInFlight.get(key)
    return stamp !== undefined && Date.now() - stamp < 15_000
  }

  /** 网页侧删除了对话：把指向同一 URL 的本地会话一并移除（纯净模式列表同步） */
  private handleWebChatDeleted(webContentsId: number, rawUrl: string): void {
    const key = chatUrlKey(rawUrl)
    if (!key) return
    // 网页端已经删掉了：索引里的记录同步移除（即使本地没有匹配会话）
    this.projectChats.removeByUrl(rawUrl)
    if (this.isWebChatDeleteInFlight(key)) {
      Logger.info('session', `忽略本地删除操作触发的网页回调: ${key.slice(0, 70)}`)
      return
    }
    const info = this.wcProviders.get(webContentsId)
    const removed: { projectId: string; title: string }[] = []
    for (const project of this.projects) {
      let store: SessionStore
      try {
        store = this.sessionStoreOf(project.id)
      } catch {
        continue
      }
      for (const meta of store.list()) {
        if (info?.providerId && meta.providerId !== info.providerId) continue
        if (info?.accountId && accountKey(meta.accountId) !== accountKey(info.accountId)) continue
        if (chatUrlKey(meta.providerUrl) !== key) continue
        this.loop.stop(meta.id, 'all')
        this.overlay.unbindSession(meta.id)
        store.delete(meta.id)
        if (this.lastSessionId === meta.id) this.lastSessionId = ''
        removed.push({ projectId: project.id, title: meta.title })
        this.emit({ type: 'session-deleted', sessionId: meta.id, title: meta.title })
      }
    }
    if (removed.length === 0) {
      Logger.info('session', `网页端删除未匹配本地会话: ${key.slice(0, 70)}`)
      return
    }
    const affected = [...new Set(removed.map((r) => r.projectId))]
    for (const projectId of affected) {
      const store = this.sessionStoreOf(projectId)
      const stillInitialized = store.list().some((m) => {
        const s = store.get(m.id)
        return Boolean(s && (s.turns.length > 0 || s.providerUrl || s.systemPromptSent))
      })
      if (!stillInitialized) this.resetProjectInitialization(projectId, webContentsId)
    }
    this.syncChatWatchToWebview(webContentsId)
    const titles = [...new Set(removed.map((r) => r.title).filter(Boolean))]
    this.emit({
      type: 'notice',
      sessionId: '',
      level: 'info',
      message:
        removed.length === 1
          ? `网页端对话已删除，本地会话已同步移除${titles[0] ? `：${titles[0]}` : ''}`
          : `网页端已删除 ${removed.length} 个对话，本地会话已同步移除`
    })
    Logger.info('session', `网页端删除已同步本地 session=${removed.map((r) => r.title).join('、')}`)
  }

  /** 确认就绪的项目（一旦有带轮次的会话就缓存为已初始化，避免每次 configure 扫盘） */
  private initializedProjects = new Set<string>()

  /**
   * 删除全部已初始化会话后，让项目重新回到未初始化状态：
   * 清缓存并通知相关网页重新显示首次引导（否则网页仍以为项目已初始化）。
   */
  resetProjectInitialization(projectId: string, extraWcId?: number): void {
    this.initializedProjects.delete(projectId)
    const project = this.projects.find((p) => p.id === projectId)
    if (!project) return
    const targets = new Set<number>()
    if (extraWcId !== undefined) targets.add(extraWcId)
    for (const sid of this.overlay.boundSessionIds()) {
      if (this.sessionOf(sid)?.projectId !== projectId) continue
      const wc = this.overlay.wcIdOfSession(sid)
      if (wc !== undefined) targets.add(wc)
    }
    for (const wc of targets) {
      this.overlay.sendCmdToWebContents(wc, {
        kind: 'set-project',
        projectRoot: project.root,
        initialized: false
      })
      this.overlay.sendCmdToWebContents(wc, { kind: 'reset-first-run' })
    }
    Logger.info('project', `项目回到未初始化状态: ${project.root} targets=${targets.size}`)
  }

  /** 当前会话是否已有真实对话/初始化痕迹（用于页面级是否还要弹初始化入口） */
  private sessionInitialized(session: Session): boolean {
    // providerUrl 会在打开网页时被自动记录（元宝首页 /chat/... 也算），
    // 不能当作「已经初始化」；只有真的聊过/发过系统提示词才算。
    return session.turns.length > 0 || Boolean(session.systemPromptSent)
  }

  /** 项目里是否已有带轮次的会话（任一即可）：用于判断是否还需要首次引导 */
  projectInitialized(projectId: string): boolean {
    if (!projectId) return false
    const project = this.projects.find((p) => p.id === projectId)
    if (!project || !isProjectRootAvailable(project.root)) {
      // 目录没了 = 不能再用缓存里的“已初始化”结论，否则永远不会重新弹引导
      this.initializedProjects.delete(projectId)
      return false
    }
    if (this.initializedProjects.has(projectId)) return true
    try {
      const store = this.sessionStoreOf(projectId)
      for (const m of store.list()) {
        const s = store.get(m.id)
        // 有轮次、有网页对话地址、或已发过系统提示词，都说明这个项目已经初始化过。
        // 只看轮次会把「用户直接在网页里聊」的会话误判成空项目，反复弹引导。
        if (s && (s.turns.length > 0 || Boolean(s.providerUrl) || Boolean(s.systemPromptSent))) {
          this.initializedProjects.add(projectId)
          return true
        }
      }
    } catch {
      /* 项目目录不可读时按未初始化处理 */
    }
    return false
  }

  /**
   * 网页内首次引导的「初始化项目」落点：弹目录框 → 打开项目 → 全量同步。
   * 按 webContentsId 触发（首次使用场景没有会话绑定，configureOverlay 会空转，
   * 网页浮窗将永远不消失）；选完对所有已连接 webview 广播 set-project。
   */
  private async pickAndOpenProject(webContentsId: number): Promise<void> {
    try {
      const root = await showDirectoryPicker(parentWindowFor(webContentsId))
      if (!root) return
      const opened = this.openProject(root)
      // 渲染层据此刷新项目下拉/目录条/会话列表
      this.emit({ type: 'projects-changed', sessionId: '' })
      // 所有网页（含发起方）同步新目录 → 浮窗消失；发起方无需会话绑定。
      // 已初始化过的项目不再弹首次引导，空目录才需要确认。
      this.overlay.broadcastCmd({
        kind: 'set-project',
        projectRoot: root,
        initialized: this.settings.get().pureMode || this.projectInitialized(opened.id)
      })
      // 当前活动会话如果已绑定，顺带重配（hook 的系统提示词要带上新目录）
      if (this.lastSessionId) this.configureOverlay(this.lastSessionId)
      Logger.info('project', `网页引导初始化项目: ${root}`)
    } catch (e) {
      Logger.warn('project', `网页引导初始化失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 初始化确认：把系统提示词＋工作目录作为一条消息自动发进当前对话。
   *
   * 这是「初始化」的实质内容 —— 只选目录不告诉 AI 什么都白搭。
   * 发送的是标准的系统提示词（含工具协议、目录树、规则），AI 收到后即进入
   * Lidow Agent 状态；用户在网页里直接接着问就能操作本地文件。
   */
  private async sendInitPrompt(webContentsId: number): Promise<boolean> {
    try {
      const project = this.activeProject()
      if (!project) {
        Logger.warn('project', '初始化提示词：没有活动项目，跳过')
        return false
      }
      // 找到该 webview 对应的会话；没有会话就现建一个（首次引导场景）
      let sessionId = this.overlay.sessionOfWebContents?.(webContentsId) ?? ''
      const bound = sessionId ? this.sessionOf(sessionId) : null
      // 切换项目后 webview 上可能还绑着旧项目的会话（文件甚至已被删除）。
      // 初始化必须落在「当前项目」的会话上，否则会把提示词写进旧项目，
      // 或者像实测那样直接失败：会话不存在: sess_xxx。
      if (bound && bound.projectId !== project.id) {
        Logger.info(
          'project',
          `初始化：解绑旧项目会话 ${sessionId}（${bound.projectId} → ${project.id}）`
        )
        this.overlay.unbindSession(sessionId)
        sessionId = ''
      }
      if (!sessionId || !bound) {
        if (sessionId) {
          // 绑定的会话文件已不存在（项目目录被删/移动）：解绑后重建
          Logger.warn('project', `初始化：会话 ${sessionId} 已不存在，改为新建`)
          this.overlay.unbindSession(sessionId)
        }
        // 平台必须取当前 webview 对应的平台：此前永远取内置第一个（DeepSeek），
        // 在豆包/Kimi 页面初始化会把会话记成 deepseek，后续绑定/导航全错。
        const reg = this.providerRegistryOf(project.id)
        const wcInfo = this.wcProviders.get(webContentsId)
        const wcUrl = webContents.fromId(webContentsId)?.getURL() ?? ''
        let host = ''
        try {
          host = new URL(wcUrl).host
        } catch {
          /* about:blank 等 */
        }
        const matched = reg.list().find((p) => {
          try {
            return p.enabled && Boolean(p.home) && new URL(p.home).host === host
          } catch {
            return false
          }
        })
        const providerId =
          wcInfo?.providerId ?? matched?.id ?? reg.list().find((x) => x.enabled)?.id ?? 'deepseek'
        const providerDesc = reg.get(providerId)
        const accountId =
          wcInfo?.accountId ??
          providerDesc?.activeAccountId ??
          providerDesc?.accounts[0]?.id ??
          undefined
        const created = this.sessionStoreOf(project.id).create(
          project.id,
          providerId,
          undefined,
          accountId
        )
        this.registerWebviewProvider(webContentsId, providerId, accountId)
        sessionId = created.id
        this.overlay.bindSession(sessionId, webContentsId)
        this.lastSessionId = sessionId
      }
      const sys =
        this.systemPromptFor(sessionId) +
        `\n\n## 初始化确认\n这是新会话的初始化消息。请只回复「初始化成功」，并确认当前工作目录是 ${project.root}。不要调用工具，不要输出测试或无关内容。\n初始化完成后，后续任务必须使用 Lidow 工具执行本地操作；需要读写文件、执行命令时，严格按上面的 lidow JSON 工具块协议输出，不要声称无法访问本地文件。`
      // 直接经 overlay 发送：此时用户正看着网页，消息要出现在 AI 对话框里
      await this.overlay.sendToPage(sessionId, sys)
      const initStore = this.sessionStoreOf(this.sessionProjectOf(sessionId))
      initStore.appendTurn(sessionId, {
        id: `turn_${nanoid(8)}`,
        role: 'system',
        text: '[Lidow 初始化] 已发送系统提示词与工作目录',
        ts: Date.now(),
        status: 'done'
      })
      initStore.update(sessionId, (x) => ({ ...x, systemPromptSent: true }))
      this.emit({ type: 'session-updated', sessionId })
      // 初始化完成：询问是否切到纯净模式（已经在纯净模式里就不再重复弹）
      if (!this.settings.get().pureMode) {
        this.emit({
          type: 'ui-pure-suggestion',
          sessionId,
          webContentsId,
          providerId: this.sessionOf(sessionId)?.providerId
        })
      }
      Logger.info('project', `已发送初始化提示词 session=${sessionId} len=${sys.length}`)
      return true
    } catch (e) {
      Logger.warn('project', `发送初始化提示词失败：${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /**
   * 纯净模式初始化：给已绑定的会话发首条系统提示词。
   * 网页平台只有出现第一条消息才会把新对话写进侧栏历史，
   * 所以“初始化完成”必须实际发一条，网页端列表才会与本地同步出现。
   */
  async startProjectSession(sessionId: string): Promise<boolean> {
    const wcId = this.overlay.wcIdOfSession(sessionId)
    if (wcId === undefined) return false
    return this.sendInitPrompt(wcId)
  }

  /**
   * 「延续上个对话」：把当前项目最近一次对话压缩成摘要，作为新对话的开场消息。
   *
   * 语义等同「同一项目的上下文接力」：用户开新窗口但不想丢上下文，
   * 摘要里保留了目标、已完成项、未完成项与关键文件路径。
   */
  private async continueProjectInNewChat(webContentsId: number): Promise<void> {
    try {
      const project = this.activeProject()
      if (!project) return
      // 找到该 webview 已绑定的会话；没有就用最近一个
      const currentId = this.overlay.sessionOfWebContents?.(webContentsId) ?? this.lastSessionId
      const store = this.sessionStoreOf(project.id)
      const bound = currentId ? this.sessionOf(currentId) : null
      const wcInfo = this.wcProviders.get(webContentsId)
      const providerId = bound?.providerId ?? wcInfo?.providerId
      // 只延续当前 webview 所属平台的历史，避免在 Kimi 页面延续出 DeepSeek 会话
      const sessions = store
        .list()
        .filter(
          (m) =>
            (store.get(m.id)?.turns.length ?? 0) > 0 && (!providerId || m.providerId === providerId)
        )
      const prior = sessions.find((m) => m.id === currentId) ?? sessions[0]
      if (!prior) {
        // 没有历史对话：退化为普通初始化
        await this.sendInitPrompt(webContentsId)
        return
      }

      // 压缩到摘要（compactNow 内部失败会回退本地摘要，不会抛）
      await this.loop.compactNow(prior.id, false)
      const turns = store.get(prior.id)?.turns ?? []
      const summary = [...turns]
        .reverse()
        .find((t) => t.role === 'system' && t.text.includes('上下文压缩'))
      const sys = this.systemPromptFor(prior.id)
      const handoff = this.settings.get().autoContinue.handoffPrompt
      const body = [
        sys,
        '---',
        summary?.text ?? '（上一轮对话没有可用的压缩摘要，请先读取项目文件确认现状）',
        handoff
      ]
        .filter(Boolean)
        .join('\n\n')

      // 新会话承载这次新对话
      const created = store.create(project.id, prior.providerId, undefined, prior.accountId)
      store.update(created.id, (x) => ({ ...x, title: `延续：${prior.title}`.slice(0, 40) }))
      this.overlay.bindSession(created.id, webContentsId)
      this.registerWebviewProvider(webContentsId, prior.providerId, prior.accountId)
      this.lastSessionId = created.id
      this.emit({ type: 'session-updated', sessionId: created.id })

      await this.overlay.sendToPage(created.id, body)
      // body 里已经带了系统提示词，新会话无需在首轮再重复注入
      store.update(created.id, (x) => ({ ...x, systemPromptSent: true }))
      Logger.info(
        'project',
        `延续对话：${prior.id} → ${created.id}（摘要 ${summary?.text.length ?? 0} 字）`
      )
      this.emit({
        type: 'notice',
        sessionId: created.id,
        level: 'info',
        message: '已把上个对话的摘要带进这个新窗口'
      })
      this.emit({
        type: 'ui-pure-suggestion',
        sessionId: created.id,
        webContentsId,
        providerId: prior.providerId
      })
    } catch (e) {
      Logger.warn('project', `延续对话失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  openProject(root: string): ProjectInfo {
    // 目录已被删除/移动时不要“复活”它（mkdir 递归会重建整棵目录树）
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error(`目录不存在或不是文件夹：${root}`)
    const prevActive = this.projectStore.get().activeProjectId
    let p = this.projects.find((x) => x.root === root)
    if (!p) {
      p = {
        id: `proj_${nanoid(8)}`,
        name: basename(root),
        root,
        createdAt: Date.now(),
        lastOpenedAt: Date.now()
      }
      this.projects.push(p)
    }
    p.lastOpenedAt = Date.now()
    this.projectStore.set({ projects: this.projects, activeProjectId: p.id })
    this.projectDirs.set(p.id, root)
    this.initProjectScaffold(root)
    // 切换项目：网页上显示的对话属于旧项目，解除全部会话绑定。
    // 否则初始化/新任务会复用旧项目的会话（其文件可能已随目录删除而不存在），
    // 表现为「初始化失败：会话不存在」以及初始化完又弹一次引导。
    if (prevActive && prevActive !== p.id) {
      // 切项目会解绑网页；旧项目的循环如果继续跑，工具会继续写旧目录。
      // 渲染层确认文案写的是“会中断”，这里必须真的停掉。
      this.stopAll('all')
      for (const sid of this.overlay.boundSessionIds()) this.overlay.unbindSession(sid)
      this.lastSessionId = ''
    }
    return p
  }

  /**
   * 项目目录被删除/移动后，重新绑定到用户新选的目录：
   * 保留项目 id（会话归属不变），清掉旧路径的存储缓存，重新建脚手架。
   */
  relocateProject(projectId: string, root: string): ProjectInfo {
    if (!isProjectRootAvailable(root)) throw new Error(`目录不存在或不是文件夹：${root}`)
    const project = this.projects.find((p) => p.id === projectId)
    if (!project) throw new Error('项目不存在或已被移除')
    const other = this.projects.find((p) => p.id !== projectId && p.root === root)
    if (other) throw new Error(`该目录已被项目「${other.name}」使用`)
    project.root = root
    project.name = basename(root)
    project.lastOpenedAt = Date.now()
    this.projectDirs.set(projectId, root)
    this.sessionStores.delete(projectId)
    this.providerRegistries.delete(projectId)
    this.initializedProjects.delete(projectId)
    this.projectStore.set({ projects: this.projects, activeProjectId: projectId })
    this.initProjectScaffold(root)
    // 旧目录里的会话已经不可用：停掉循环并解绑，避免继续往旧路径写
    this.stopAll('all')
    for (const sid of this.overlay.boundSessionIds()) this.overlay.unbindSession(sid)
    this.lastSessionId = ''
    Logger.info('project', `项目重新绑定目录: ${root}（project=${projectId}）`)
    return project
  }

  /**
   * 从项目列表移除（不删除磁盘文件）。
   * `deleteLocalSessions`：同时清空本地会话（网页端会话由调用方先删除）。
   * 当前项目需先切换走；目录已不存在时允许直接移除并回退活动项目。
   */
  removeProject(projectId: string, opts: { deleteLocalSessions?: boolean } = {}): void {
    const p = this.projects.find((x) => x.id === projectId)
    if (!p) return
    const active = this.projectStore.get().activeProjectId
    if (active === projectId && isProjectRootAvailable(p.root)) {
      throw new Error('请先切换到其他项目，再移除当前项目')
    }
    if (opts.deleteLocalSessions && isProjectRootAvailable(p.root)) {
      try {
        const store = this.sessionStoreOf(projectId)
        for (const meta of store.list()) {
          this.loop.stop(meta.id, 'all')
          this.overlay.unbindSession(meta.id)
          store.delete(meta.id)
          if (this.lastSessionId === meta.id) this.lastSessionId = ''
          this.emit({ type: 'session-deleted', sessionId: meta.id, title: meta.title })
        }
      } catch (e) {
        Logger.warn(
          'project',
          `移除项目时清理本地会话失败：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    this.projects = this.projects.filter((x) => x.id !== projectId)
    let nextActive = active
    if (active === projectId) {
      const fallback = [...this.projects]
        .filter((x) => isProjectRootAvailable(x.root))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
      nextActive = fallback?.id ?? null
    }
    this.projectStore.set({ projects: this.projects, activeProjectId: nextActive })
    this.projectDirs.delete(projectId)
    this.sessionStores.delete(projectId)
    this.providerRegistries.delete(projectId)
    this.initializedProjects.delete(projectId)
    this.projectChats.removeProject(projectId)
    Logger.info('project', `已从列表移除项目: ${p.root}（项目文件夹未删除）`)
  }

  /**
   * 项目初始化（打开时幂等执行）：建 .lidow/ 工作目录结构。
   * 已存在则跳过，不动用户文件。
   */
  private initProjectScaffold(root: string): void {
    try {
      const dirs = [
        join(root, '.lidow'),
        join(root, '.lidow', 'skills'),
        join(root, '.lidow', 'agents'),
        join(root, '.lidow', 'rules'),
        join(root, '.lidow', 'exports'),
        join(root, '.lidow', 'sessions')
      ]
      for (const d of dirs) mkdirSync(d, { recursive: true })
      const readme = join(root, '.lidow', 'README.md')
      if (!existsSync(readme)) {
        writeFileSync(
          readme,
          [
            '# Lidow 项目工作目录',
            '',
            '本目录由 Lidow 自动创建，存放会话/技能/规则/导出等项目级数据。',
            '- skills/  项目技能（渐进披露，AI 可 readSkill 加载）',
            '- agents/  子代理定义',
            '- rules/   项目规则（自动注入系统提示词）',
            '- exports/ 会话导出（Markdown）',
            '- sessions/ 会话持久化'
          ].join('\n'),
          'utf-8'
        )
      }
      Logger.info('project', `项目初始化完成: ${root}`)
    } catch (e) {
      Logger.warn('project', `项目初始化跳过: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  closeProject(projectId: string): void {
    const cur = this.projectStore.get().activeProjectId
    if (cur === projectId) this.projectStore.set({ activeProjectId: null })
  }

  private projectDirOf(projectId: string): string {
    // 防御：projectId 可能是字符串 'undefined'（早期调用方传了空值），
    // 那会在 userData 下建出 projects/undefined 这种垃圾目录（已实测出现过）。
    if (!projectId || projectId === 'undefined' || projectId === 'null') {
      const fallback = this.activeProject()?.root
      if (fallback) return fallback
      throw new Error('无效的项目 id（无法确定工作目录）')
    }
    let dir = this.projectDirs.get(projectId)
    if (!dir) {
      // 已知项目只认它自己的根目录；目录不存在时绝不 mkdir 重建
      // （SessionStore 的构造会建 .lidow/sessions，不能让它把用户删掉的目录复活）。
      const project = this.projects.find((p) => p.id === projectId)
      if (project?.root) {
        dir = project.root
      } else {
        // 只有项目根未知时才退回 userData（历史行为，会导致会话"消失"）。
        dir = join(app.getPath('userData'), 'projects', projectId)
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          /* 项目目录不可写时忽略 */
        }
      }
      this.projectDirs.set(projectId, dir)
    }
    return dir
  }

  sessionStoreOf(projectId: string): SessionStore {
    // 目录被删除/移动后不能再构造 SessionStore：它的构造函数会 mkdir，
    // 会把用户删掉的整个项目骨架重新建出来，初始化检测也因此误判为"还存在"。
    const project = this.projects.find((p) => p.id === projectId)
    if (project && !isProjectRootAvailable(project.root)) {
      this.sessionStores.delete(projectId)
      throw new Error(`项目目录不存在：${project.root}`)
    }
    let s = this.sessionStores.get(projectId)
    if (!s) {
      // 会话存项目内 .lidow/sessions/（随项目走、可版本化），不污染项目根目录
      const base = join(this.projectDirOf(projectId), '.lidow')
      Logger.info('session', `SessionStore 路径: ${base} (project=${projectId})`)
      s = new SessionStore(base)
      this.sessionStores.set(projectId, s)
    }
    return s
  }

  providerRegistryOf(projectId: string): ProviderRegistry {
    const project = this.projects.find((p) => p.id === projectId)
    if (project && !isProjectRootAvailable(project.root)) {
      this.providerRegistries.delete(projectId)
      throw new Error(`项目目录不存在：${project.root}`)
    }
    let r = this.providerRegistries.get(projectId)
    if (!r) {
      r = new ProviderRegistry(this.projectDirOf(projectId))
      this.providerRegistries.set(projectId, r)
    }
    return r
  }

  private sessionProjectOf(sessionId: string): string {
    for (const p of this.projects) {
      if (!isProjectRootAvailable(p.root)) continue
      try {
        if (this.sessionStoreOf(p.id).get(sessionId)) return p.id
      } catch {
        /* 目录不可读：跳过该项目的会话 */
      }
    }
    const active = this.projectStore.get().activeProjectId
    if (active && this.projects.some((p) => p.id === active && isProjectRootAvailable(p.root)))
      return active
    return this.projects.find((p) => isProjectRootAvailable(p.root))?.id ?? ''
  }

  /** 会话所属项目（索引查询，不读整份会话文件） */
  private projectOfSession(sessionId: string): ProjectInfo | null {
    if (!sessionId) return null
    for (const p of this.projects) {
      if (!isProjectRootAvailable(p.root)) continue
      try {
        if (this.sessionStoreOf(p.id).meta(sessionId)) return p
      } catch {
        /* 目录不可读：跳过 */
      }
    }
    return null
  }

  sessionOf(sessionId: string): ReturnType<SessionStore['get']> {
    for (const p of this.projects) {
      if (!isProjectRootAvailable(p.root)) continue
      try {
        const s = this.sessionStoreOf(p.id).get(sessionId)
        if (s) return s
      } catch {
        /* 目录不可读：跳过 */
      }
    }
    return null
  }

  /**
   * 网页侧用户亲手发送的消息：补一条 user 轮次，纯净模式立即显示。
   * loop 自己发的工具观察/重试/催促在 preload 里打了 outgoing 标记，不会走到这里。
   */
  private recordWebUserMessage(sessionId: string, rawText: string): void {
    const text = rawText.trim()
    if (!text) return
    const projectId = this.sessionProjectOf(sessionId)
    if (!projectId) return
    const store = this.sessionStoreOf(projectId)
    const session = store.get(sessionId)
    if (!session) return
    // 同一条消息可能因平台重试/重新生成再次进入请求体：同文同窗口只记一次
    const lastUser = [...session.turns].reverse().find((t) => t.role === 'user')
    if (lastUser && Date.now() - lastUser.ts < 30_000 && lastUser.text.trim() === text) return
    store.appendTurn(sessionId, {
      id: `turn_${nanoid(8)}`,
      role: 'user',
      text,
      ts: Date.now(),
      status: 'done'
    })
    Logger.info('session', `同步网页侧用户消息 session=${sessionId} len=${text.length}`)
    this.emit({ type: 'session-updated', sessionId })
  }

  // ---------- 循环支撑 ----------

  toolCtx(sessionId: string): ToolContext {
    const s = this.settings.get()
    // 以会话所属项目为准；无会话的调用方（定时任务/插件）回退到活动项目
    const project = this.projectOfSession(sessionId) ?? this.activeProject()
    return {
      projectRoot: project?.root ?? process.cwd(),
      sessionId: sessionId || undefined,
      settings: {
        commandTimeoutMs: s.commandTimeoutMs,
        sandboxTimeoutMs: s.sandboxTimeoutMs,
        outputBufferLimit: s.outputBufferLimit,
        ssrfProtection: s.ssrfProtection,
        dangerConfirm: s.dangerConfirm,
        deleteProtection: s.deleteProtection,
        batchDeleteThreshold: s.batchDeleteThreshold,
        permissionMode: s.permissionMode
      },
      confirm: (reason) => this.requestConfirm(sessionId, reason),
      trashItem: (path) => shell.trashItem(path),
      injectJs: (code) => this.overlay.executeJs(sessionId, code),
      audit: (kind, summary, detail, backupPath) =>
        this.audit.record(sessionId, kind, summary, detail, backupPath)
    }
  }

  private requestConfirm(sessionId: string, reason: string): Promise<boolean> {
    // 插件安装/定时任务等无会话上下文的确认不能把全局 active session 清空
    if (sessionId) this.lastSessionId = sessionId
    return new Promise((resolve) => {
      const callId = `cfm_${nanoid(6)}`
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(callId)
        resolve(false) // 超时视为拒绝（安全默认）
      }, 120_000)
      this.pendingConfirms.set(callId, (ok) => {
        clearTimeout(timer)
        this.pendingConfirms.delete(callId)
        resolve(ok)
      })
      this.emitFn?.({ type: 'tool-confirm-required', sessionId, callId, reason })
    })
  }

  resolveConfirm(callId: string, ok: boolean): void {
    this.pendingConfirms.get(callId)?.(ok)
  }

  /** DSH 插件注入的提示词片段（global + 当前会话） */
  promptFragments(): string {
    const all = this.dshKv.get().__promptFragments ?? {}
    const merged = [
      all['global'] as string | undefined,
      all[this.lastSessionId] as string | undefined
    ]
      .filter(Boolean)
      .join('\n')
    return merged.trim()
  }

  /** 取走某会话最新的思考过程（取后即清，避免挂到下一轮） */
  private takeThinking(sessionId: string): string {
    const v = this.thinkBuffers.get(sessionId) ?? ''
    this.thinkBuffers.delete(sessionId)
    return v
  }

  systemPromptFor(sessionId: string): string {
    // 系统提示词里的工作目录必须来自会话所属项目（多项目并行时不能取错）
    const project = this.projectOfSession(sessionId) ?? this.activeProject()
    if (!project) return ''
    const base = buildSystemPrompt({
      projectRoot: project.root,
      projectName: project.name,
      treeSummary: this.treeSummary(project.root),
      tools: this.tools,
      memory: this.memory,
      audit: this.audit,
      sessionId,
      settings: this.settings.get(),
      ctfInject: this.settings.get().securityMod.ctfInject
    })
    const fragments = this.promptFragments()
    return fragments ? `${base}\n\n## 插件注入指令\n${fragments}` : base
  }

  private treeSummary(root: string): string {
    if (!existsSync(root)) return ''
    const EXCL = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      'out',
      '.next',
      'coverage',
      '__pycache__',
      '.venv',
      'target'
    ])
    const lines: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 2 || lines.length > 60) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
          .filter((n) => !EXCL.has(n) && !n.startsWith('.'))
          .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      } catch {
        return
      }
      for (const name of entries.slice(0, 24)) {
        if (lines.length > 60) return
        const full = join(dir, name)
        let isDir: boolean
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        lines.push(`${name}${isDir ? '/' : ''}`)
        if (isDir) walk(full, depth + 1)
      }
    }
    walk(root, 0)
    return lines.join('\n')
  }

  readFileTree(root: string, rel: string, depth: number): FileNode[] {
    const abs = join(root, rel || '')
    if (!existsSync(abs)) return []
    const EXCL = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      'out',
      'coverage',
      '__pycache__',
      '.venv',
      'target'
    ])
    const walk = (dir: string, level: number): FileNode[] => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return []
      }
      const nodes: FileNode[] = []
      for (const name of entries) {
        if (name.startsWith('.') || EXCL.has(name)) continue
        const full = join(dir, name)
        let isDir: boolean
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        nodes.push({
          path: full.slice(root.length + 1).replace(/\\/g, '/'),
          name,
          type: isDir ? 'dir' : 'file',
          children: isDir && level < depth ? walk(full, level + 1) : undefined
        })
      }
      // 目录优先、同类型按名称排序：文件树/预览面板可读性
      nodes.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1
      )
      return nodes
    }
    return walk(abs, 0)
  }

  runningSessionIds(): string[] {
    return this.loop.runningSessionIds()
  }

  stopAll(level: 'generate' | 'tool' | 'auto-loop' | 'all'): void {
    for (const sid of this.runningSessionIds()) this.loop.stop(sid, level)
  }

  // ---------- 模板 / 同步 / 更新 / DSH ----------

  private templatesRoot(): string {
    return app.isPackaged
      ? join(process.resourcesPath ?? '', 'templates')
      : join(app.getAppPath(), 'templates')
  }

  templates(): { id: string; name: string; description: string }[] {
    return listTemplates(this.templatesRoot()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description
    }))
  }

  applyTemplate(templateId: string, root: string): void {
    const tpl = listTemplates(this.templatesRoot()).find((t) => t.id === templateId)
    if (!tpl) throw new Error(`模板不存在: ${templateId}`)
    mkdirSync(root, { recursive: true })
    for (const f of tpl.files) {
      const target = join(root, f.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.content, 'utf-8')
    }
    const lidowSrc = join(this.templatesRoot(), templateId, '.lidow')
    if (existsSync(lidowSrc)) cpSync(lidowSrc, join(root, '.lidow'), { recursive: true })
  }

  pushSync(text: string): Promise<void> {
    return this.sync.pushAll(text)
  }

  async updateCheck(
    manual = false
  ): Promise<{ hasUpdate: boolean; version?: string; url?: string; portable?: boolean }> {
    return checkForUpdate(manual)
  }

  /** 服务端权威 token 消耗（按平台累计） */
  tokenStats(): Record<string, number> {
    return this.tokenUsage.get()
  }

  async dshCoverage(): Promise<{ total: number; implemented: string[]; missing: string[] }> {
    return this.dsh.coverage()
  }

  /** 读取网页侧模型菜单（纯净模式右侧模型下拉） */
  async getModels(sessionId: string): Promise<ModelPickerInfo> {
    return this.overlay.getModels(sessionId)
  }

  /** 切换网页侧模型 */
  async selectModel(
    sessionId: string,
    label: string
  ): Promise<{ ok: boolean; label?: string; error?: string }> {
    return this.overlay.selectModel(sessionId, label)
  }

  /** 供测试/调试：直接读会话存储（按项目 id） */
  sessionStoreFor(projectId: string): SessionStore {
    return this.sessionStoreOf(projectId)
  }
}
