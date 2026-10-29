import { app, BrowserWindow, dialog, shell, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AppContext } from './context'
import type { IpcHandler } from '../index'
import { TodoBoard } from '@main/ecosystem/todos'
import { BUILT_IN_PROVIDERS } from '@main/providers/registry'
import { runTerminal } from '@main/tools/terminal'
import type { DomAdapter, McpServerConfig, ProviderDescriptor, QuickCommand, StopLevel } from '@shared/types'


/** 主题令牌 → Chromium nativeTheme：嵌入网页经 prefers-color-scheme 跟随应用主题 */
function applyNativeTheme(theme: unknown): void {
  // 主题映射：light/graphite 是浅色系，dark/midnight 是深色系，system 跟随系统。
  // 旧版 warm（暖沙）已废弃并迁移为 graphite。
  const LIGHT_THEMES = new Set(['light', 'graphite', 'warm'])
  const DARK_THEMES = new Set(['dark', 'midnight'])
  const key = String(theme ?? 'dark')
  const t = key === 'system' ? 'system' : LIGHT_THEMES.has(key) ? 'light' : DARK_THEMES.has(key) ? 'dark' : 'dark'
  if (nativeTheme.themeSource !== t) nativeTheme.themeSource = t
}

/** 全量 IPC 方法注册：方法名 = LidowApi 契约方法名（renderer Proxy 按 name 调用） */
export function registerHandlers(
  register: (name: string, fn: IpcHandler) => void,
  ctx: AppContext
): void {
  const R = register

  applyNativeTheme(ctx.settings.get().theme)
  // ---------- 应用 ----------
  R('getAppState', () => ({
    projects: ctx.projects,
    activeProjectId: ctx.activeProjectId(),
    settings: ctx.settings.get(),
    version: app.getVersion()
  }))
  R('updateSettings', (...args: unknown[]) => {
    const patch = args[0] as Record<string, unknown>
    const next = ctx.settings.set(patch as never)
    ctx.hotkeys.applyAll()
    applyNativeTheme(next.theme)
    return next
  })
  R('pickDirectory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0] ?? null
  })
  R('openProject', (root: string) => {
    const r = String(root ?? '')
    if (!r || r === 'undefined' || !r.match(/^[A-Za-z]:[/\\]/)) throw new Error('无效的项目路径: ' + r)
    return ctx.openProject(r)
  })
  R('closeProject', (projectId: string) => ctx.closeProject(String(projectId)))
  R('quit', () => app.quit())

  // ---------- 窗口控制（自绘标题栏） ----------
  R('windowMinimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  R('windowToggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  R('windowClose', () => BrowserWindow.getFocusedWindow()?.close())
  R('windowIsMaximized', () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false)

  // ---------- Provider / 账号 ----------
  R('listProviders', (projectId: string) => {
    // 没有项目时返回内置平台表：用户需要能先进 AI 页面，引导才会出现在网页里。
    // 这些描述是只读副本，不带持久化账号（账号属于具体项目）。
    if (!projectId || projectId === 'undefined') {
      return BUILT_IN_PROVIDERS.filter((p) => p.enabled).map((p) => ({ ...p, accounts: [] }))
    }
    return ctx.providerRegistryOf(String(projectId)).list()
  })
  R('addProvider', (...args: unknown[]) => {
    const [projectId, desc] = args as [string, { id: string; name: string; home: string; adapter?: Partial<ProviderDescriptor['adapter']> }]
    return ctx.providerRegistryOf(String(projectId)).add(desc)
  })
  R('removeProvider', (projectId: string, providerId: string) => ctx.providerRegistryOf(String(projectId)).remove(String(providerId)))
  R('addAccount', (projectId: string, providerId: string, label: string) =>
    ctx.providerRegistryOf(String(projectId)).addAccount(String(providerId), String(label ?? ''))
  )
  R('switchAccount', (projectId: string, providerId: string, accountId: string) => {
    ctx.providerRegistryOf(String(projectId)).switchAccount(String(providerId), String(accountId))
    return ctx.providerRegistryOf(String(projectId)).get(String(providerId))
  })
  R('removeAccount', (projectId: string, providerId: string, accountId: string) => {
    ctx.providerRegistryOf(String(projectId)).removeAccount(String(providerId), String(accountId))
    return ctx.providerRegistryOf(String(projectId)).get(String(providerId))
  })
  R('updateProviderAdapter', (projectId: string, providerId: string, adapter: ProviderDescriptor['adapter']) =>
    ctx.providerRegistryOf(String(projectId)).update(String(providerId), { adapter })
  )

  // ---------- 会话 ----------
  R('listSessions', (projectId: string, providerId?: string) =>
    ctx.sessionStoreOf(String(projectId)).list(providerId ? String(providerId) : undefined)
  )
  R('getSession', (sessionId: string) => ctx.sessionOf(String(sessionId)))
  R('createSession', (...args: unknown[]) => {
    const [projectId, providerId, parentSessionId] = args as [string, string, string?]
    const store = ctx.sessionStoreOf(String(projectId))
    // 新建前回收同平台的历史空会话（0 轮次）：点一次平台建一次会话，
    // 用户没发消息就切走的话，列表会被「新会话」堆满（实测堆过 11 个）
    if (!parentSessionId) {
      for (const m of store.list()) {
        if (m.providerId !== String(providerId)) continue
        if (m.id === ctx.lastSessionId) continue
        if ((store.get(m.id)?.turns.length ?? 0) === 0) store.delete(m.id)
      }
    }
    return store.create(String(projectId), String(providerId), parentSessionId)
  })
  /** 清理空会话（0 轮次）：新建后从未发送的会话会无限堆积 */
  R('cleanupEmptySessions', (projectId: string, keepSessionId?: string) => {
    const store = ctx.sessionStoreOf(String(projectId))
    let removed = 0
    for (const m of store.list()) {
      if (m.id === keepSessionId) continue
      if ((store.get(m.id)?.turns.length ?? 0) === 0) {
        ctx.overlay.unbindSession(m.id)
        store.delete(m.id)
        removed++
      }
    }
    return removed
  })
  R('deleteSession', (sessionId: string) => {
    ctx.overlay.unbindSession(String(sessionId))
    const project = findProjectOfSession(ctx, String(sessionId))
    if (project) ctx.sessionStoreOf(project).delete(String(sessionId))
  })
  R('renameSession', (sessionId: string, title: string) => {
    const project = findProjectOfSession(ctx, String(sessionId))
    if (project) ctx.sessionStoreOf(project).rename(String(sessionId), String(title))
  })
  R('compactSession', (sessionId: string) => {
    ctx.loop.compactNow(String(sessionId))
    return ctx.sessionOf(String(sessionId))
  })

  // ---------- Agent 循环 ----------
  R('sendPrompt', (sessionId: string, text: string) => {
    ctx.lastSessionId = String(sessionId)
    void ctx.loop.run(String(sessionId), String(text))
    void ctx.sync.pushAll(`Lidow 收到新任务：${String(text).slice(0, 200)}`)
  })
  R('stop', (level: StopLevel) => {
    ctx.stopAll((level ?? 'all') as StopLevel)
  })
  R('newChat', (sessionId: string) => {
    ctx.overlay.sendCmd(String(sessionId), { kind: 'new-chat' })
  })
  R('confirmTool', (callId: string, approved: boolean) => {
    ctx.resolveConfirm(String(callId), Boolean(approved))
  })
  R('confirmPlan', (sessionId: string, approved: boolean, edits?: { id: string; title: string; detail: string }[]) => {
    if (approved) ctx.plans.confirm(String(sessionId), edits)
    else ctx.plans.abort(String(sessionId))
  })
  R('abortPlan', (sessionId: string) => {
    ctx.plans.abort(String(sessionId))
    ctx.loop.stop(String(sessionId), 'all')
  })
  R('getActivePlan', (sessionId: string) => ctx.plans.activeOf(String(sessionId)))

  // ---------- 人机共用待办看板 ----------
  const boardOf = (): TodoBoard => {
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    return new TodoBoard(project.root)
  }
  R('listTodos', () => boardOf().list())
  R('addTodo', (title: string) => {
    boardOf().add(String(title))
    return boardOf().list()
  })
  R('setTodoStatus', (id: string, status: 'pending' | 'running' | 'done' | 'failed' | 'skipped') => {
    boardOf().setStatus(String(id), status)
    return boardOf().list()
  })
  R('clearDoneTodos', () => {
    boardOf().clearDone()
    return boardOf().list()
  })

  // ---------- 会话导出 ----------
  R('exportSession', (sessionId: string) => {
    const session = ctx.sessionOf(String(sessionId))
    if (!session) throw new Error('会话不存在')
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    const md = [
      `# ${session.title}`,
      ``,
      `- 平台：${session.providerId}`,
      `- 导出时间：${new Date().toLocaleString()}`,
      `- 轮次：${session.turns.length}${session.compactedTurns > 0 ? `（已压缩 ${session.compactedTurns} 轮）` : ''}`,
      ``,
      `---`,
      ``,
      ...session.turns.map((t) => {
        const role = t.role === 'user' ? '## 🧑 用户' : t.role === 'assistant' ? '## 🤖 AI' : '## ⚙️ 系统'
        const tools = t.toolResults?.map((r) => `> 工具 ${r.name} → ${r.ok ? '✓' : '✗'} ${r.durationMs}ms`).join('\n') ?? ''
        return `${role}\n\n${t.text}\n${tools ? `\n${tools}\n` : ''}`
      })
    ].join('\n')
    const dir = join(project.root, '.lidow', 'exports')
    mkdirSync(dir, { recursive: true })
    const safeName = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session'
    const file = join(dir, `${safeName}-${session.id.slice(-6)}.md`)
    writeFileSync(file, md, 'utf-8')
    return file
  })

  // ---------- 顶栏工具 ----------
  R('revealPath', async (target: string) => {
    const p = String(target ?? '')
    if (!p || !existsSync(p)) return false
    shell.showItemInFolder(p)
    return true
  })
  R('openExportDir', () => {
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    const dir = join(project.root, '.lidow', 'exports')
    mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
    return dir
  })
  R('terminalCwd', () => ctx.activeProject()?.root ?? process.cwd())
  R('listTools', () => ctx.tools.all().map((t) => ({ name: t.name, description: t.description })))
  R('openExternal', async (url: string) => {
    const u = String(url ?? '')
    // 只放行 http(s)，避免 file:// 或自定义协议被执行
    if (!/^https?:\/\//i.test(u)) return false
    await shell.openExternal(u)
    return true
  })
  R('runTerminal', async (command: string, cwd?: string) => {
    const project = ctx.activeProject()
    const root = project?.root ?? process.cwd()
    // 只允许在项目目录内执行（终端面板不提供越界能力）
    let workdir = root
    const raw = String(cwd ?? '')
    if (raw) {
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
      if (resolved.startsWith(resolve(root))) workdir = resolved
    }
    return runTerminal(String(command ?? ''), workdir)
  })

  // ---------- 工具 / 文件 ----------
  R('readFileTree', (projectId: string, dir: string, depth: number) => {
    const project = ctx.projects.find((p) => p.id === String(projectId))
    return project ? ctx.readFileTree(project.root, String(dir ?? ''), Number(depth ?? 3)) : []
  })
  R('readFileContent', (projectId: string, relPath: string) => {
    const project = ctx.projects.find((p) => p.id === String(projectId))
    if (!project) throw new Error('项目不存在')
    return readFileSync(join(project.root, String(relPath)), 'utf-8')
  })
  R('openPathInSystem', (path: string) => void shell.openPath(String(path)))

  // ---------- 生态 ----------
  R('listSkills', () => import('@main/ecosystem/skills').then((m) => m.listSkills(ctx.activeProject()?.root)))
  R('listAgents', () => import('@main/ecosystem/skills').then((m) => m.listAgents(ctx.activeProject()?.root)))
  R('listRules', () => import('@main/ecosystem/skills').then((m) => m.listRules(ctx.activeProject()?.root)))
  R('readSkill', (path: string) =>
    import('@main/ecosystem/skills').then((m) => m.readSkill(String(path), ctx.activeProject()?.root))
  )
  R('listMemory', () => ctx.memory.list())
  R('addMemory', (title: string, content: string, tags: string[]) =>
    ctx.memory.add(String(title), String(content), (tags as string[]) ?? [], 'manual')
  )
  R('deleteMemory', (id: string) => ctx.memory.remove(String(id)))

  // ---------- MCP ----------
  R('listMcpServers', () => ctx.mcp.listServers())
  R('addMcpServer', async (cfg: McpServerConfig) => {
    const list = ctx.mcp.addServer(cfg)
    try {
      await ctx.mcp.connect(String(cfg.name))
    } catch {
      /* 连接失败保留配置，UI 提示 */
    }
    return list
  })
  R('removeMcpServer', (name: string) => ctx.mcp.removeServer(String(name)))
  R('listMcpTools', () => ctx.mcp.listTools())

  // ---------- 插件 ----------
  R('listInstalledPlugins', () => ctx.plugins.list())
  R('listBuiltinPlugins', () => ctx.plugins.listBuiltins())
  R('searchMarket', (query: string, category?: string) =>
    ctx.plugins.searchMarket(String(query ?? ''), category ? String(category) : undefined)
  )
  R('installPlugin', async (id: string) => {
    const [source, repo] = String(id).split(':')
    if (source === 'builtin') {
      ctx.plugins.installBuiltin(String(repo ?? id))
    } else {
      await ctx.plugins.install(repo ?? String(id), source === 'gitee' ? 'gitee' : 'github')
    }
    await ctx.loadAllPlugins()
    return ctx.plugins.list()
  })
  R('uninstallPlugin', (id: string) => {
    ctx.plugins.uninstall(String(id))
    // 已加载的 DSH 服务没有卸载通道，需要重启才彻底失效（如实提示）
    void ctx.loadAllPlugins()
    return ctx.plugins.list()
  })
  R('togglePlugin', (id: string, enabled: boolean) => {
    ctx.plugins.toggle(String(id), Boolean(enabled))
    void ctx.loadAllPlugins()
    return ctx.plugins.list()
  })

  // ---------- DSH ----------
  R('dshCoverage', () => ctx.dshCoverage())
  R('getTokenStats', () => ctx.tokenStats())

  // ---------- 任务 / 审计 ----------
  R('listAudit', (sessionId?: string, limit?: number) => ctx.audit.list(sessionId ? String(sessionId) : undefined, Number(limit ?? 200)))
  R('revertAudit', (entryId: string) => ctx.audit.revert(String(entryId)))

  // ---------- 知识库 ----------
  R('listKnowledgeBases', () => ctx.knowledge.list())
  R('addKnowledgeBase', (name: string, root: string) => ctx.knowledge.add(String(name), String(root)))
  R('removeKnowledgeBase', (id: string) => ctx.knowledge.remove(String(id)))
  R('searchKnowledge', (kbId: string, query: string, limit?: number) =>
    ctx.knowledge.search(String(kbId), String(query), Number(limit ?? 5))
  )

  // ---------- 快捷指令 ----------
  R('listQuickCommands', () => ctx.quickCommands.list())
  R('saveQuickCommand', (cmd: QuickCommand) => ctx.quickCommands.save(cmd))
  R('deleteQuickCommand', (id: string) => ctx.quickCommands.remove(String(id)))

  // ---------- 视图 ----------
  R('attachWebview', (providerId: string, accountId: string) => {
    if (!providerId || typeof providerId !== 'string') throw new Error('attachWebview 缺少 providerId')
    const overlayPath = join(__dirname, '../preload/overlay.js')
    const project = ctx.activeProject()
    // 没有项目时也允许打开 AI 页面：初始化引导由 overlay 注入在网页里
    // （cuckoo 的 first-time-dialog 同款位置）。挡在外面的话用户永远看不到引导。
    if (!project) {
      const p = BUILT_IN_PROVIDERS.find((x) => x.id === String(providerId))
      if (!p) throw new Error(`未知平台: ${String(providerId)}`)
      return {
        // partition 格式必须与 partitionOf 完全一致（persist:lidow-<id>-default），
        // 否则先无项目登录、后开项目会拿到两个不同分区，登录态凭空丢失
        partition: `persist:lidow-${p.id}-default`,
        overlayPath,
        home: p.home,
        // 无项目也要下发 adapter：overlay 靠它判断登录态，
        // 而首次引导必须等"登录完成"才弹
        adapter: p.adapter
      }
    }
    const reg = ctx.providerRegistryOf(project.id)
    if (!reg.get(String(providerId))) throw new Error(`未知平台: ${String(providerId)}`)
    return {
      partition: reg.partitionOf(String(providerId), accountId ? String(accountId) : undefined),
      overlayPath,
      home: reg.get(String(providerId))?.home ?? ''
    }
  })
  R('bindSession', (sessionId: string, webContentsId: number) => {
    ctx.overlay.bindSession(String(sessionId), Number(webContentsId))
    ctx.configureOverlay(String(sessionId))
  })
  /**
   * 还没有会话时（无项目也能进 AI 页面）给网页侧下发运行所需配置：
   * DOM adapter（登录态轮询依赖它）+ 当前项目目录（决定是否弹首次引导）。
   * 按 webContentsId 下发，不依赖会话绑定。
   */
  /** 让页面落到指定会话自己的对话（有 providerUrl 导航回原对话，否则开新聊天） */
  R('landSession', (sessionId: string) => ctx.landSession(String(sessionId)))
  R('syncProjectToWebview', (webContentsId: number, adapter?: unknown, providerId?: string) => {
    const id = Number(webContentsId)
    // 渲染层可能还没拿到 adapter（无会话时 tab 记录可能是空的）。
    // 按 providerId 精确查表，不要随便拿一个平台的 adapter ——
    // 每个平台的 avatar 选择器不同，用错会导致登录态误判。
    let ad = adapter as DomAdapter | undefined
    if (!ad && providerId) {
      ad = ctx.activeProject()
        ? ctx.providerRegistryOf(ctx.activeProject()!.id).get(String(providerId))?.adapter
        : BUILT_IN_PROVIDERS.find((p) => p.id === String(providerId))?.adapter
    }
    if (ad) ctx.overlay.sendCmdToWebContents(id, { kind: 'configure', adapter: ad })
    const root = ctx.activeProject()?.root ?? null
    return ctx.overlay.sendCmdToWebContents(id, { kind: 'set-project', projectRoot: root })
  })
  R('setPureMode', (on: boolean) => {
    ctx.settings.set({ pureMode: Boolean(on) })
  })
  R('checkUpdate', () => ctx.updateCheck())
  R('downloadUpdate', () =>
    import('@main/app/platform').then((m) =>
      m.downloadAndInstallUpdate((e) => ctx.emit({ ...e, sessionId: '' }))
    )
  )
  R('listTemplates', () => ctx.templates())
  R('applyTemplate', (templateId: string, root: string) => ctx.applyTemplate(String(templateId), String(root)))
  R('pushToSync', (text: string) => ctx.pushSync(String(text)))
}

function findProjectOfSession(ctx: AppContext, sessionId: string): string | null {
  for (const p of ctx.projects) {
    if (ctx.sessionStoreOf(p.id).get(sessionId)) return p.id
  }
  return null
}
