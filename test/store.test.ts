import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '@main/infra/store'

describe('JsonStore', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-store-'))
    dirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('默认值合并与持久化', () => {
    const dir = tmp()
    const file = join(dir, 's.json')
    const store = new JsonStore<{ a: number; b: string }>(file, { a: 1, b: 'x' })
    expect(store.get()).toEqual({ a: 1, b: 'x' })
    store.set({ a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ a: 2, b: 'x' })
  })

  it('损坏文件自动备份并回退默认值', () => {
    const dir = tmp()
    const file = join(dir, 's.json')
    writeFileSync(file, '{broken json', 'utf-8')
    const store = new JsonStore<{ a: number }>(file, { a: 7 })
    expect(store.get()).toEqual({ a: 7 })
    const leftovers = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    expect(leftovers.length).toBe(1)
  })

  it('update 函数式更新', () => {
    const dir = tmp()
    const store = new JsonStore<{ n: number }>(join(dir, 'u.json'), { n: 0 })
    store.update((p) => ({ n: p.n + 3 }))
    expect(store.get().n).toBe(3)
  })
})
