import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpManager } from '../src/main/mcp/manager'

const dir = mkdtempSync(join(tmpdir(), 'lidow-mcp-'))
const manager = new McpManager(dir)
const fixture = join(process.cwd(), 'test', 'fixtures', 'mcp-echo-server.mjs')

afterAll(() => {
  manager.disposeAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('McpManager stdio', () => {
  it('添加、连接、拉取工具/资源/提示并调用工具', async () => {
    manager.addServer({
      name: 'echo',
      command: process.execPath,
      args: [fixture],
      enabled: true
    })
    expect(manager.listServers().map((s) => s.name)).toContain('echo')

    await manager.connect('echo')
    expect(manager.listTools().map((t) => t.name)).toContain('echo')
    expect(manager.listResources().map((r) => r.uri)).toContain('echo://hello')
    expect(manager.listPrompts().map((p) => p.name)).toContain('greet')

    const out = await manager.callTool('echo', 'echo', { text: 'hello lidow' })
    expect(out).toBe('hello lidow')
    expect(await manager.readResource('echo', 'echo://hello')).toBe('hello resource')
  }, 30_000)

  it('移除服务后清理连接与配置', async () => {
    manager.removeServer('echo')
    await new Promise((r) => setTimeout(r, 100))
    expect(manager.listServers().map((s) => s.name)).not.toContain('echo')
    expect(manager.listTools().filter((t) => t.server === 'echo')).toHaveLength(0)
  })
})
