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

  it('旧内置 adapter 会合并新版选择器，账号保留', () => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-providers-adapter-'))
    try {
      const old = structuredClone(BUILT_IN_PROVIDERS.find((p) => p.id === 'chatgpt')!)
      delete old.adapter.profileName
      old.accounts = [
        { id: 'acc_keep', label: 'liding li', partition: 'persist:lidow-chatgpt-keep' }
      ]
      writeFileSync(join(d, 'providers.json'), JSON.stringify({ providers: [old] }))
      const reg = new ProviderRegistry(d)
      const p = reg.get('chatgpt')!
      expect(p.adapter.profileName?.length).toBeGreaterThan(0)
      expect(p.accounts[0]?.id).toBe('acc_keep')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('自动账号名可被网页更新，手动命名后不再覆盖', () => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-providers-name-'))
    try {
      const reg = new ProviderRegistry(d)
      const acc = reg.addAccount('chatgpt', '')
      expect(acc.labelAuto).toBe(true)
      reg.setAccountMeta('chatgpt', acc.id, { label: 'liding li' })
      expect(reg.get('chatgpt')?.accounts[0]?.label).toBe('liding li')
      // 模拟用户手动命名（labelAuto=false）
      reg.update('chatgpt', {
        accounts: reg.get('chatgpt')!.accounts.map((a) => ({ ...a, labelAuto: false }))
      })
      reg.setAccountMeta('chatgpt', acc.id, { label: '另一个名字' })
      expect(reg.get('chatgpt')?.accounts[0]?.label).toBe('liding li')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('可选默认账号并持久化，null 恢复隐式默认分区', () => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-providers-default-'))
    try {
      const reg = new ProviderRegistry(d)
      const acc = reg.addAccount('chatgpt', 'liding li')
      reg.setDefaultAccount('chatgpt', acc.id)
      expect(reg.get('chatgpt')?.defaultAccountId).toBe(acc.id)
      // 重新构造 registry（模拟重启）仍保留
      const reg2 = new ProviderRegistry(d)
      expect(reg2.get('chatgpt')?.defaultAccountId).toBe(acc.id)
      reg2.setDefaultAccount('chatgpt', null)
      expect(reg2.get('chatgpt')?.defaultAccountId).toBeUndefined()
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
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
