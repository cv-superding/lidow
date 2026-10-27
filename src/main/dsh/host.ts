import type { AppSettings, FileNode, ProviderDescriptor, SessionMeta } from '@shared/types'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext, ToolDef } from '@main/tools/types'
import type { SessionStore } from '@main/session/store'
import type { TaskPlanStore } from '@main/ecosystem/taskPlan'
import type { CredentialVault } from '@main/infra/vault'
import type { JobScheduler, Job } from '@main/infra/jobs'
import { listAgents, listSkills, readSkill } from '@main/ecosystem/skills'

/**
 * DSH 宿主（DeepSeek Harness 兼容层）。
 * 插件通过 ctx.xxx 访问 Context 服务；Lidow 将内部能力映射为 DSH 服务。
 * 覆盖进度见 docs/dsh-coverage.md（当前批次 + 全部 119 服务清单）。
 */

export interface DshService {
  name: string
  category: 'core' | 'session' | 'storage' | 'registry' | 'ui' | 'ext' | 'misc'
  /** 服务实现：方法集（never[] 逆变允许具体签名） */
  methods: Record<string, (...args: never[]) => unknown>
}

export interface DshPluginContext {
  [service: string]: unknown
}

type DshRegistrar = (ctx: DshPluginContext) => void | Promise<void>

export class DshHost {
  private services = new Map<string, DshService>()

  constructor(
    private deps: {
      tools: ToolRegistry
      execTool: ToolDef
      projectRoot: () => string
      providers: () => ProviderDescriptor[]
      tokenStats: () => { totalChars: number; tps: number }
      slots: { register: (slot: unknown) => void; list: () => unknown[] }
      /** B1：会话服务底座 */
      sessions: () => SessionStore | null
      activeProjectId: () => string | null
      /** B4：任务计划 / 文件树 */
      plans: TaskPlanStore
      readFileTree: (root: string, rel: string, depth: number) => FileNode[]
      /** B2：设置 / 快捷键 */
      settings: { get: () => AppSettings; patch: (p: Partial<AppSettings>) => AppSettings }
      onHotkeysChange?: () => void
      /** B3：凭据保险库 / 作业调度 */
      vault: CredentialVault
      jobs: JobScheduler
    }
  ) {
    this.registerBuiltIns()
  }

  private registerBuiltIns(): void {
    const d = this.deps
    const svc = (name: string, category: DshService['category'], methods: Record<string, (...args: never[]) => unknown>): void => {
      this.services.set(name, { name, category, methods })
    }

    svc('tools', 'core', {
      list: () => d.tools.names(),
      describe: () => d.tools.describeForPrompt(),
      call: async (name: string, input: Record<string, unknown>, ctx: ToolContext) => {
        const def = d.tools.get(String(name))
        if (!def) throw new Error(`未知工具: ${String(name)}`)
        const out = await def.run(input, ctx)
        return { ok: out.ok, output: out.output, error: out.error }
      }
    })
    svc('fs', 'core', {
      read: (path: string) => d.tools.get('read')?.run({ path }, this.voidCtx()),
      write: (path: string, content: string) => d.tools.get('write')?.run({ path, content }, this.voidCtx())
    })
    svc('shell', 'core', {
      exec: (command: string) => d.tools.get('bash')?.run({ command }, this.voidCtx())
    })
    svc('web', 'core', {
      fetch: (url: string) => d.tools.get('webFetch')?.run({ url }, this.voidCtx())
    })
    svc('providers', 'registry', {
      list: () => d.providers()
    })
    svc('workspaceRegistry', 'registry', {
      root: () => d.projectRoot()
    })
    svc('tokenMeter', 'registry', {
      stats: () => d.tokenStats()
    })
    svc('slots', 'ui', {
      register: (slot: unknown) => d.slots.register(slot),
      list: () => d.slots.list()
    })
    // storage/storageDomain：插件持久化 KV（JsonStore 由调用侧落盘）
    svc('storage', 'storage', {
      get: (key: string) => this.kv.get(key),
      set: (key: string, value: unknown) => {
        this.kv.set(key, value)
        return true
      },
      delete: (key: string) => this.kv.delete(key),
      keys: () => [...this.kv.keys()]
    })
    svc('settings', 'ui', {
      get: () => d.settings.get(),
      patch: (p: Partial<AppSettings>) => d.settings.patch(p)
    })
    svc('settingsController', 'ui', {
      patch: (p: Partial<AppSettings>) => d.settings.patch(p),
      reset: () => d.settings.patch({ theme: 'dark', accent: '#5b8cff' })
    })
    svc('shortcuts', 'ui', {
      get: () => d.settings.get().globalHotkeys,
      set: (hotkeys: Record<string, string>) => {
        d.settings.patch({ globalHotkeys: hotkeys })
        d.onHotkeysChange?.()
        return true
      }
    })
    svc('theme', 'ui', {
      get: () => d.settings.get().theme,
      set: (theme: 'dark' | 'light' | 'system') => {
        d.settings.patch({ theme })
        return true
      }
    })
    svc('locale', 'ui', {
      get: () => d.settings.get().language,
      set: (lang: 'zh-CN' | 'en-US') => {
        d.settings.patch({ language: lang })
        return true
      }
    })
    // ---- B1：会话 ----
    svc('sessions', 'session', {
      list: (providerId?: string): SessionMeta[] => d.sessions()?.list(providerId) ?? [],
      get: (id: string) => d.sessions()?.get(String(id)) ?? null,
      create: (providerId: string) => {
        const store = d.sessions()
        if (!store) throw new Error('未打开项目')
        return store.create(d.activeProjectId() ?? 'default', String(providerId))
      }
    })
    svc('sessionTitle', 'session', {
      get: (id: string) => d.sessions()?.get(String(id))?.title ?? null,
      rename: (id: string, title: string) => {
        d.sessions()?.rename(String(id), String(title))
        return true
      }
    })
    svc('sessionPersistence', 'session', {
      // Lidow 会话天然持久化；此服务暴露读写标记供插件感知
      status: (id: string) => (d.sessions()?.get(String(id)) ? 'persisted' : 'missing'),
      flush: () => true
    })
    svc('sessionQuery', 'session', {
      search: (keyword: string): SessionMeta[] => {
        const store = d.sessions()
        if (!store) return []
        const kw = String(keyword).toLowerCase()
        return store
          .list()
          .filter((m) => m.title.toLowerCase().includes(kw))
          .slice(0, 20)
      }
    })
    // ---- B4：注册表 ----
    svc('skills', 'registry', {
      list: () => listSkills(d.projectRoot()),
      read: (name: string) => {
        const skill = listSkills(d.projectRoot()).find((s) => s.name === String(name))
        return skill ? readSkill(skill.path, d.projectRoot()) : null
      }
    })
    svc('subagents', 'registry', {
      list: () => listAgents(d.projectRoot())
    })
    svc('goals', 'registry', {
      active: (sessionId: string) => d.plans.activeOf(String(sessionId)),
      propose: (sessionId: string, goal: string, steps: { title: string; detail: string }[]) =>
        d.plans.propose(String(sessionId), String(goal), steps),
      confirm: (sessionId: string) => d.plans.confirm(String(sessionId)),
      abort: (sessionId: string) => d.plans.abort(String(sessionId))
    })
    svc('workspaceFiles', 'registry', {
      tree: (rel: string, depth: number) => d.readFileTree(d.projectRoot(), String(rel ?? ''), Number(depth ?? 2))
    })
    // ---- B3：作业与凭据 ----
    svc('jobs', 'misc', {
      create: (name: string, kind: 'interval' | 'daily', value: number | string, action: string): Job =>
        d.jobs.create(
          String(name),
          kind === 'interval' ? { kind: 'interval', intervalMs: Number(value) } : { kind: 'daily', at: String(value) },
          String(action)
        ),
      list: () => d.jobs.list(),
      get: (id: string) => d.jobs.get(String(id)) ?? null,
      remove: (id: string) => d.jobs.remove(String(id)),
      trigger: (id: string) => d.jobs.trigger(String(id))
    })
    svc('jobController', 'misc', {
      start: (id: string) => d.jobs.setEnabled(String(id), true),
      stop: (id: string) => d.jobs.setEnabled(String(id), false)
    })
    svc('schedule', 'misc', {
      interval: (name: string, minutes: number, action: string) =>
        d.jobs.create(String(name), { kind: 'interval', intervalMs: Math.max(1, Number(minutes)) * 60_000 }, String(action)),
      daily: (name: string, at: string, action: string) =>
        d.jobs.create(String(name), { kind: 'daily', at: String(at) }, String(action))
    })
    svc('scheduler', 'misc', {
      list: () => d.jobs.list(),
      cancel: (id: string) => d.jobs.remove(String(id))
    })
    svc('credentials', 'misc', {
      set: (key: string, value: string) => {
        d.vault.set(String(key), String(value))
        return true
      },
      get: (key: string) => d.vault.get(String(key)),
      delete: (key: string) => d.vault.delete(String(key)),
      keys: () => d.vault.keys()
    })
    svc('secretStore', 'misc', {
      set: (key: string, value: string) => d.vault.set(String(key), String(value)),
      get: (key: string) => d.vault.get(String(key)),
      delete: (key: string) => d.vault.delete(String(key))
    })
  }

  private kv = new Map<string, unknown>()

  private voidCtx(): ToolContext {
    return {
      projectRoot: this.deps.projectRoot(),
      settings: { commandTimeoutMs: 30000, sandboxTimeoutMs: 60000, outputBufferLimit: 1048576, ssrfProtection: true, dangerConfirm: false },
      confirm: async () => true
    }
  }

  /** 装载插件提供的 DSH 入口（CommonJS/ESM 模块，导出 register(ctx)） */
  async loadPluginEntry(entryPath: string): Promise<void> {
    const mod = (await import(entryPath)) as { register?: DshRegistrar }
    if (typeof mod.register !== 'function') throw new Error('DSH 插件入口缺少 register(ctx)')
    await mod.register(this.contextFor(entryPath))
  }

  contextFor(_pluginId: string): DshPluginContext {
    const ctx: DshPluginContext = {}
    for (const [name, svc] of this.services) ctx[name] = svc.methods
    return ctx
  }

  listServices(): { name: string; category: string }[] {
    return [...this.services.values()].map((s) => ({ name: s.name, category: s.category }))
  }

  /** 覆盖度：对照 DSH v0.2.0-rc.2 的 119 服务全名单 */
  coverage(implementedExtra: string[] = []): { total: number; implemented: string[]; missing: string[] } {
    const ALL = DshHost.ALL_SERVICES_119
    const implemented = [...this.services.keys(), ...implementedExtra]
    const missing = ALL.filter((s) => !implemented.includes(s))
    return { total: ALL.length, implemented, missing }
  }

  /** 119 服务全名单（来源：cuckoo-code docs/dsh-api-coverage.md，基于 DSH v0.2.0-rc.2） */
  static readonly ALL_SERVICES_119: string[] = [
    // core/tool 11
    'tools', 'systemPrompt', 'fs', 'shell', 'terminals', 'web', 'mcpResources', 'subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv',
    // session 15
    'sessions', 'sessionTitle', 'sessionProjections', 'sessionQuery', 'sessionPersistence', 'sessionProjectionCache', 'sessionLogDownload', 'sessionController', 'sessionFileReferences', 'sessionReferenceResolver', 'sessionSkillCatalog', 'sessionTelemetry', 'sessionFeedback', 'fileReferences', 'spillStore',
    // storage 2
    'storage', 'storageDomain',
    // registry 8
    'skills', 'subagents', 'workspaceRegistry', 'workspaceFiles', 'goals', 'llm', 'tokenMeter', 'subagentModelSelection',
    // client ui 20
    'slots', 'settings', 'webServer', 'uiWorkspace', 'uiSession', 'locale', 'theme', 'shortcuts', 'fileUpload', 'settingsController', 'uiChat', 'uiInput', 'uiMessages', 'uiToasts', 'uiDialogs', 'uiPanels', 'uiToolbar', 'uiStatus', 'uiNotifications', 'uiOverlays',
    // ext 9
    'lsp', 'pluginManager', 'pluginPackages', 'hmr', 'ptcRuntime', 'typert', 'typertGateway', 'extensionPoints', 'hookRegistry',
    // misc 54
    'workflowEngine', 'webhookRuntime', 'jobs', 'jobController', 'schedule', 'scheduler', 'credentials', 'secretStore', 'otel', 'telemetry', 'metrics', 'tracing', 'logging', 'audit', 'permissions', 'auth', 'users', 'teams', 'shares', 'comments', 'notifications', 'email', 'calendar', 'tasks', 'kanban', 'wiki', 'docs', 'search', 'index', 'embeddings', 'vectors', 'rag', 'llmRouter', 'llmFallback', 'llmCache', 'promptLibrary', 'templateEngine', 'render', 'export', 'import', 'convert', 'diff', 'merge', 'patch', 'vcs', 'git', 'containers', 'docker', 'k8s', 'cloud', 'browser', 'screenshot'
  ]
}
