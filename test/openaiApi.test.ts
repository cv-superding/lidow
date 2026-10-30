import { describe, expect, it } from 'vitest'
import { assistantSnapshot, extractPrompt } from '@main/web/openaiApi'
import type { ChatTurn, Session } from '@shared/types'

function turn(role: ChatTurn['role'], text: string, status: ChatTurn['status'] = 'done'): ChatTurn {
  return { id: `t_${role}_${text.length}`, role, text, ts: 0, status }
}

function session(turns: ChatTurn[]): Session {
  return {
    id: 'sess_api',
    projectId: 'proj_api',
    title: 'API',
    providerId: 'deepseek',
    createdAt: 0,
    updatedAt: 0,
    compactedTurns: 0,
    turns
  }
}

describe('OpenAI 兼容层', () => {
  it('只取最后一条 user 消息', () => {
    expect(
      extractPrompt([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '第二问' }
      ])
    ).toBe('第二问')
  })

  it('支持 OpenAI 的 text part 数组', () => {
    expect(
      extractPrompt([
        { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'image_url', image_url: {} }] }
      ])
    ).toBe('你好')
  })

  it('没有 user 文本时返回空串', () => {
    expect(extractPrompt([{ role: 'system', content: 'sys' }])).toBe('')
    expect(extractPrompt(undefined)).toBe('')
  })

  it('assistantSnapshot 只拼接基线之后的非空 assistant 轮次', () => {
    const s = session([
      turn('user', '旧问题'),
      turn('assistant', '旧回答'),
      turn('user', '新问题'),
      turn('assistant', '  '),
      turn('assistant', '新回答'),
      turn('system', '错误')
    ])
    expect(assistantSnapshot(s, 1)).toBe('新回答')
    expect(assistantSnapshot(s, 0)).toBe('旧回答\n\n新回答')
  })
})
