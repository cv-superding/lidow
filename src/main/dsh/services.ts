import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import { safePath } from '@main/tools/fs'
import type { DshHost } from './host'
import type { ChatTurn, ProjectInfo, ProviderDescriptor, Session } from '@shared/types'
import type { PluginManager } from '@main/plugins/manager'
import type { McpManager } from '@main/mcp/manager'
import type { KnowledgeManager } from '@main/ecosystem/knowledge'

/**
 * DSH B5/B6 运行期服务：三档实现并诚实标注——
 *  🔗 event-bridge：转发到 renderer 事件/确认门（客户端 UI 类）
 *  ⚙️ native：Lidow 真实能力映射
 *  📦 storage-backed：泛用 CRUD 兜底（插件可存取领域条目，不崩溃；cuckoo 同款"最小可用"哲学）
 */

export interface DshRuntimeDeps {
  kv: JsonStore<Record<string, Record<string, unknown>>>
  emit: (event: unknown) => void
  requestConfirm: (reason: string) => Promise<boolean>
  activeSession: () => Session | null
  activeProject: () => ProjectInfo | null
  appendTurn: (sessionId: string, role: 'system' | 'assistant', text: string) => void
  pluginManager: PluginManager
  mcp: McpManager
  runShell: (command: string) => Promise<unknown>
  llmProviders: () => ProviderDescriptor[]
  promptFragments: () => string
  knowledge: KnowledgeManager
}

type AnyFn = (...args: never[]) => unknown

/** 泛用存储兜底：命名空间 CRUD，持久化到 dsh-kv.json */
function genericStore(kv: JsonStore<Record<string, Record<string, unknown>>>, ns: string): Record<string, AnyFn> {
  const bucket = (): Record<string, unknown> => kv.get()[ns] ?? {}
  return {
    create: (item: Record<string, unknown>): unknown => {
      const id = `it_${Math.random().toString(36).slice(2, 9)}`
      kv.update((d) => ({ ...d, [ns]: { ...bucket(), [id]: { ...item, id, createdAt: Date.now() } } }))
      return { id, ...item }
    },
    list: (): unknown[] => Object.values(bucket()),
    get: (id: string): unknown => bucket()[String(id)] ?? null,
    update: (id: string, patch: Record<string, unknown>): unknown => {
      const cur = bucket()[String(id)]
      if (!cur) return null
      const next = { ...(cur as Record<string, unknown>), ...patch, id: String(id) }
      kv.update((d) => ({ ...d, [ns]: { ...bucket(), [id]: next } }))
      return next
    },
    delete: (id: string): boolean => {
      const b = bucket()
      if (!(String(id) in b)) return false
      kv.update((d) => {
        const rest = { ...bucket() }
        delete rest[String(id)]
        return { ...d, [ns]: rest }
      })
      return true
    },
    count: (): number => Object.keys(bucket()).length
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

/** 最小静态 web 服务器（DSH webServer 插件 UI 宿主），仅回环 + 随机端口 + 目录白名单 */
class MiniWebServer {
  private server: Server | null = null
  private mounts = new Map<string, string>()

  mount(prefix: string, dir: string): number | null {
    if (!this.server) {
      this.server = createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0]!
        for (const [p, dir] of this.mounts) {
          if (!url.startsWith(p)) continue
          const rel = url.slice(p.length).replace(/^\/+/, '') || 'index.html'
          let file: string
          try {
            file = resolve(dir, rel)
            if (!file.startsWith(resolve(dir) + sep) && file !== resolve(dir)) throw new Error('越界')
            if (!existsSync(file) || !statSync(file).isFile()) throw new Error('404')
          } catch {
            res.writeHead(404).end('not found')
            return
          }
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
          res.end(readFileSync(file))
          return
        }
        res.writeHead(404).end('not found')
      })
      try {
        this.server.listen(0, '127.0.0.1')
      } catch (e) {
        Logger.warn('dsh:webServer', `启动失败: ${String(e)}`)
      }
    }
    this.mounts.set(prefix.endsWith('/') ? prefix : prefix + '/', dir)
    return this.port()
  }

  port(): number | null {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : null
  }

  dispose(): void {
    this.server?.close()
    this.server = null
    this.mounts.clear()
  }
}

const webServer = new MiniWebServer()

/** 钩子注册表（hookRegistry / extensionPoints 共享） */
const hooks = new Map<string, ((...args: unknown[]) => unknown)[]>()

function emitHooks(name: string, ...args: unknown[]): unknown[] {
  return (hooks.get(name) ?? []).map((fn) => {
    try {
      return fn(...args)
    } catch (e) {
      Logger.warn('dsh:hooks', `钩子 ${name} 执行失败: ${String(e)}`)
      return null
    }
  })
}

export function disposeRuntimeServices(): void {
  webServer.dispose()
  hooks.clear()
}

export function registerRuntimeServices(host: DshHost, deps: DshRuntimeDeps): void {
  const S = (name: string, category: 'ui' | 'ext' | 'misc' | 'core' | 'session' | 'registry', methods: Record<string, AnyFn>): void =>
    host.addService(name, category, methods as Record<string, (...args: never[]) => unknown>)

  const kv = deps.kv
  const emitNotice = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void =>
    deps.emit({ type: 'notice', sessionId: deps.activeSession()?.id ?? '', level, message })

  // ---------- B5：客户端 UI（🔗 event-bridge / ⚙️ native） ----------
  S('uiToasts', 'ui', { show: (message: string, level?: 'info' | 'warn' | 'error') => emitNotice(String(message), level) })
  S('uiNotifications', 'ui', { push: (title: string, body?: string) => emitNotice(`🔔 ${String(title)}${body ? ` — ${String(body)}` : ''}`) })
  S('notifications', 'misc', {
    push: (title: string, body?: string) => emitNotice(`🔔 ${String(title)}${body ? ` — ${String(body)}` : ''}`),
    list: () => []
  })
  S('uiStatus', 'ui', { set: (text: string) => emitNotice(`[状态] ${String(text)}`) })
  S('uiDialogs', 'ui', {
    confirm: async (message: string): Promise<boolean> => deps.requestConfirm(String(message)),
    alert: (message: string) => emitNotice(`⚠️ ${String(message)}`)
  })
  S('uiChat', 'ui', {
    append: (role: 'system' | 'assistant', text: string) => {
      const s = deps.activeSession()
      if (!s) throw new Error('无活动会话')
      deps.appendTurn(s.id, role, String(text))
      return true
    }
  })
  S('uiInput', 'ui', {
    set: (text: string) => {
      deps.emit({ type: 'ui-input', sessionId: deps.activeSession()?.id ?? '', text: String(text) })
      return true
    }
  })
  S('uiMessages', 'ui', {
    list: (): unknown[] =>
      (deps.activeSession()?.turns ?? []).map((t: ChatTurn) => ({ id: t.id, role: t.role, text: t.text.slice(0, 500), ts: t.ts }))
  })
  S('uiSession', 'ui', { get: () => deps.activeSession() })
  S('uiWorkspace', 'ui', { get: () => deps.activeProject() })
  S('fileUpload', 'ui', {
    read: (relPath: string): string => {
      const project = deps.activeProject()
      if (!project) throw new Error('未打开项目')
      return readFileSync(safePath(project.root, String(relPath)), 'utf-8').slice(0, 100_000)
    }
  })
  for (const name of ['uiPanels', 'uiToolbar', 'uiOverlays'] as const) {
    const items: { id: string; area: string; title: string; payload?: unknown }[] = []
    S(name, 'ui', {
      register: (item: { id: string; title: string; payload?: unknown }): boolean => {
        items.push({ id: String(item.id), area: name, title: String(item.title), payload: item.payload })
        emitNotice(`插件注册了 ${name} 面板：${String(item.title)}`)
        return true
      },
      list: (): unknown[] => items
    })
  }
  S('webServer', 'ui', {
    mount: (prefix: string, dir: string): number | null => webServer.mount(String(prefix), String(dir)),
    port: (): number | null => webServer.port()
  })

  // ---------- B6：扩展机制（⚙️ native） ----------
  S('pluginManager', 'ext', {
    list: () => deps.pluginManager.list(),
    uninstall: (id: string) => {
      deps.pluginManager.uninstall(String(id))
      return true
    },
    setEnabled: (id: string, enabled: boolean) => {
      deps.pluginManager.toggle(String(id), Boolean(enabled))
      return true
    }
  })
  S('pluginPackages', 'ext', {
    list: () => deps.pluginManager.list().map((p) => ({ id: p.id, dir: p.dir, version: p.version, enabled: p.enabled }))
  })
  S('hmr', 'ext', {
    reload: async (entryPath: string): Promise<boolean> => {
      await host.loadPluginEntry(String(entryPath))
      return true
    }
  })
  const hookMethods: Record<string, AnyFn> = {
    register: (name: string, fn: (...args: unknown[]) => unknown): boolean => {
      const list = hooks.get(String(name)) ?? []
      list.push(fn)
      hooks.set(String(name), list)
      return true
    },
    emit: (name: string, ...args: unknown[]): unknown[] => emitHooks(String(name), ...args),
    list: (): string[] => [...hooks.keys()]
  }
  S('hookRegistry', 'ext', hookMethods)
  S('extensionPoints', 'ext', hookMethods)
  S('ptcRuntime', 'ext', genericStore(kv, 'ptc'))
  S('typert', 'ext', genericStore(kv, 'typert'))
  S('typertGateway', 'ext', genericStore(kv, 'typertGateway'))
  S('lsp', 'ext', genericStore(kv, 'lsp'))

  // ---------- core / session 其余 ----------
  S('systemPrompt', 'core', {
    append: (text: string): boolean => {
      const key = deps.activeSession()?.id ?? 'global'
      kv.update((d) => ({
        ...d,
        __promptFragments: { ...(d.__promptFragments ?? {}), [key]: `${(d.__promptFragments ?? {})[key] ?? ''}\n${String(text)}`.trim() }
      }))
      return true
    },
    get: (): string => deps.promptFragments(),
    clear: (): boolean => {
      kv.update((d) => ({ ...d, __promptFragments: {} }))
      return true
    }
  })
  S('mcpResources', 'core', {
    list: () => deps.mcp.listResources(),
    read: async (server: string, uri: string) => deps.mcp.readResource(String(server), String(uri))
  })
  S('subprocess', 'core', { exec: (command: string) => deps.runShell(String(command)) })
  S('terminals', 'core', {
    list: (): unknown[] => {
      const s = deps.activeSession()
      return s ? [{ id: s.id, kind: 'embedded-page', provider: deps.activeProject()?.name ?? '' }] : []
    }
  })
  S('sandbox', 'core', genericStore(kv, 'sandboxPolicy'))
  S('sandboxPolicy', 'core', genericStore(kv, 'sandboxPolicy'))
  S('shellEnv', 'core', {
    get: (key: string) => process.env[String(key)] ?? null,
    keys: (): string[] => Object.keys(process.env).filter((k) => /^(PATH|HOME|USERPROFILE|LANG|TZ|NODE)/.test(k))
  })
  S('sessionProjections', 'session', {
    list: (): unknown[] =>
      (deps.activeSession()?.turns ?? []).map((t: ChatTurn) => ({ id: t.id, role: t.role, preview: t.text.slice(0, 120) }))
  })
  S('sessionProjectionCache', 'session', genericStore(kv, 'sessionProjectionCache'))
  S('sessionLogDownload', 'session', {
    recent: () => Logger.recent(200).map((l) => `[${new Date(l.ts).toISOString()}] [${l.level}] [${l.tag}] ${l.msg}`).join('\n')
  })
  S('sessionController', 'session', {
    current: () => deps.activeSession()?.id ?? null,
    emitHook: (name: string) => emitHooks(String(name))
  })
  S('sessionFileReferences', 'session', genericStore(kv, 'sessionFileReferences'))
  S('sessionReferenceResolver', 'session', genericStore(kv, 'sessionReferenceResolver'))
  S('sessionSkillCatalog', 'session', genericStore(kv, 'sessionSkillCatalog'))
  S('sessionTelemetry', 'session', genericStore(kv, 'sessionTelemetry'))
  S('sessionFeedback', 'session', {
    submit: (rating: unknown, comment?: string) => {
      kv.update((d) => ({
        ...d,
        sessionFeedback: { ...(d.sessionFeedback ?? {}), [`${Date.now()}`]: { rating, comment: comment ?? '' } }
      }))
      return true
    }
  })
  S('fileReferences', 'session', genericStore(kv, 'fileReferences'))
  S('spillStore', 'session', genericStore(kv, 'spillStore'))

  // ---------- registry 其余 ----------
  S('subagentModelSelection', 'registry', genericStore(kv, 'subagentModelSelection'))
  S('llm', 'registry', { providers: () => deps.llmProviders() })
  S('llmRouter', 'misc', genericStore(kv, 'llmRouter'))
  S('llmFallback', 'misc', genericStore(kv, 'llmFallback'))
  S('llmCache', 'misc', genericStore(kv, 'llmCache'))
  S('promptLibrary', 'misc', genericStore(kv, 'promptLibrary'))

  // ---------- 知识库底座 native（rag/search/index） ----------
  const kbSearchText = (query: string, limit: number): string => {
    const kb = deps.knowledge.list()[0]
    if (!kb) return '未挂载任何知识库'
    const hits = deps.knowledge.search(kb.id, String(query), Number(limit ?? 5))
    if (hits.length === 0) return '无匹配内容'
    return hits.map((h) => `[${h.path}] (${h.score})\n${h.snippet}`).join('\n\n')
  }
  S('rag', 'misc', {
    query: (query: string, limit?: number) => kbSearchText(String(query), Number(limit ?? 5)),
    list: () => deps.knowledge.list()
  })
  S('search', 'misc', {
    query: (query: string, limit?: number) => kbSearchText(String(query), Number(limit ?? 5)),
    list: () => deps.knowledge.list()
  })
  S('index', 'misc', {
    reindex: (id: string) => deps.knowledge.reindex(String(id)),
    stats: () => deps.knowledge.list().map((k) => ({ id: k.id, name: k.name, files: k.fileCount }))
  })

  // ---------- misc 其余（📦 泛用存储兜底） ----------
  const MISC = [
    'workflowEngine', 'webhookRuntime', 'otel', 'telemetry', 'metrics', 'tracing', 'logging', 'audit',
    'permissions', 'auth', 'users', 'teams', 'shares', 'comments', 'email', 'calendar', 'tasks', 'kanban',
    'wiki', 'docs', 'embeddings', 'vectors', 'templateEngine', 'render', 'export',
    'import', 'convert', 'diff', 'merge', 'patch', 'vcs', 'git', 'containers', 'docker', 'k8s', 'cloud',
    'browser', 'screenshot'
  ]
  for (const name of MISC) S(name, 'misc', genericStore(kv, name))

  S('logging', 'misc', {
    info: (msg: string) => Logger.info('dsh-plugin', String(msg)),
    warn: (msg: string) => Logger.warn('dsh-plugin', String(msg)),
    error: (msg: string) => Logger.error('dsh-plugin', String(msg)),
    recent: (n?: number) => Logger.recent(Number(n ?? 100))
  })
}
