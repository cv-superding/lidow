import { app, dialog, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from './context'
import type { IpcHandler } from '../index'
import type { McpServerConfig, ProviderDescriptor, QuickCommand, StopLevel } from '@shared/types'

/** 全量 IPC 方法注册：方法名 = LidowApi 契约方法名（renderer Proxy 按 name 调用） */
export function registerHandlers(
  register: (name: string, fn: IpcHandler) => void,
  ctx: AppContext
): void {
  const R = register

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
    return next
  })
  R('pickDirectory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0] ?? null
  })
  R('openProject', (root: string) => ctx.openProject(String(root)))
  R('closeProject', (projectId: string) => ctx.closeProject(String(projectId)))
  R('quit', () => app.quit())

  // ---------- Provider / 账号 ----------
  R('listProviders', (projectId: string) => ctx.providerRegistryOf(String(projectId)).list())
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
    return ctx.sessionStoreOf(String(projectId)).create(String(projectId), String(providerId), parentSessionId)
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
  R('searchMarket', (query: string, category?: string) =>
    ctx.plugins.searchMarket(String(query ?? ''), category ? String(category) : undefined)
  )
  R('installPlugin', async (id: string) => {
    const [source, repo] = String(id).split(':')
    await ctx.plugins.install(repo ?? String(id), source === 'gitee' ? 'gitee' : 'github')
    return ctx.plugins.list()
  })
  R('uninstallPlugin', (id: string) => {
    ctx.plugins.uninstall(String(id))
    return ctx.plugins.list()
  })
  R('togglePlugin', (id: string, enabled: boolean) => {
    ctx.plugins.toggle(String(id), Boolean(enabled))
    return ctx.plugins.list()
  })

  // ---------- DSH ----------
  R('dshCoverage', () => ctx.dshCoverage())

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
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    const reg = ctx.providerRegistryOf(project.id)
    return {
      partition: reg.partitionOf(String(providerId), accountId ? String(accountId) : undefined),
      overlayPath: join(__dirname, '../preload/overlay.js'),
      home: reg.get(String(providerId))?.home ?? ''
    }
  })
  R('bindSession', (sessionId: string, webContentsId: number) => {
    ctx.overlay.bindSession(String(sessionId), Number(webContentsId))
    ctx.configureOverlay(String(sessionId))
  })
  R('setPureMode', (on: boolean) => {
    ctx.settings.set({ pureMode: Boolean(on) })
  })
  R('checkUpdate', () => ctx.updateCheck())
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
