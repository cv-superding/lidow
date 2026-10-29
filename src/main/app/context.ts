import { app, BrowserWindow, Notification, shell, webContents } from 'electron'
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
import { isDirectoryPickerOpen, parentWindowFor, showDirectoryPicker } from '@main/app/directoryPicker'
import { buildSystemPrompt } from '@main/prompt/build'
import { registerRuntimeServices } from '@main/dsh/services'
import type { AppSettings, FileNode, ProjectInfo, Session } from '@shared/types'
import { HOOKS, buildHookSource } from '@main/providers/hooks'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'graphite',
  accent: '#4f6bed',
  desktopPet: true,
  language: 'zh-CN',
  pureMode: false,
  dangerConfirm: true,
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
    prompt: '刚才的回复似乎中断了，请重新完整回答上一个问题。'
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
    p.includes('抖音旗下')
  )
}

function cleanChatTitle(raw: string | undefined, providerName: string): string {
  let t = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const parts = t.split(/\s+[-|·]\s+/).map((x) => x.trim()).filter(Boolean)
  if (parts.length > 1) {
    // 只剔除尾部平台名/首页标语，避免把「ChatGPT - 使用指南」这类
    // 以平台名开头的真实标题削成「使用指南」。
    while (parts.length > 1 && isGenericTitlePart(parts[parts.length - 1]!, providerName)) parts.pop()
    t = parts.join(' - ').trim()
  }
  if (!t || isGenericTitlePart(t, providerName)) return ''
  return t.slice(0, 60)
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
  private sessionStores = new Map<string, SessionStore>()
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
    this.projectStore = new JsonStore<{ projects: ProjectInfo[]; activeProjectId: string | null }>(join(userData, 'projects.json'), {
      projects: [],
      activeProjectId: null
    })
    this.projects = this.projectStore.get().projects
    for (const p of this.projects) this.projectDirs.set(p.id, p.root)
    // 启动时对全部已知项目补跑脚手架（幂等）：旧项目也能获得 .lidow/skills 等目录。
    // 只处理仍然存在的目录 —— 已删除的测试目录不能因为这条逻辑被重新创建出来。
    for (const p of this.projects) {
      if (p.root && p.root !== 'undefined' && existsSync(p.root)) this.initProjectScaffold(p.root)
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

    this.dshKv = new JsonStore<Record<string, Record<string, unknown>>>(join(userData, 'dsh-kv.json'), {})
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
      captureMemory: (content) => this.memory.add(content.slice(0, 40), content, ['标记'], 'marker'),
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
    this.hotkeys.registerAction('new-session', () => this.emit({ type: 'ui-new-session', sessionId: '' }))
    this.hotkeys.registerAction('toggle-pure', () => this.emit({ type: 'ui-toggle-pure', sessionId: '' }))
    this.hotkeys.applyAll()

    this.overlay.setThinkChunkHandler((sessionId, think) => {
      // 缓存最新累计思考：loop 在回复结束后取走并写入 turn.think（折叠展示）
      if (think) this.thinkBuffers.set(sessionId, think.slice(0, 20_000))
      this.emit({ type: 'think-chunk', sessionId, think })
    })
    this.overlay.setToggleStateHandler((think, search) => {
      this.emit({ type: 'toggle-state', sessionId: '', think, search })
    })
    // 用户在网页输入框里自己发消息时，回复没有经过 lidow 的 send/await 通道。
    // 常驻接管：回复里若带工具块就执行，否则提示用户改用原生输入框。
    this.overlay.setPageReplyHandler((sessionId, text) => {
      void this.loop.adoptExternalReply(sessionId, text)
    })
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
      const level = action === 'stop-generate' ? 'generate' : action === 'stop-tool' ? 'tool' : 'all'
      this.loop.stop(sessionId, level)
    })
    this.overlay.onReady = (sessionId) => this.configureOverlay(sessionId)
    // 登录成功 → 把「有没有工作目录」推给该网页，由 overlay 决定是否弹首次引导。
    // 这一步必须放在登录之后：登录页没有输入框，那时弹引导用户既看不懂也用不上。
    this.overlay.onInitProject = (webContentsId) => void this.pickAndOpenProject(webContentsId)
    // 「使用此目录，开始」：把系统提示词 + 工作目录自动发进这个对话。
    // 初始化时必须自动输入一段提示词 —— 否则 AI 不知道自己绑定了本地工具，
    // 会答「我没有文件系统访问权限」。
    this.overlay.onConfirmProject = (webContentsId) => void this.sendInitPrompt(webContentsId)
    // 「延续上个对话」：压缩当前会话 → 摘要作为新对话的第一条消息。
    // 等于同一项目的上下文接力：新窗口从上次的进度接着干。
    this.overlay.onContinueProject = (webContentsId) => void this.continueProjectInNewChat(webContentsId)
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
      const descriptor = this.providerRegistryOf(session.projectId).get(session.providerId)
      const home = descriptor?.home ?? ''
      const loginPage = /\/sign_?in|\/login/i.test(url)
      const onHome = Boolean(home) && url.split('#')[0] === home
      // 登录页/首页不算对话页，不覆盖已记录的对话 URL
      const shouldRecordUrl = !loginPage && !onHome && url !== session.providerUrl
      if (shouldRecordUrl) {
        // 同一网页对话不能同时归属两个 Lidow 会话；否则两边发送都会写进同一个
        // 平台对话，历史互相污染。网页侧手动切换对话时宁可忽略这次导航。
        const conflict = this.sessionStoreOf(session.projectId)
          .list()
          .find((m) => m.id !== sessionId && m.providerUrl === url)
        if (conflict) {
          Logger.warn('nav', `忽略重复对话 URL session=${sessionId.slice(-6)} 已属于 ${conflict.id.slice(-6)}`)
          return
        }
      }
      const cleanTitle = cleanChatTitle(title, descriptor?.name ?? session.providerId)
      const nextTitle = cleanTitle && cleanTitle !== session.title ? cleanTitle : session.title
      const nextUrl = shouldRecordUrl ? url : session.providerUrl
      if (nextUrl === session.providerUrl && nextTitle === session.title) return
      this.sessionStoreOf(session.projectId).update(sessionId, (x) => ({
        ...x,
        providerUrl: nextUrl,
        title: nextTitle
      }))
      if (shouldRecordUrl) {
        Logger.info('nav', `providerUrl 已记录 session=${sessionId.slice(-6)} → ${url.slice(0, 70)}`)
      }
      if (nextTitle !== session.title) {
        Logger.info('nav', `会话标题同步自网页: ${session.title} → ${nextTitle}`)
        this.emit({ type: 'session-title', sessionId, title: nextTitle })
      }
    }
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
        initialized: this.settings.get().pureMode || (session ? this.sessionInitialized(session) : false)
      })
      // 未初始化时把窗口提到前台，引导摆在用户眼前（"强制第一步"）
      if (!root) this.focusWindow()
    }

    app.on('web-contents-created', (_e, wc) => {
      wc.on('destroyed', () => {
        this.overlay.disposeWebContents(wc.id)
        this.wcProviders.delete(wc.id)
      })
      // 嵌入式 webview 环境漂白：UA 去除 Electron 标识，对齐真实 Chrome（缓解平台"使用环境异常"误判）
      if (wc.getType() === 'webview') {
        try {
          const chrome = process.versions.chrome ?? '126'
          const platform =
            process.platform === 'win32'
              ? 'Windows NT 10.0; Win64; x64'
              : process.platform === 'darwin'
                ? 'Macintosh; Intel Mac OS X 10_15_7'
                : 'X11; Linux x86_64'
          const ua = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
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
    for (const p of this.projects) this.providerRegistryOf(p.id)
    void this.loadAllPlugins()
    Logger.info('context', 'AppContext 初始化完成')
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
      if (wc.getURL() !== session.providerUrl) await wc.loadURL(session.providerUrl).catch(() => undefined)
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
              notify: (message: string) => this.emit({ type: 'notice', sessionId: '', level: 'info', message })
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
            : [...new Set([...this.providerRegistries.values()].flatMap((r) => r.list().map((x) => x.id)))]
          for (const id of targets) {
            const arr = this.webScripts.get(id) ?? []
            arr.push(code)
            this.webScripts.set(id, arr)
          }
          Logger.info('plugins', `网页脚本已登记: ${p.id} → ${targets.join(',')}`)
        }
      } catch (e) {
        Logger.warn('plugins', `插件 ${p.id} 加载失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 已启用插件的网页脚本（providerId → code 列表），configure 时注入 webview */
  webScriptsOf(providerId: string): string[] {
    return this.webScripts.get(providerId) ?? []
  }

  emit(event: { type: string; sessionId: string; [k: string]: unknown }): void {
    this.emitFn?.(event)
  }

  /** 向 webview 下发对应 provider 的 DOM 适配器（bindSession 与 ready 双路径调用） */
  configureOverlay(sessionId: string): void {
    const session = this.sessionOf(sessionId)
    if (!session) return
    const provider = this.providerRegistryOf(session.projectId).get(session.providerId)
    if (!provider) return
    this.overlay.sendCmd(sessionId, { kind: 'configure', adapter: provider.adapter })
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
    if (spec) void this.overlay.injectHook(sessionId, buildHookSource(spec, this.systemPromptFor(sessionId)))
    // 插件网页脚本：登记后按「页面加载完成」时机注入（直接 executeJs 会在
    // 页面加载期打在 about:blank 上静默丢失；刷新后也由 did-finish-load 重放）
    this.overlay.setWebScripts(sessionId, this.webScriptsOf(provider.id))
    void this.overlay.injectWebScripts(sessionId).catch((e) => {
      Logger.warn('plugins', `网页脚本注入失败: ${e instanceof Error ? e.message : String(e)}`)
    })
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
        const kb = this.knowledge.list().find((b) => b.name === String(input.kb) || b.id === String(input.kb))
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
        agent: { type: 'string', description: '代理名（agents 目录中定义，可省略）', required: false },
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
        const project = parent ? this.projects.find((p) => p.id === parent.projectId) : this.activeProject()
        if (!project) return { ok: false, output: '', error: '没有可用项目（子代理需要工作目录）' }
        if (!parentSessionId || !parent) return { ok: false, output: '', error: '当前没有活动会话' }

        // 代理定义：项目级优先于用户级
        let persona = ''
        if (agentName) {
          const agent = listAgents(project.root).find((a) => a.name === agentName)
          if (!agent) {
            return { ok: false, output: '', error: `未找到代理「${agentName}」，可用：${listAgents(project.root).map((a) => a.name).join(', ') || '（无）'}` }
          }
          persona = agent.body ?? ''
        }

        const providerId = parent.providerId
        const child = this.sessionStoreOf(project.id).create(project.id, providerId, undefined, parent.accountId)
        this.sessionStoreOf(project.id).update(child.id, (s) => ({
          ...s,
          title: `[子代理] ${agentName || '通用'}：${task.slice(0, 18)}`
        }))

        const prompt = [persona, '---', `任务：${task}`, '', '完成后直接给出最终结果（不要再调用工具）。']
          .filter(Boolean)
          .join('\n\n')

        Logger.info('loop', `子代理启动 session=${child.id} agent=${agentName || '通用'} 任务=${task.slice(0, 40)}`)
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
            output: output ? `【子代理${agentName ? ` ${agentName}` : ''}的最终答复】\n${output.slice(0, 8000)}` : '子代理没有产出文本回复（可能被中断）'
          }
        } catch (e) {
          return { ok: false, output: '', error: `子代理执行失败：${e instanceof Error ? e.message : String(e)}` }
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

  /** renderer 打开标签时登记该 webview 的平台/账号（无会话初始化时使用） */
  registerWebviewProvider(webContentsId: number, providerId: string, accountId?: string): void {
    if (!providerId) return
    this.wcProviders.set(webContentsId, { providerId, accountId })
  }

  webviewProvider(webContentsId: number): { providerId: string; accountId?: string } | undefined {
    return this.wcProviders.get(webContentsId)
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
    return session.turns.length > 0 || Boolean(session.providerUrl) || Boolean(session.systemPromptSent)
  }

  /** 项目里是否已有带轮次的会话（任一即可）：用于判断是否还需要首次引导 */
  projectInitialized(projectId: string): boolean {
    if (!projectId) return false
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
  private async sendInitPrompt(webContentsId: number): Promise<void> {
    try {
      const project = this.activeProject()
      if (!project) {
        Logger.warn('project', '初始化提示词：没有活动项目，跳过')
        return
      }
      // 找到该 webview 对应的会话；没有会话就现建一个（首次引导场景）
      let sessionId = this.overlay.sessionOfWebContents?.(webContentsId) ?? ''
      const bound = sessionId ? this.sessionOf(sessionId) : null
      // 切换项目后 webview 上可能还绑着旧项目的会话（文件甚至已被删除）。
      // 初始化必须落在「当前项目」的会话上，否则会把提示词写进旧项目，
      // 或者像实测那样直接失败：会话不存在: sess_xxx。
      if (bound && bound.projectId !== project.id) {
        Logger.info('project', `初始化：解绑旧项目会话 ${sessionId}（${bound.projectId} → ${project.id}）`)
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
        const providerId = wcInfo?.providerId ?? matched?.id ?? reg.list().find((x) => x.enabled)?.id ?? 'deepseek'
        const providerDesc = reg.get(providerId)
        const accountId =
          wcInfo?.accountId ?? providerDesc?.activeAccountId ?? providerDesc?.accounts[0]?.id ?? undefined
        const created = this.sessionStoreOf(project.id).create(project.id, providerId, undefined, accountId)
        this.registerWebviewProvider(webContentsId, providerId, accountId)
        sessionId = created.id
        this.overlay.bindSession(sessionId, webContentsId)
        this.lastSessionId = sessionId
      }
      const sys = this.systemPromptFor(sessionId)
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
      // 初始化完成：询问是否切到纯净模式（稍后也可从左侧栏进入）
      this.emit({
        type: 'ui-pure-suggestion',
        sessionId,
        webContentsId,
        providerId: this.sessionOf(sessionId)?.providerId
      })
      Logger.info('project', `已发送初始化提示词 session=${sessionId} len=${sys.length}`)
    } catch (e) {
      Logger.warn('project', `发送初始化提示词失败：${e instanceof Error ? e.message : String(e)}`)
    }
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
      const sessions = store.list().filter(
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
      const summary = [...turns].reverse().find((t) => t.role === 'system' && t.text.includes('上下文压缩'))
      const sys = this.systemPromptFor(prior.id)
      const handoff =
        this.settings.get().autoContinue.handoffPrompt
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
      Logger.info('project', `延续对话：${prior.id} → ${created.id}（摘要 ${summary?.text.length ?? 0} 字）`)
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
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`目录不存在或不是文件夹：${root}`)
    const prevActive = this.projectStore.get().activeProjectId
    let p = this.projects.find((x) => x.root === root)
    if (!p) {
      p = { id: `proj_${nanoid(8)}`, name: basename(root), root, createdAt: Date.now(), lastOpenedAt: Date.now() }
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

  /** 从项目列表移除（不删除磁盘文件）；当前项目需先切换走 */
  removeProject(projectId: string): void {
    const p = this.projects.find((x) => x.id === projectId)
    if (!p) return
    const active = this.projectStore.get().activeProjectId
    if (active === projectId) throw new Error('请先切换到其他项目，再移除当前项目')
    this.projects = this.projects.filter((x) => x.id !== projectId)
    this.projectStore.set({ projects: this.projects, activeProjectId: active })
    this.projectDirs.delete(projectId)
    this.sessionStores.delete(projectId)
    this.providerRegistries.delete(projectId)
    Logger.info('project', `已从列表移除项目: ${p.root}（磁盘文件未删除）`)
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
      // 优先用项目真实根目录（会话/待办等存在项目的 .lidow/ 下，随项目走）；
      // 只有项目根未知时才退回 userData（历史行为，会导致会话"消失"）。
      const project = this.projects.find((p) => p.id === projectId)
      dir = project?.root ?? join(app.getPath('userData'), 'projects', projectId)
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* 项目目录不可写时忽略 */
      }
      this.projectDirs.set(projectId, dir)
    }
    return dir
  }

  sessionStoreOf(projectId: string): SessionStore {
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
    let r = this.providerRegistries.get(projectId)
    if (!r) {
      r = new ProviderRegistry(this.projectDirOf(projectId))
      this.providerRegistries.set(projectId, r)
    }
    return r
  }

  private sessionProjectOf(sessionId: string): string {
    for (const p of this.projects) {
      if (this.sessionStoreOf(p.id).get(sessionId)) return p.id
    }
    return this.projectStore.get().activeProjectId ?? this.projects[0]?.id ?? ''
  }

  /** 会话所属项目（索引查询，不读整份会话文件） */
  private projectOfSession(sessionId: string): ProjectInfo | null {
    if (!sessionId) return null
    for (const p of this.projects) {
      if (this.sessionStoreOf(p.id).meta(sessionId)) return p
    }
    return null
  }

  sessionOf(sessionId: string): ReturnType<SessionStore['get']> {
    for (const p of this.projects) {
      const s = this.sessionStoreOf(p.id).get(sessionId)
      if (s) return s
    }
    return null
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
        permissionMode: s.permissionMode
      },
      confirm: (reason) => this.requestConfirm(sessionId, reason),
      injectJs: (code) => this.overlay.executeJs(sessionId, code),
      audit: (kind, summary, detail, backupPath) => this.audit.record(sessionId, kind, summary, detail, backupPath)
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
    const merged = [all['global'] as string | undefined, all[this.lastSessionId] as string | undefined]
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
    const EXCL = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'target'])
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
    const EXCL = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '__pycache__', '.venv', 'target'])
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
      nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1))
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
    return app.isPackaged ? join(process.resourcesPath ?? '', 'templates') : join(app.getAppPath(), 'templates')
  }

  templates(): { id: string; name: string; description: string }[] {
    return listTemplates(this.templatesRoot()).map((t) => ({ id: t.id, name: t.name, description: t.description }))
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

  async updateCheck(): Promise<{ hasUpdate: boolean; version?: string; url?: string; portable?: boolean }> {
    return checkForUpdate(true)
  }

  /** 服务端权威 token 消耗（按平台累计） */
  tokenStats(): Record<string, number> {
    return this.tokenUsage.get()
  }

  async dshCoverage(): Promise<{ total: number; implemented: string[]; missing: string[] }> {
    return this.dsh.coverage()
  }

  /** 供测试/调试：直接读会话存储（按项目 id） */
  sessionStoreFor(projectId: string): SessionStore {
    return this.sessionStoreOf(projectId)
  }
}
