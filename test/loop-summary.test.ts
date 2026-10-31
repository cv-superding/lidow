import { describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '@main/bridge/loop'
import type { AppSettings, ChatTurn, Session } from '@shared/types'
import type { ToolRegistry } from '@main/tools/registry'

const TOOL_REPLY = '继续处理。\n\n```lidow\n{"tool":"read","input":{"path":"a.txt"}}\n```'

function makeSettings(): AppSettings {
  return {
    theme: 'graphite',
    accent: '#4f6bed',
    desktopPet: false,
    language: 'zh-CN',
    pureMode: false,
    dangerConfirm: false,
    deleteProtection: true,
    batchDeleteThreshold: 200,
    webSendIntervalMs: 0,
    apiServer: { enabled: false, host: '127.0.0.1', port: 6080, token: '' },
    permissionMode: 'full',
    ssrfProtection: true,
    commandTimeoutMs: 30_000,
    sandboxTimeoutMs: 60_000,
    outputBufferLimit: 1024 * 1024,
    compactThreshold: 600_000,
    autoCompact: false,
    injectSystemPromptEveryTurn: false,
    watchdog: { enabled: false, idleMs: 90_000, maxRetries: 3, prompt: '请继续' },
    retry: {
      enabled: false,
      delayMinMs: 1,
      delayMaxMs: 1,
      maxRetries: 1,
      delay429Ms: 1,
      maxRetries429: 1,
      prompt: '重试'
    },
    autoContinue: { enabled: false, handoffPrompt: '' },
    globalHotkeys: {},
    securityMod: { enabled: false, ctfInject: false, refusalRewrite: 'off', maxRewrites: 0 },
    sync: {}
  }
}

function makeHarness(opts: { hang?: boolean; intervalMs?: number; replies?: string[] } = {}): {
  loop: AgentLoop
  session: () => Session
  addTurn: (turn: ChatTurn) => void
  prompts: string[]
  notifyDone: ReturnType<typeof vi.fn>
  runs: string[]
  stopState: () => { aborted: boolean; suppressed: boolean }
  events: { type: string; sessionId: string; running?: boolean }[]
} {
  let session: Session = {
    id: 'sess_1',
    projectId: 'proj_1',
    title: '长任务',
    providerId: 'deepseek',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    compactedTurns: 0,
    systemPromptSent: true,
    turns: []
  }
  const prompts: string[] = []
  const notifyDone = vi.fn()
  const runs: string[] = []
  const stopState = { aborted: false, suppressed: false }
  const events: { type: string; sessionId: string; running?: boolean }[] = []
  let rejectReply: ((e: Error) => void) | null = null
  const settings = { ...makeSettings(), webSendIntervalMs: opts.intervalMs ?? 0 }
  const tools = {
    get: (name: string) =>
      name === 'read'
        ? {
            name: 'read',
            description: '',
            parameters: {},
            dangerLevel: 'safe' as const,
            run: async () => {
              runs.push(name)
              return { ok: true, output: 'ok' }
            }
          }
        : undefined,
    names: () => ['read']
  } as unknown as ToolRegistry
  const store = {
    get: () => session,
    appendTurn: (_sid: string, turn: ChatTurn) => {
      session = { ...session, turns: [...session.turns, turn], updatedAt: Date.now() }
      return session
    },
    patchTurn: (_sid: string, turnId: string, patch: Partial<ChatTurn>) => {
      session = {
        ...session,
        turns: session.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t))
      }
      return session
    },
    update: (_sid: string, fn: (s: Session) => Session) => {
      session = fn(session)
      return session
    }
  }
  const loop = new AgentLoop({
    store,
    tools,
    toolCtxBase: () =>
      ({
        projectRoot: 'C:/tmp/project',
        settings: {
          commandTimeoutMs: 30_000,
          sandboxTimeoutMs: 60_000,
          outputBufferLimit: 1024 * 1024,
          ssrfProtection: true,
          dangerConfirm: false,
          deleteProtection: true,
          batchDeleteThreshold: 200,
          permissionMode: 'full'
        }
      }) as never,
    createSession: () => {
      throw new Error('not used')
    },
    confirm: async () => true,
    sendToPage: async (_sid, text) => {
      prompts.push(text)
    },
    awaitReply: async () => {
      // awaitReply 在 sendToPage 之前注册：让出一个微任务再读取本轮提示
      await Promise.resolve()
      if (opts.hang) {
        return new Promise<string>((_resolve, reject) => {
          rejectReply = reject
        })
      }
      const planned = opts.replies?.[prompts.length - 1]
      if (planned !== undefined) return planned
      const last = prompts[prompts.length - 1] ?? ''
      if (last.includes('收尾摘要') || last.includes('自动循环上限')) {
        return '## 已完成\n- 完成了测试任务\n\n## 未解决\n- 无\n\n## 说明\n- 测试'
      }
      return TOOL_REPLY
    },
    interruptPage: () => undefined,
    abortReply: () => {
      stopState.aborted = true
      rejectReply?.(new Error('用户中止了生成'))
    },
    suppressPage: () => {
      stopState.suppressed = true
    },
    abandonReply: () => undefined,
    toolMask: () => undefined,
    notifyDone,
    emit: (event: { type: string; sessionId: string; running?: boolean }) => events.push(event),
    settings: () => settings,
    securityMod: () => ({
      mode: 'off',
      ctfInject: false,
      maxRewrites: 0,
      customPatterns: [],
      customNotice: ''
    }),
    captureMemory: () => undefined,
    systemPromptFor: () => '',
    takeThinking: () => '',
    rebindToSession: async () => undefined
  })
  const addTurn = (turn: ChatTurn): void => {
    session = { ...session, turns: [...session.turns, turn], updatedAt: Date.now() }
  }
  return {
    loop,
    session: () => session,
    addTurn,
    prompts,
    notifyDone,
    runs,
    stopState: () => stopState,
    events
  }
}

describe('重启后的最终回答恢复', () => {
  it('页面快照补齐最终回答，并替换只落了思考片段的轮次', () => {
    const { loop, session, addTurn } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '郑州的', ts: Date.now(), status: 'done' })
    addTurn({
      id: 'a1',
      role: 'assistant',
      text: '用户问郑州的天气，我需要搜索',
      ts: Date.now(),
      status: 'done',
      think: '用户问郑州的天气，我需要搜索郑州今天的天气并获取未来几天的预报'
    })
    const answer = '郑州今天晴，25/9℃。\n\n## 提示\n明天有雨，记得带伞。'
    loop.syncExternalReply('sess_1', answer)
    expect(session().turns).toHaveLength(2)
    expect(session().turns[1]!.text).toBe(answer)
    expect(session().turns[1]!.think).toContain('未来几天的预报')

    // 同一快照重复到达不重复落盘
    loop.syncExternalReply('sess_1', answer)
    expect(session().turns).toHaveLength(2)
  })

  it('网页侧直接发的最终回答也替换思考片段，而不是再插一条', async () => {
    const { loop, session, addTurn } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '郑州的', ts: Date.now(), status: 'done' })
    addTurn({
      id: 'a1',
      role: 'assistant',
      text: '用户问郑州的天气',
      ts: Date.now(),
      status: 'done',
      think: '用户问郑州的天气，需要搜索后回答'
    })
    await loop.adoptExternalReply('sess_1', '郑州今天晴，25/9℃。')
    expect(session().turns).toHaveLength(2)
    expect(session().turns[1]!.text).toBe('郑州今天晴，25/9℃。')
  })

  it('快照是用户消息时不会误记成 AI 回答', () => {
    const { loop, session, addTurn } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '郑州的', ts: Date.now(), status: 'done' })
    loop.syncExternalReply('sess_1', '郑州的')
    expect(session().turns).toHaveLength(1)
  })

  it('停止生成会立即中止等待并压制网页后续事件', async () => {
    const { loop, session, stopState, events } = makeHarness({ hang: true })
    const runPromise = loop.run('sess_1', '长任务')
    await new Promise((r) => setTimeout(r, 30))
    expect(loop.isRunning('sess_1')).toBe(true)
    loop.stop('sess_1', 'generate')
    await runPromise
    expect(stopState().aborted).toBe(true)
    expect(stopState().suppressed).toBe(true)
    expect(loop.isRunning('sess_1')).toBe(false)
    const last = session().turns[session().turns.length - 1]
    expect(last?.role).toBe('system')
    expect(last?.text).toContain('中止')
    // UI 的“停止生成”依赖 loop-state：开始时 true，停止/收尾时 false
    expect(events.some((e) => e.type === 'loop-state' && e.running === true)).toBe(true)
    expect(events.filter((e) => e.type === 'loop-state').at(-1)?.running).toBe(false)
  })

  it('循环已落盘的带工具回复被网页侧重复上报时不会二次执行工具', async () => {
    const { loop, session, addTurn, runs } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '写个贪吃蛇', ts: Date.now(), status: 'done' })
    addTurn({
      id: 'a1',
      role: 'assistant',
      text: '继续处理。',
      ts: Date.now(),
      status: 'done',
      toolResults: [{ callId: 'c1', name: 'read', ok: true, output: 'ok', durationMs: 1 }]
    })
    // 循环的最终摘要已经追加在后面：只看最后一条会漏掉这次重复上报
    addTurn({ id: 'a2', role: 'assistant', text: '已完成摘要', ts: Date.now() + 1, status: 'done' })
    await loop.adoptExternalReply('sess_1', TOOL_REPLY)
    expect(session().turns).toHaveLength(3)
    expect(runs).toHaveLength(0)
  })

  it('工具结果发送前会实际等待网页发送间隔', async () => {
    const { loop, prompts } = makeHarness({ intervalMs: 300, replies: ['已完成'] })
    const started = Date.now()
    await loop.adoptExternalReply('sess_1', TOOL_REPLY)
    const elapsed = Date.now() - started
    expect(prompts).toHaveLength(1) // 只发送了工具观察结果
    expect(elapsed).toBeGreaterThanOrEqual(250)
  })

  it('网页快照带思考/搜索前缀且去掉了引用角标时，不重复追加整段回答', () => {
    const { loop, session, addTurn } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '今天济南的天气咋样', ts: Date.now(), status: 'done' })
    const answer =
      '济南今天（10月30日，周五）：晴，11~23℃，北风3~4级，空气质量良。\n\n' +
      '- 天气：晴到晴间多云，白天回暖尚可，夜间降温快[reference:0]\n' +
      '- 气温：市区最低约 12℃，最高 22~23℃[reference:4]\n' +
      '- 风力：南风转北风 3~4 级，阵风稍大[reference:5]'
    addTurn({ id: 'a1', role: 'assistant', text: answer, ts: Date.now(), status: 'done' })
    const snapshot =
      '已思考（用时 10 秒）搜索到 12 个网页' + answer.replace(/\[reference:\d+\]/g, '')
    loop.syncExternalReply('sess_1', snapshot)
    expect(session().turns).toHaveLength(2)
    expect(session().turns[1]!.text).toBe(answer)
  })

  it('页面快照带来更完整的思考块时更新 think，不新增轮次', () => {
    const { loop, session, addTurn } = makeHarness()
    addTurn({ id: 'u1', role: 'user', text: '今天济南的天气咋样', ts: Date.now(), status: 'done' })
    const answer = '济南今天晴，11~23℃。'
    addTurn({
      id: 'a1',
      role: 'assistant',
      text: answer,
      ts: Date.now(),
      status: 'done',
      think: '用户问天气'
    })
    loop.syncExternalReply(
      'sess_1',
      answer,
      '已思考（用时 10 秒）用户问济南天气。搜索到 12 个网页。信息足够，总结天气。'
    )
    expect(session().turns).toHaveLength(2)
    expect(session().turns[1]!.think).toContain('信息足够')
  })
})

describe('长任务轮数上限', () => {
  it('到上限后请求收尾摘要并落盘，而不是静默停止', async () => {
    const { loop, session, prompts, notifyDone } = makeHarness()
    await loop.run('sess_1', '执行一个很长的任务')

    expect(prompts[0]).toBe('执行一个很长的任务')
    // 第 201 次发送是收尾请求
    expect(prompts.length).toBe(201)
    expect(prompts[200]).toContain('收尾摘要')

    const turns = session().turns
    const last = turns[turns.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.text).toContain('## 已完成')
    expect(last?.text).toContain('## 未解决')
    expect(notifyDone).toHaveBeenCalled()
  })
})
