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

function makeHarness(): {
  loop: AgentLoop
  session: () => Session
  prompts: string[]
  notifyDone: ReturnType<typeof vi.fn>
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
  const settings = makeSettings()
  const tools = {
    get: (name: string) =>
      name === 'read'
        ? {
            name: 'read',
            description: '',
            parameters: {},
            dangerLevel: 'safe' as const,
            run: async () => ({ ok: true, output: 'ok' })
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
      const last = prompts[prompts.length - 1] ?? ''
      if (last.includes('收尾摘要') || last.includes('自动循环上限')) {
        return '## 已完成\n- 完成了测试任务\n\n## 未解决\n- 无\n\n## 说明\n- 测试'
      }
      return TOOL_REPLY
    },
    interruptPage: () => undefined,
    abandonReply: () => undefined,
    toolMask: () => undefined,
    notifyDone,
    emit: () => undefined,
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
  return { loop, session: () => session, prompts, notifyDone }
}

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
