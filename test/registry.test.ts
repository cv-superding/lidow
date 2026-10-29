import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILT_IN_PROVIDERS, ProviderRegistry } from '../src/main/providers/registry'

const dir = mkdtempSync(join(tmpdir(), 'lidow-providers-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('ProviderRegistry built-ins migration', () => {
  it('旧项目 providers.json 自动补齐 Gemini，且保留已有账号', () => {
    mkdirSync(dir, { recursive: true })
    const deepseek = structuredClone(BUILT_IN_PROVIDERS.find((p) => p.id === 'deepseek')!)
    deepseek.accounts = [{ id: 'acc_demo', label: '旧账号', partition: 'persist:lidow-deepseek-demo' }]
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [deepseek] }))

    const reg = new ProviderRegistry(dir)
    const ids = reg.list().map((p) => p.id)
    expect(ids).toContain('gemini')
    expect(reg.get('deepseek')?.accounts[0]?.id).toBe('acc_demo')
    // 再读不应重复追加
    expect(reg.list().filter((p) => p.id === 'gemini')).toHaveLength(1)
  })

  it('未指定账号时保持默认分区，新增/移除账号不会劫持老会话', () => {
    const reg = new ProviderRegistry(dir)
    reg.switchAccount('deepseek', 'acc_demo')
    const added = reg.addAccount('deepseek', '')
    expect(reg.partitionOf('deepseek')).toBe('persist:lidow-deepseek-default')
    expect(reg.partitionOf('deepseek', '__default__')).toBe('persist:lidow-deepseek-default')
    expect(reg.partitionOf('deepseek', added.id)).toBe(added.partition)
    expect(reg.partitionOf('deepseek')).not.toBe(added.partition)
    reg.removeAccount('deepseek', added.id)
    expect(reg.get('deepseek')?.accounts.map((a) => a.id)).not.toContain(added.id)
  })
})
