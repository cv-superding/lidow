import { describe, expect, it } from 'vitest'
import { CHATGPT_HOOK } from '@main/providers/hooks'

const ctx = (): { fragmentTypes: string[]; currentIndex: number; observed: boolean } => ({ fragmentTypes: [], currentIndex: -1, observed: false })

describe('ChatGPT hook（旧 conversation 协议）', () => {
  it('完整消息快照返回 replace，不重复追加', () => {
    const frame = {
      message: {
        id: 'm1',
        author: { role: 'assistant' },
        content: { parts: ['hello'] },
        status: 'in_progress'
      }
    }
    expect(CHATGPT_HOOK.extract(frame)).toEqual({ text: 'hello', replace: true })
  })

  it('同 id 的后续快照只回传增量', () => {
    const c = ctx()
    const first = {
      message: {
        id: 'm1',
        author: { role: 'assistant' },
        content: { parts: ['hel'] },
        status: 'in_progress'
      }
    }
    const second = {
      message: {
        id: 'm1',
        author: { role: 'assistant' },
        content: { parts: ['hello'] },
        status: 'in_progress'
      }
    }
    expect(CHATGPT_HOOK.extract(first, c)).toEqual({ text: 'hel', replace: true })
    expect(CHATGPT_HOOK.extract(second, c)).toEqual({ text: 'lo' })
  })

  it('用户消息与 message_stream_complete', () => {
    expect(
      CHATGPT_HOOK.extract({
        message: { author: { role: 'user' }, content: { parts: ['hi'] } }
      })
    ).toBeNull()
    expect(CHATGPT_HOOK.extract({ type: 'message_stream_complete' })).toEqual({ finished: true })
  })
})

describe('ChatGPT hook（新版 Workspace delta 协议）', () => {
  it('v.message 快照 + append patch + status patch', () => {
    const c = ctx()
    expect(
      CHATGPT_HOOK.extract(
        {
          v: {
            message: {
              id: 'a1',
              author: { role: 'assistant' },
              content: { parts: ['1\n2\n'] },
              status: 'in_progress'
            }
          }
        },
        c
      )
    ).toEqual({ text: '1\n2\n', replace: true })

    expect(
      CHATGPT_HOOK.extract(
        {
          o: 'patch',
          v: [{ p: '/message/content/parts/0', o: 'append', v: '3\n4\n' }]
        },
        c
      )
    ).toEqual({ text: '3\n4\n' })

    expect(
      CHATGPT_HOOK.extract(
        {
          o: 'patch',
          v: [
            { p: '/message/content/parts/0', o: 'append', v: '5\n' },
            { p: '/message/status', o: 'replace', v: 'finished_successfully' }
          ]
        },
        c
      )
    ).toEqual({ text: '5\n', finished: true })
  })

  it('新 message id 整体替换（不把上一轮拼进来）', () => {
    const c = ctx()
    CHATGPT_HOOK.extract(
      {
        v: {
          message: {
            id: 'a1',
            author: { role: 'assistant' },
            content: { parts: ['old'] },
            status: 'in_progress'
          }
        }
      },
      c
    )
    expect(
      CHATGPT_HOOK.extract(
        {
          v: {
            message: {
              id: 'a2',
              author: { role: 'assistant' },
              content: { parts: ['测试'] },
              status: 'in_progress'
            }
          }
        },
        c
      )
    ).toEqual({ text: '测试', replace: true })
  })

  it('顶层单条 patch 也支持', () => {
    const c = ctx()
    expect(
      CHATGPT_HOOK.extract(
        { p: '/message/content/parts/0', o: 'append', v: 'x' },
        c
      )
    ).toEqual({ text: 'x' })
  })

  it('忽略用户消息与 input_message', () => {
    const c = ctx()
    expect(
      CHATGPT_HOOK.extract(
        { v: { message: { id: 'u1', author: { role: 'user' }, content: { parts: ['hi'] } } } },
        c
      )
    ).toBeNull()
    expect(CHATGPT_HOOK.extract({ type: 'input_message', v: {} }, c)).toBeNull()
  })
})
