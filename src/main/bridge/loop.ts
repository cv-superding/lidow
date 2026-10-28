import type { ChatTurn, StopLevel, ToolCall, ToolResult } from '@shared/types'
import { nanoid } from 'nanoid'
import type { SessionStore } from '@main/session/store'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext } from '@main/tools/types'
import { formatObservations, looksLikeWildToolIntent, parseToolCalls } from './parser'
import { attemptRewrite, extractMemoryMarkers, interceptCheck } from '@main/security/refusal'
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
  /** 安全 MOD 配置（拒绝改写 + 自定义拦截） */
  securityMod: () => {
    mode: 'off' | 'local' | 'api'
    ctfInject: boolean
    maxRewrites: number
    rewriteApi?: string
    customPatterns: string[]
    customNotice: string
  }
  /** [记忆] 标记捕获落点 */
  captureMemory: (content: string) => void
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

      // 系统提示词必须每轮注入：网页版 AI 每次推理都是独立的，
      // 只在首轮注入会导致后续轮次不知道有工具可用（表现为「我没有文件系统访问权限」）
      let prompt = userText
      {
        const sys = this.deps.systemPromptFor(sessionId)
        if (sys) prompt = sys + '\n\n---\n\n# 用户任务\n\n' + userText
      }
      await this.toolLoop(sessionId, state, prompt)
    } catch (err) {
      this.handleLoopError(sessionId, err)
    } finally {
      this.running.delete(sessionId)
    }
  }

  /**
   * 接管「用户在网页输入框里自己发出去」的 AI 回复。
   * 这条路径没有经过 lidow 的发送，所以系统提示词没进上下文 —— 但回复里
   * 仍可能带工具块，必须执行，否则用户会看到 AI 说「我没有工作目录」。
   * 首轮文本直接用已收到的回复，不再重新发送。
   */
  async adoptExternalReply(sessionId: string, text: string): Promise<void> {
    if (this.running.has(sessionId)) return
    if (!text.trim()) return
    const state: RunningLoop = { sessionId, stopped: new Set() }
    this.running.set(sessionId, state)
    try {
      const parsed = parseToolCalls(text)
      if (parsed.calls.length === 0) {
        // 没有标准工具块。但如果是「有工具意图、格式野了」（XML/DSML/裸 JSON），
        // 补一轮带系统提示词的发送，把它拉回 lidow 协议 —— 否则用户会看到
        // AI 输出 <write>…</write> 却什么都没发生。
        if (looksLikeWildToolIntent(text)) {
          Logger.info('loop', `网页侧回复含野生工具格式，注入系统提示词纠偏 session=${sessionId}`)
          this.deps.emit({
            type: 'notice',
            sessionId,
            level: 'info',
            message: 'AI 用了不支持的调用格式，已自动纠正并重试'
          })
          const sys = this.deps.systemPromptFor(sessionId)
          const fixPrompt =
            (sys ? sys + '\n\n---\n\n' : '') +
            '# 格式纠正\n\n你上一条回复使用了不支持的工具调用格式。\n' +
            '请改用 lidow 协议：只输出如下代码块，不要用 XML / <write> / <invoke>。\n\n' +
            '```lidow\n{"tool":"write","input":{"path":"相对路径","content":"文件内容"}}\n```\n\n' +
            '# 用户原始任务\n\n' +
            this.lastUserTextOf(sessionId)
          await this.toolLoop(sessionId, state, fixPrompt)
          return
        }
        // 纯文本闲聊：它已经渲染在网页里了，不重复记录，只提示一句
        this.deps.emit({
          type: 'notice',
          sessionId,
          level: 'info',
          message: '你在网页里直接提问时，AI 不知道工作目录与工具。用下方输入框发送才能操作本地文件。'
        })
        return
      }
      Logger.info('loop', `接管网页侧回复 session=${sessionId} 工具块=${parsed.calls.length}`)
      const store = this.deps.store
      const turn: ChatTurn = {
        id: `turn_${nanoid(8)}`,
        role: 'assistant',
        text,
        ts: Date.now(),
        status: 'done'
      }
      store.appendTurn(sessionId, turn)
      this.deps.emit({ type: 'session-updated', sessionId })
      const results: ToolResult[] = []
      for (const call of parsed.calls) {
        const result = await this.executeCall(sessionId, call)
        results.push(result)
        this.deps.emit({ type: 'tool-start', sessionId, result })
      }
      store.patchTurn(sessionId, turn.id, { toolResults: results })
      await this.toolLoop(
        sessionId,
        state,
        formatObservations(results.map((r) => ({ name: r.name, ok: r.ok, output: r.output, error: r.error })))
      )
    } catch (err) {
      this.handleLoopError(sessionId, err)
    } finally {
      this.running.delete(sessionId)
    }
  }

  /** 取会话里最近一条用户消息（纠偏时还原原始任务） */
  private lastUserTextOf(sessionId: string): string {
    const turns = this.deps.store.get(sessionId)?.turns ?? []
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === 'user') return turns[i]!.text
    }
    return ''
  }

  private handleLoopError(sessionId: string, err: unknown): void {
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
  }

  /**
   * 工具循环主体（发送 → 收集 → 解析 → 执行 → 回传）。
   */
  private async toolLoop(sessionId: string, state: RunningLoop, initialPrompt: string): Promise<void> {
    const store = this.deps.store
    let prompt = initialPrompt
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

      // 1.5 自定义拦截：命中即终止本轮，不执行工具
      {
        const mod = this.deps.securityMod()
        const hit = interceptCheck(reply, mod.customPatterns)
        if (hit) {
          Logger.warn('loop', `回复命中拦截规则: ${hit}`)
          this.deps.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            message: mod.customNotice || `回复命中拦截规则（${hit}），已阻止工具执行`
          })
        }
      }

      // 1.6 [记忆] 正文标记自动捕获
      for (const marker of extractMemoryMarkers(reply)) {
        this.deps.captureMemory(marker)
      }
      const intercepted = interceptCheck(reply, this.deps.securityMod().customPatterns) !== null
      const turn: ChatTurn = {
        id: `turn_${nanoid(8)}`,
        role: 'assistant',
        text: reply,
        ts: Date.now(),
        status: intercepted ? 'stopped' : 'done'
      }
      store.appendTurn(sessionId, turn)
      this.deps.emit({ type: 'session-updated', sessionId })

      if (intercepted) break

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
  }

  private async collectReply(sessionId: string, prompt: string): Promise<string> {
    // 流式 chunk → renderer
    let lastLen = 0
    let lastTs = Date.now()
    let watchdog: NodeJS.Timeout | null = null

    // 流式上报节流：net hook 每 80ms 一条全量文本，长回复时 IPC 序列化
    // + renderer 全量重渲染会打满主线程（用户实测卡死）。合并到 250ms 一条。
    let pendingFlush: NodeJS.Timeout | null = null
    let latestPartial = ''
    let latestTps = 0
    const flushChunk = (): void => {
      pendingFlush = null
      this.deps.emit({ type: 'turn-chunk', sessionId, turnId: 'streaming', text: latestPartial, tps: latestTps })
    }
    const chunkPromise = this.deps.awaitReply(sessionId, (partial, tps) => {
      const now = Date.now()
      latestPartial = partial
      latestTps = tps
      if (!pendingFlush) pendingFlush = setTimeout(flushChunk, 250)
      lastLen = partial.length
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
    if (pendingFlush) {
      clearTimeout(pendingFlush)
      pendingFlush = null
    }
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
