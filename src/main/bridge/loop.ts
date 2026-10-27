import type { ChatTurn, StopLevel, ToolCall, ToolResult } from '@shared/types'
import { nanoid } from 'nanoid'
import type { SessionStore } from '@main/session/store'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext } from '@main/tools/types'
import { formatObservations, parseToolCalls } from './parser'
import { attemptRewrite } from '@main/security/refusal'
import { Logger } from '@main/infra/log'

export interface LoopDeps {
  store: SessionStore
  tools: ToolRegistry
  toolCtxBase: () => Omit<ToolContext, 'confirm'>
  confirm: (sessionId: string, reason: string) => Promise<boolean>
  /** 把消息送进网页（overlay 注入发送），resolve 于发送成功 */
  sendToPage: (sessionId: string, text: string) => Promise<void>
  /** 等待网页上的 AI 回复完成，返回完整回复文本 */
  awaitReply: (sessionId: string, onChunk: (partial: string, tps: number) => void) => Promise<string>
  /** 中断网页侧生成 */
  interruptPage: (sessionId: string) => void
  /** 事件上报 renderer */
  emit: (event: { type: string; sessionId: string; [k: string]: unknown }) => void
  settings: () => { autoCompact: boolean; compactThreshold: number }
  /** 安全 MOD 配置（拒绝改写） */
  securityMod: () => { mode: 'off' | 'local' | 'api'; ctfInject: boolean; maxRewrites: number; rewriteApi?: string }
  /** 首轮注入的系统提示词 */
  systemPromptFor: (sessionId: string) => string
}

const MAX_TURNS = 40 // 单次任务最大工具循环轮数，防失控
const SSE_WATCHDOG_MS = 90 * 1000 // 超过 90s 无新内容判定卡死

interface RunningLoop {
  sessionId: string
  stopped: Set<StopLevel>
  resolveStop?: () => void
}

/**
 * Agent 循环：send → collect → parse → (confirm) → execute → observe → repeat。
 * 三层停止：generate（打断当前网页生成）、tool（取消当前工具）、auto-loop（终止循环）。
 */
export class AgentLoop {
  private running = new Map<string, RunningLoop>()

  constructor(private deps: LoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  runningSessionIds(): string[] {
    return [...this.running.keys()]
  }

  stop(sessionId: string, level: StopLevel): void {
    const r = this.running.get(sessionId)
    if (!r) return
    r.stopped.add(level)
    Logger.info('loop', `停止请求 session=${sessionId} level=${level}`)
    if (level === 'generate' || level === 'all') this.deps.interruptPage(sessionId)
    if ((level === 'auto-loop' || level === 'all') && r.resolveStop) r.resolveStop()
  }

  async run(sessionId: string, userText: string): Promise<void> {
    if (this.running.has(sessionId)) {
      this.deps.emit({ type: 'notice', sessionId, level: 'warn', message: '当前会话已有任务在执行，已忽略' })
      return
    }
    const state: RunningLoop = { sessionId, stopped: new Set() }
    this.running.set(sessionId, state)

    try {
      const store = this.deps.store
      const firstTurn: ChatTurn = {
        id: `turn_${nanoid(8)}`,
        role: 'user',
        text: userText,
        ts: Date.now(),
        status: 'done'
      }
      store.appendTurn(sessionId, firstTurn)
      // 自动命名：首个任务取前 24 字符作为会话标题
      if (store.get(sessionId)?.title === '新会话') {
        const autoTitle = userText.replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话'
        store.update(sessionId, (s) => ({ ...s, title: autoTitle }))
      }
      this.deps.emit({ type: 'session-updated', sessionId })

      let prompt = userText
      if (store.get(sessionId)?.turns.length === 1) {
        // 首轮：系统提示词与用户消息合并注入
        const sys = this.deps.systemPromptFor(sessionId)
        if (sys) prompt = `${sys}\n\n---\n\n# 用户任务\n\n${userText}`
      }
      for (let round = 0; round < MAX_TURNS; round++) {
        if (state.stopped.has('auto-loop')) throw new Error('用户中止了自动循环')

        // 1. 发送并收集回复（含流式 chunk 上报 + 看门狗 + 拒绝改写）
        let reply = await this.collectReply(sessionId, prompt)
        let rewriteCount = 0
        for (;;) {
          const mod = this.deps.securityMod()
          const outcome = await attemptRewrite(
            reply,
            { mode: mod.mode, ctfInject: mod.ctfInject, maxRewrites: mod.maxRewrites, rewriteApi: mod.rewriteApi },
            rewriteCount
          )
          if (!outcome.followUp) {
            if (outcome.exhausted) {
              this.deps.emit({ type: 'notice', sessionId, level: 'warn', message: '拒绝改写已达上限，按原回复继续' })
            }
            break
          }
          rewriteCount++
          Logger.info('loop', `检测到拒绝，改写重试 ${rewriteCount}/${mod.maxRewrites}`)
          reply = await this.collectReply(sessionId, outcome.followUp)
        }
        const turn: ChatTurn = { id: `turn_${nanoid(8)}`, role: 'assistant', text: reply, ts: Date.now(), status: 'done' }
        store.appendTurn(sessionId, turn)
        this.deps.emit({ type: 'session-updated', sessionId })

        // 2. 解析工具调用
        const parsed = parseToolCalls(reply)
        if (parsed.calls.length === 0) {
          if (parsed.malformed.length > 0) {
            prompt = `你的工具调用块无法解析（JSON 错误），原始内容：\n${parsed.malformed.join('\n---\n')}\n请修正后重新输出工具调用块。`
            continue
          }
          break // 纯答复，任务完成
        }

        // 3. 执行工具（带确认门）
        const results: ToolResult[] = []
        for (const call of parsed.calls) {
          if (state.stopped.has('auto-loop')) break
          const result = await this.executeCall(sessionId, call)
          results.push(result)
          this.deps.emit({ type: 'tool-start', sessionId, result })
        }
        store.patchTurn(sessionId, turn.id, { toolResults: results })

        if (state.stopped.has('auto-loop')) throw new Error('用户中止了自动循环')

        // 4. 观察结果回传
        prompt = formatObservations(
          results.map((r) => ({ name: r.name, ok: r.ok, output: r.output, error: r.error }))
        )
        // 5. 自动压缩检查
        this.maybeCompact(sessionId)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      Logger.warn('loop', `循环结束 session=${sessionId}: ${msg}`)
      this.deps.emit({ type: 'notice', sessionId, level: 'info', message: `任务结束：${msg}` })
      this.deps.store.appendTurn(sessionId, {
        id: `turn_${nanoid(8)}`,
        role: 'system',
        text: `[Lidow] ${msg}`,
        ts: Date.now(),
        status: 'stopped'
      })
      this.deps.emit({ type: 'session-updated', sessionId })
    } finally {
      this.running.delete(sessionId)
    }
  }

  private async collectReply(sessionId: string, prompt: string): Promise<string> {
    // 流式 chunk → renderer
    let lastLen = 0
    let lastTs = Date.now()
    let watchdog: NodeJS.Timeout | null = null

    const chunkPromise = this.deps.awaitReply(sessionId, (partial, tps) => {
      const now = Date.now()
      const turnText = partial
      this.deps.emit({ type: 'turn-chunk', sessionId, turnId: 'streaming', text: turnText, tps })
      lastLen = turnText.length
      lastTs = now
      // SSE 看门狗：每次 chunk 重置；超时由 awaitReply 内部配合处理
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        Logger.warn('loop', `看门狗触发：${SSE_WATCHDOG_MS}ms 无新内容`)
        this.stop(sessionId, 'generate')
      }, SSE_WATCHDOG_MS)
    })

    void chunkPromise.catch(() => undefined)
    await this.deps.sendToPage(sessionId, prompt)
    const reply = await chunkPromise
    if (watchdog) clearTimeout(watchdog)
    void lastLen
    void lastTs
    if (reply.trim() === '') throw new Error('AI 回复为空（网页可能未就绪或被中断）')
    return reply
  }

  private async executeCall(sessionId: string, call: ToolCall): Promise<ToolResult> {
    const started = Date.now()
    const def = this.deps.tools.get(call.name)
    if (!def) {
      return { callId: call.id, name: call.name, ok: false, output: '', error: `未知工具: ${call.name}`, durationMs: 0 }
    }
    const base = this.deps.toolCtxBase()
    const ctx: ToolContext = {
      ...base,
      confirm: (reason) => this.deps.confirm(sessionId, reason)
    }
    try {
      const out = await def.run(call.input, ctx)
      return {
        callId: call.id,
        name: call.name,
        ok: out.ok,
        output: out.output,
        display: out.display,
        error: out.error,
        durationMs: Date.now() - started
      }
    } catch (e) {
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        output: '',
        error: String(e instanceof Error ? e.message : e),
        durationMs: Date.now() - started
      }
    }
  }

  /** 上下文自动压缩：把早期轮次折叠为摘要（保留最近 8 轮原文） */
  maybeCompact(sessionId: string): void {
    const { autoCompact, compactThreshold } = this.deps.settings()
    if (!autoCompact) return
    const session = this.deps.store.get(sessionId)
    if (!session) return
    const totalChars = session.turns.reduce((n, t) => n + t.text.length, 0)
    if (totalChars < compactThreshold) return
    this.compactNow(sessionId)
  }

  /** 手动压缩入口 */
  compactNow(sessionId: string): void {
    const session = this.deps.store.get(sessionId)
    if (!session) return
    const keep = 8
    const oldTurns = session.turns.slice(0, -keep)
    if (oldTurns.length === 0) return
    const summary = this.buildSummary(oldTurns)
    this.deps.store.update(sessionId, (s) => ({
      ...s,
      compactedTurns: s.compactedTurns + oldTurns.length,
      turns: [
        {
          id: `turn_${nanoid(8)}`,
          role: 'system',
          text: `[Lidow 压缩] 此前 ${oldTurns.length} 轮对话已压缩为摘要：\n${summary}`,
          ts: Date.now(),
          status: 'done'
        },
        ...s.turns.slice(-keep)
      ]
    }))
    Logger.info('loop', `已压缩会话 ${sessionId}：折叠 ${oldTurns.length} 轮`)
  }

  private buildSummary(turns: ChatTurn[]): string {
    const lines: string[] = []
    for (const t of turns) {
      const tag = t.role === 'user' ? '用户' : t.role === 'assistant' ? 'AI' : '系统'
      const tools = t.toolResults?.map((r) => `${r.name}${r.ok ? '' : '(失败)'}`).join(',') ?? ''
      lines.push(`- ${tag}: ${t.text.replace(/\n/g, ' ').slice(0, 200)}${tools ? ` [工具: ${tools}]` : ''}`)
    }
    return lines.join('\n').slice(0, 4000)
  }
}
