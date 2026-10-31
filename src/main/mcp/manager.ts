import { type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import type { McpServerConfig, McpToolInfo } from '@shared/types'

/**
 * MCP 客户端管理器：Claude Desktop 配置格式兼容（command/args/env + url）。
 * stdio 服务用 SDK Client；http 服务走 SDK StreamableHTTP。
 * 资源/提示/工具三组件统一暴露。
 */

interface McpConnection {
  name: string
  process?: ChildProcess
  client: unknown // LazyLoaded Client
  tools: McpToolInfo[]
  resources: { name: string; uri: string; description?: string }[]
  prompts: { name: string; description?: string }[]
}

interface McpStoreData {
  servers: McpServerConfig[]
}

const SDK_TIMEOUT = 10_000

export class McpManager {
  private store: JsonStore<McpStoreData>
  private connections = new Map<string, McpConnection>()
  /** 同一服务的并发 connect 必须合并，否则会起两个子进程并把其中一个泄漏 */
  private connecting = new Map<string, Promise<void>>()

  constructor(userDataDir: string) {
    this.store = new JsonStore<McpStoreData>(join(userDataDir, 'mcp.json'), { servers: [] })
  }

  listServers(): McpServerConfig[] {
    return this.store.get().servers
  }

  addServer(cfg: McpServerConfig): McpServerConfig[] {
    this.store.update((d) => ({
      servers: [...d.servers.filter((s) => s.name !== cfg.name), cfg]
    }))
    return this.listServers()
  }

  async removeServer(name: string): Promise<McpServerConfig[]> {
    // 先删配置，再断开：连接中的任务完成后会发现配置已删除并自行关闭
    this.store.update((d) => ({ servers: d.servers.filter((s) => s.name !== name) }))
    await this.disconnect(name)
    return this.listServers()
  }

  /** 连接单个服务并拉取三组件清单 */
  async connect(name: string): Promise<void> {
    if (this.connections.has(name)) return
    const inflight = this.connecting.get(name)
    if (inflight) return inflight
    const run = this.doConnect(name)
    const cleanup = (): void => {
      if (this.connecting.get(name) === run) this.connecting.delete(name)
    }
    run.then(cleanup, cleanup)
    this.connecting.set(name, run)
    return run
  }

  private async doConnect(name: string): Promise<void> {
    const cfg = this.listServers().find((s) => s.name === name)
    if (!cfg) return
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const client = new Client({ name: 'lidow', version: '0.1.0' })

      if (cfg.url) {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url)))
      } else {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>
        })
        await client.connect(transport)
      }

      const conn: McpConnection = { name, client, tools: [], resources: [], prompts: [] }

      try {
        const tools = (await withTimeout(client.listTools(), SDK_TIMEOUT, `MCP ${name} 拉取工具超时`)) as { tools?: { name: string; description?: string }[] }
        conn.tools = (tools.tools ?? []).map((t) => ({ server: name, name: t.name, description: t.description ?? '' }))
      } catch {
        /* 服务可能不支持 tools */
      }
      try {
        const res = (await withTimeout(client.listResources(), SDK_TIMEOUT, `MCP ${name} 拉取资源超时`)) as { resources?: { name: string; uri: string; description?: string }[] }
        conn.resources = res.resources ?? []
      } catch {
        /* ignore */
      }
      try {
        const pr = (await withTimeout(client.listPrompts(), SDK_TIMEOUT, `MCP ${name} 拉取提示超时`)) as { prompts?: { name: string; description?: string }[] }
        conn.prompts = pr.prompts ?? []
      } catch {
        /* ignore */
      }

      // 连接期间服务被移除：不要留下孤儿连接
      if (!this.listServers().some((s) => s.name === name)) {
        await (client as { close?: () => Promise<void> }).close?.().catch(() => undefined)
        return
      }
      this.connections.set(name, conn)
      Logger.info('mcp', `已连接 ${name}：${conn.tools.length} 工具 / ${conn.resources.length} 资源 / ${conn.prompts.length} 提示`)
    } catch (e) {
      Logger.warn('mcp', `连接失败 ${name}: ${String(e)}`)
      throw e
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return
    try {
      await (conn.client as { close: () => Promise<void> }).close()
    } catch {
      /* ignore */
    }
    conn.process?.kill()
    this.connections.delete(name)
  }

  async connectAll(): Promise<void> {
    for (const s of this.listServers()) {
      if (s.enabled) {
        try {
          await this.connect(s.name)
        } catch {
          /* 单个失败不阻塞 */
        }
      }
    }
  }

  listTools(): McpToolInfo[] {
    return [...this.connections.values()].flatMap((c) => c.tools)
  }

  listResources(): { server: string; name: string; uri: string }[] {
    return [...this.connections.values()].flatMap((c) => c.resources.map((r) => ({ server: c.name, name: r.name, uri: r.uri })))
  }

  listPrompts(): { server: string; name: string; description?: string }[] {
    return [...this.connections.values()].flatMap((c) => c.prompts.map((p) => ({ server: c.name, name: p.name, description: p.description })))
  }

  /** 读取 MCP 资源内容（DSH mcpResources 服务落点） */
  async readResource(server: string, uri: string): Promise<string> {
    const conn = this.connections.get(server)
    if (!conn) throw new Error(`MCP 服务未连接: ${server}`)
    const client = conn.client as { readResource: (a: unknown) => Promise<unknown> }
    const res = (await withTimeout(client.readResource({ uri }), 30_000, 'MCP 读取资源超时')) as {
      contents?: { uri: string; mimeType?: string; text?: string; blob?: string }[]
    }
    return (res.contents ?? [])
      .map((c) => c.text ?? (c.blob ? `[binary ${c.mimeType ?? 'unknown'}]` : ''))
      .join('\n')
      .slice(0, 16_000)
  }

  /** mcpCall 工具落点 */
  async callTool(server: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(server)
    if (!conn) throw new Error(`MCP 服务未连接: ${server}`)
    const client = conn.client as { callTool: (a: unknown) => Promise<unknown> }
    const res = (await withTimeout(client.callTool({ name: toolName, arguments: args }), 60_000, 'MCP 工具调用超时')) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = (res.content ?? [])
      .map((c) => c.text ?? '')
      .join('\n')
      .slice(0, 8000)
    if (res.isError) throw new Error(text || 'MCP 工具返回错误')
    return text
  }

  disposeAll(): void {
    for (const name of [...this.connections.keys()]) void this.disconnect(name)
  }
}

/** 超时竞速并清理定时器：原实现的 setTimeout 成功后仍挂着（最长 60s） */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
