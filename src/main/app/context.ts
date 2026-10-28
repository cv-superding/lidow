import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, writeFileSync, cpSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import os from 'node:os'
import { nanoid } from 'nanoid'
import { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import { ToolRegistry } from '@main/tools/registry'
import { createEcosystemTools } from '@main/tools/ecosystem'
import type { ToolContext, ToolDef } from '@main/tools/types'
import { ProviderRegistry } from '@main/providers/registry'
import { SessionStore } from '@main/session/store'
import { OverlayManager } from '@main/bridge/overlayManager'
import { AgentLoop } from '@main/bridge/loop'
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
import { buildSystemPrompt } from '@main/prompt/build'
import { registerRuntimeServices } from '@main/dsh/services'
import type { AppSettings, FileNode, ProjectInfo } from '@shared/types'
import { HOOKS, buildHookSource } from '@main/providers/hooks'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accent: '#8dff4f',
  language: 'zh-CN',
  pureMode: false,
  dangerConfirm: true,
  ssrfProtection: true,
  commandTimeoutMs: 30_000,
  sandboxTimeoutMs: 60_000,
  outputBufferLimit: 1024 * 1024,
  compactThreshold: 60_000,
  autoCompact: true,
  globalHotkeys: HotkeyManager.defaults(),
  securityMod: { enabled: true, ctfInject: false, refusalRewrite: 'off', maxRewrites: 2 },
  sync: {}
}

/** 循环所需的会话存储门面：按会话所属项目动态路由（修复上游 #24 串扰的根） */
function routedSessionFacade(resolve: (sessionId: string) => SessionStore): SessionStore {
  const facade = {
    appendTurn: (id: string, t: Parameters<SessionStore['appendTurn']>[1]) => resolve(id).appendTurn(id, t),
    patchTurn: (id: string, tid: string, p: Parameters<SessionStore['patchTurn']>[2]) => resolve(id).patchTurn(id, tid, p),
    update: (id: string, fn: Parameters<SessionStore['update']>[1]) => resolve(id).update(id, fn),
    get: (id: string) => resolve(id).get(id)
  }
  return facade as unknown as SessionStore
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
  private projectDirs = new Map<string, string>()
  private sessionStores = new Map<string, SessionStore>()
  private providerRegistries = new Map<string, ProviderRegistry>()
  private dshKv!: JsonStore<Record<string, Record<string, unknown>>>
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
    this.registerKbTool()

    this.loop = new AgentLoop({
      store: routedSessionFacade((id) => this.sessionStoreOf(this.sessionProjectOf(id))),
      tools: this.tools,
      toolCtxBase: () => this.toolCtx(''),
      confirm: (sessionId, reason) => this.requestConfirm(sessionId, reason),
      sendToPage: (sessionId, text) => this.overlay.sendToPage(sessionId, text),
      awaitReply: (sessionId, onChunk) => this.overlay.awaitReply(sessionId, onChunk),
      interruptPage: (sessionId) => this.overlay.interruptPage(sessionId),
      emit: (event) => this.emit(event),
      settings: () => ({
        autoCompact: this.settings.get().autoCompact,
        compactThreshold: this.settings.get().compactThreshold
      }),
      securityMod: () => {
        const m = this.settings.get().securityMod
        return {
          mode: m.refusalRewrite,
          ctfInject: m.ctfInject,
          maxRewrites: m.maxRewrites,
          rewriteApi: m.rewriteApi,
          customPatterns: m.customPatterns ?? [],
          customNotice: m.customNotice ?? ''
        }
      },
      captureMemory: (content) => this.memory.add(content.slice(0, 40), content, ['标记'], 'marker'),
      systemPromptFor: (sessionId) => this.systemPromptFor(sessionId)
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
    this.hotkeys.registerAction('new-session', () => this.emit({ type: 'notice', sessionId: '', level: 'info', message: 'action:new-session' }))
    this.hotkeys.registerAction('toggle-pure', () => this.emit({ type: 'notice', sessionId: '', level: 'info', message: 'action:toggle-pure' }))
    this.hotkeys.applyAll()

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

    app.on('web-contents-created', (_e, wc) => {
      wc.on('destroyed', () => this.overlay.disposeWebContents(wc.id))
      // 嵌入式 webview 环境漂白：UA 去除 Electron 标识，对齐真实 Chrome（缓解平台"使用环境异常"误判）
      if (wc.getType() === 'webview') {
        try {
          const chrome = process.versions.chrome ?? '126'
          wc.setUserAgent(
            `Mozilla/5.0 (${os.platform() === 'win32' ? 'Windows NT 10.0; Win64; x64' : os.platform()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
          )
        } catch {
          /* 忽略 */
        }
      }
    })

    void this.mcp.connectAll()
    Logger.info('context', 'AppContext 初始化完成')
  }

  private focusWindow(): void {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
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
    // 网络层 hook 由主进程注入主世界（preload 的 webFrame 在隔离世界，hook 不到页面 fetch）
    const spec = HOOKS[provider.id]
    if (spec) void this.overlay.injectHook(sessionId, buildHookSource(spec))
  }

  private registerEcosystemTools(): void {
    for (const t of createEcosystemTools({
      memory: this.memory,
      plans: this.plans,
      projectRoot: () => this.activeProject()?.root ?? '',
      currentSessionId: () => this.lastSessionId
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

  // ---------- 项目 ----------

  activeProject(): ProjectInfo | null {
    const id = this.projectStore.get().activeProjectId
    return this.projects.find((p) => p.id === id) ?? null
  }

  activeProjectId(): string | null {
    return this.projectStore.get().activeProjectId
  }

  openProject(root: string): ProjectInfo {
    let p = this.projects.find((x) => x.root === root)
    if (!p) {
      p = { id: `proj_${nanoid(8)}`, name: basename(root), root, createdAt: Date.now(), lastOpenedAt: Date.now() }
      this.projects.push(p)
    }
    p.lastOpenedAt = Date.now()
    this.projectStore.set({ projects: this.projects, activeProjectId: p.id })
    return p
  }

  closeProject(projectId: string): void {
    const cur = this.projectStore.get().activeProjectId
    if (cur === projectId) this.projectStore.set({ activeProjectId: null })
  }

  private projectDirOf(projectId: string): string {
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
    const project = this.activeProject()
    return {
      projectRoot: project?.root ?? process.cwd(),
      settings: {
        commandTimeoutMs: s.commandTimeoutMs,
        sandboxTimeoutMs: s.sandboxTimeoutMs,
        outputBufferLimit: s.outputBufferLimit,
        ssrfProtection: s.ssrfProtection,
        dangerConfirm: s.dangerConfirm
      },
      confirm: (reason) => this.requestConfirm(sessionId, reason),
      injectJs: (code) => this.overlay.executeJs(sessionId, code),
      audit: (kind, summary, detail, backupPath) => this.audit.record(sessionId, kind, summary, detail, backupPath)
    }
  }

  private requestConfirm(sessionId: string, reason: string): Promise<boolean> {
    this.lastSessionId = sessionId
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

  systemPromptFor(sessionId: string): string {
    const project = this.activeProject()
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
        entries = readdirSync(dir).filter((n) => !EXCL.has(n) && !n.startsWith('.'))
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

  async updateCheck(): Promise<{ hasUpdate: boolean; version?: string; url?: string }> {
    return checkForUpdate()
  }

  async dshCoverage(): Promise<{ total: number; implemented: string[]; missing: string[] }> {
    return this.dsh.coverage()
  }

  /** 供测试/调试：直接读会话存储（按项目 id） */
  sessionStoreFor(projectId: string): SessionStore {
    return this.sessionStoreOf(projectId)
  }
}
