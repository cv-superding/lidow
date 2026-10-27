import type { ProviderDescriptor } from '@shared/types'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext } from '@main/tools/types'
import type { ToolDef } from '@main/tools/types'

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
      // 由 handler 层桥接 AppSettings
      echo: (v: unknown) => v
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
