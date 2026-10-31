import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '@main/session/store'

describe('SessionStore', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-session-'))
    dirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('手动重命名会锁定标题并同步到索引', () => {
    const dir = tmp()
    const store = new SessionStore(dir)
    const created = store.create('proj_x', 'deepseek')
    store.rename(created.id, '修复登录问题')

    expect(store.get(created.id)?.title).toBe('修复登录问题')
    expect(store.get(created.id)?.titleLocked).toBe(true)
    expect(store.meta(created.id)?.titleLocked).toBe(true)

    store.update(created.id, (s) => ({ ...s, systemPromptSent: true }))
    expect(store.meta(created.id)?.systemPromptSent).toBe(true)

    const reloaded = new SessionStore(dir)
    expect(reloaded.meta(created.id)?.title).toBe('修复登录问题')
    expect(reloaded.meta(created.id)?.titleLocked).toBe(true)
    expect(reloaded.meta(created.id)?.systemPromptSent).toBe(true)
  })

  it('update 会把 accountId 等字段同步进索引', () => {
    const dir = tmp()
    const store = new SessionStore(dir)
    const created = store.create('proj_x', 'deepseek', undefined, 'acc_a')
    store.update(created.id, (s) => ({ ...s, accountId: '__default__' }))
    expect(store.meta(created.id)?.accountId).toBe('__default__')
    const reloaded = new SessionStore(dir)
    expect(reloaded.meta(created.id)?.accountId).toBe('__default__')
  })

  it('index.json 损坏时从会话文件重建，不丢历史会话', () => {
    const dir = tmp()
    const store = new SessionStore(dir)
    const created = store.create('proj_x', 'deepseek')
    store.appendTurn(created.id, { id: 'turn_1', role: 'user', text: 'hi', ts: Date.now(), status: 'done' })
    writeFileSync(join(dir, 'sessions', 'index.json'), '{ broken', 'utf-8')

    const reloaded = new SessionStore(dir)
    expect(reloaded.list().map((m) => m.id)).toContain(created.id)
    expect(reloaded.get(created.id)?.turns).toHaveLength(1)
    expect(reloaded.meta(created.id)?.providerId).toBe('deepseek')
  })
})
