import { describe, expect, it } from 'vitest'
import { filterSessionList } from '../src/renderer/src/sessionFilter'
import type { SessionMeta } from '@shared/types'

function meta(id: string, providerId: string, accountId: string | undefined, title: string): SessionMeta {
  return {
    id,
    projectId: 'p1',
    title,
    providerId,
    accountId,
    createdAt: 1,
    updatedAt: 1,
    compactedTurns: 0
  }
}

const all = [
  meta('d1', 'deepseek', undefined, '郑州天气'),
  meta('d2', 'deepseek', 'acc-a', 'DeepSeek 小号会话'),
  meta('c1', 'chatgpt', undefined, 'ChatGPT 任务'),
  meta('k1', 'kimi', undefined, 'Kimi 会话')
]

describe('纯净模式平台/账号隔离', () => {
  it('DeepSeek 默认分区只显示 DeepSeek 默认账号', () => {
    const got = filterSessionList(all, {
      query: '',
      providerId: 'deepseek',
      currentProvider: 'deepseek',
      currentAccount: undefined
    })
    expect(got.map((s) => s.id)).toEqual(['d1'])
  })

  it('DeepSeek 命名账号只显示该账号', () => {
    const got = filterSessionList(all, {
      query: '',
      providerId: 'deepseek',
      currentProvider: 'deepseek',
      currentAccount: 'acc-a'
    })
    expect(got.map((s) => s.id)).toEqual(['d2'])
  })

  it('切到其他平台时只显示该平台，不再混入当前平台', () => {
    const got = filterSessionList(all, {
      query: '',
      providerId: 'chatgpt',
      currentProvider: 'deepseek',
      currentAccount: undefined
    })
    expect(got.map((s) => s.id)).toEqual(['c1'])
  })

  it('搜索词仍在平台隔离之后生效', () => {
    const got = filterSessionList(all, {
      query: '天气',
      providerId: 'deepseek',
      currentProvider: 'deepseek',
      currentAccount: undefined
    })
    expect(got.map((s) => s.id)).toEqual(['d1'])
    const none = filterSessionList(all, {
      query: '天气',
      providerId: 'chatgpt',
      currentProvider: 'deepseek'
    })
    expect(none).toHaveLength(0)
  })
})
