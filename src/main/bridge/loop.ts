import type { AppSettings, ChatTurn, StopLevel, ToolCall, ToolResult } from '@shared/types'
import { nanoid } from 'nanoid'
import type { SessionStore } from '@main/session/store'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext } from '@main/tools/types'
import { formatObservations, looksLikeWildToolIntent, parseToolCalls } from './parser'
import { attemptRewrite, extractMemoryMarkers, interceptCheck } from '@main/security/refusal'
import { Logger } from '@main/infra/log'
import { backoffDelay, isContextExhausted } from './resilience'

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
  settings: () => AppSettings
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
  /** 把网页载体切到指定会话（自动续接用：新会话需要自己的 webview 绑定） */
  rebindToSession: (sessionId: string) => Promise<void>
}

const MAX_TURNS = 40 // 单次任务最大工具循环轮数，防失控

/** 压缩时发给 AI 的摘要指令（要求保留决策与未完成事项，而非泛泛概括） */
const COMPACT_INSTRUCTION =
  '请把下面这段对话压缩成一份**可交接**的摘要，供后续轮次继续工作使用。要求：\n' +
  '1. 保留：用户的目标与约束、已确认的结论、关键的代码/文件路径、已做出的决策及其理由\n' +
  '2. 明确列出：已完成的项、未完成的项、已知的风险或待确认的问题\n' +
  '3. 省略：寒暄、重复内容、失败后已废弃的尝试（只需一句说明放弃原因）\n' +
  '4. 用中文，结构化输出，直接给摘要本身，不要复述本指令\n\n' +
  '# 待压缩对话\n\n'

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

  /**
   * 发送并收集一轮回复。
   *
   * 内置两个韧性机制（对齐 cuckoo）：
   *  - 看门狗：SSE 流静默超过 idleMs 说明卡住，发「请继续」催 AI 接着写，
   *    最多 maxRetries 次；收到任何新内容即重置计时。
   *  - 失败重试：send/await 抛错（含限流）时按退避重发，429 用更长的等待。
   */
  private async collectReply(sessionId: string, prompt: string): Promise<string> {
    const { watchdog: wdCfg, retry: retryCfg } = this.deps.settings()
    // 上下文耗尽续接会把整个批次挪到新会话，所以 sid 需要可变
    let sid = sessionId
    let cur = prompt
    let attempt = 0
    let prompt429 = 0
    let continueCount = 0

    for (;;) {
      try {
        return await this.awaitWithWatchdog(sid, cur, wdCfg)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 用户主动停止：不要重试
        if (this.running.get(sid)?.stopped.has('generate')) throw err

        // 上下文耗尽：不是普通失败，重试也没用 —— 压缩后带摘要开新会话继续
        if (isContextExhausted(msg) && this.deps.settings().autoContinue.enabled) {
          if (continueCount++ >= 1) throw err // 只续接一次，避免死循环
          const prev = sid
          const next = await this.continueInNewSession(prev)
          if (!next) throw err
          // 新会话从「摘要 + 交接提示 + 原任务」开始，避免 AI 盲信残缺摘要
          const summary = this.lastSummaryOf(next)
          const handoff = this.deps.settings().autoContinue.handoffPrompt
          sid = next
          cur = [summary, handoff, this.lastUserTextOf(prev)].filter(Boolean).join('\n\n---\n\n')
          continue
        }

        if (!retryCfg.enabled) throw err

        const is429 = /429|rate.?limit|too many requests|请求过于频繁|限流/i.test(msg)
        const max = is429 ? retryCfg.maxRetries429 : retryCfg.maxRetries
        const used = is429 ? ++prompt429 : ++attempt
        if (max >= 0 && used > max) {
          Logger.warn('loop', `重试达上限 ${max} 次，放弃：${msg}`)
          throw err
        }
        // 指数退避：delayMin * 2^(n-1)，封顶 delayMax；429 用专用长等待
        const raw = backoffDelay(used, retryCfg, is429)
        Logger.info('loop', `${is429 ? '429 限流' : '失败'}，第 ${used}/${max} 次重试，等待 ${Math.round(raw / 1000)}s：${msg}`)
        this.deps.emit({
          type: 'notice',
          sessionId: sid,
          level: 'warn',
          message: `${is429 ? '平台限流' : '回复失败'}，${Math.round(raw / 1000)} 秒后自动重试（${used}/${max}）`
        })
        await this.sleep(raw)
        cur = retryCfg.prompt
      }
    }
  }

  /** 单次发送 + 等待回复，含 SSE 静默看门狗 */
  private async awaitWithWatchdog(
    sessionId: string,
    prompt: string,
    wd: { enabled: boolean; idleMs: number; maxRetries: number; prompt: string }
  ): Promise<string> {
    let lastLen = 0
    let lastTs = Date.now()
    let idleTimer: NodeJS.Timeout | null = null
    let nudges = 0
    let settled = false

    // 流式上报节流：net hook 每 80ms 一条全量文本，长回复时 IPC 序列化
    // + renderer 全量重渲染会打满主线程（用户实测卡死）。合并到 250ms 一条。
    let pendingFlush: NodeJS.Timeout | null = null
    let latestPartial = ''
    let latestTps = 0
    const flushChunk = (): void => {
      pendingFlush = null
      this.deps.emit({ type: 'turn-chunk', sessionId, turnId: 'streaming', text: latestPartial, tps: latestTps })
    }

    const armWatchdog = (): void => {
      if (!wd.enabled || wd.idleMs <= 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        if (wd.maxRetries >= 0 && nudges >= wd.maxRetries) {
          Logger.warn('loop', `看门狗已达上限 ${wd.maxRetries} 次，不再催继续`)
          this.deps.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            message: `AI 已 ${wd.maxRetries} 次无响应，任务可能已中断`
          })
          return
        }
        nudges++
        Logger.info('loop', `看门狗：静默 ${wd.idleMs}ms，发「${wd.prompt}」催继续（第 ${nudges} 次）`)
        this.deps.emit({
          type: 'notice',
          sessionId,
          level: 'info',
          message: `AI 无响应，已自动发送「${wd.prompt}」（${nudges}/${wd.maxRetries}）`
        })
        // 催继续：把提示词打进同一个网页会话
        void this.deps.sendToPage(sessionId, wd.prompt).catch(() => undefined)
        armWatchdog()
      }, wd.idleMs)
    }

    const chunkPromise = this.deps.awaitReply(sessionId, (partial, tps) => {
      latestPartial = partial
      latestTps = tps
      if (!pendingFlush) pendingFlush = setTimeout(flushChunk, 250)
      lastLen = partial.length
      lastTs = Date.now()
      // 收到新内容 = 流还活着，重置静默计时并清零催继续计数
      nudges = 0
      armWatchdog()
    })

    void chunkPromise.catch(() => undefined)
    armWatchdog()
    try {
      await this.deps.sendToPage(sessionId, prompt)
      const reply = await chunkPromise
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (pendingFlush) {
        clearTimeout(pendingFlush)
        pendingFlush = null
      }
      void lastLen
      void lastTs
      if (reply.trim() === '') throw new Error('AI 回复为空（网页可能未就绪或被中断）')
      return reply
    } finally {
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      if (pendingFlush) clearTimeout(pendingFlush)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  /**
   * 上下文耗尽后自动续接：压缩当前会话 → 建子会话 → 返回新会话 id。
   * 新会话的「摘要 + 交接提示」由调用方作为本轮 prompt 发送（避免重复发送）。
   * 失败返回 null（调用方回退为普通报错）。
   *
   * 走血缘隔离的 createSession(parentSessionId)，新会话可追溯来源。
   */
  private async continueInNewSession(sessionId: string): Promise<string | null> {
    try {
      this.deps.emit({
        type: 'notice',
        sessionId,
        level: 'warn',
        message: '上下文已用完，正在压缩并自动开新会话继续…'
      })
      // 先把已有内容压缩成摘要（compactNow 内部失败会回退本地摘要，不会抛）
      await this.compactNow(sessionId, false)
      const session = this.deps.store.get(sessionId)
      if (!session) return null

      const next = this.deps.store.create(session.projectId, session.providerId, sessionId)
      this.deps.store.update(next.id, (s) => ({ ...s, title: `${session.title}（续）`.slice(0, 40) }))
      this.deps.emit({ type: 'session-updated', sessionId: next.id })
      Logger.info('loop', `上下文耗尽 → 新会话 ${next.id}（父 ${sessionId}）`)

      // 切网页载体到新会话；之后由调用方把摘要作为 prompt 发送
      await this.deps.rebindToSession(next.id)
      this.deps.emit({
        type: 'notice',
        sessionId: next.id,
        level: 'info',
        message: `已在新会话继续：${next.title}`
      })
      return next.id
    } catch (e) {
      Logger.warn('loop', `自动续接失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** 取会话里最近一次压缩摘要（续接时带过去） */
  private lastSummaryOf(sessionId: string): string {
    const turns = this.deps.store.get(sessionId)?.turns ?? []
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!
      if (t.role === 'system' && t.text.includes('上下文压缩')) return t.text
    }
    return ''
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

  /** 上下文自动压缩：超过阈值时把早期轮次交给 AI 生成真实摘要 */
  maybeCompact(sessionId: string): void {
    const { autoCompact, compactThreshold } = this.deps.settings()
    if (!autoCompact) return
    const session = this.deps.store.get(sessionId)
    if (!session) return
    const totalChars = session.turns.reduce((n, t) => n + t.text.length, 0)
    if (totalChars < compactThreshold) return
    // 压缩要发一轮 AI 请求，不能在工具循环中间抢跑（会打乱等待器）
    if (this.running.has(sessionId)) {
      Logger.info('loop', '压缩延后：会话正在执行任务')
      return
    }
    void this.compactNow(sessionId, true)
  }

  /**
   * 压缩上下文。
   *
   * 用 AI 生成真实摘要（而不是截断原文）：截断会丢掉「未完成的决定」和
   * 「为什么这么做」，后续轮次基于残缺上下文行动容易跑偏。
   * 摘要请求走同一网页会话，因此也受看门狗/重试保护。
   *
   * @param auto 由阈值触发的自动压缩（用于区分提示文案）
   */
  async compactNow(sessionId: string, auto = false): Promise<void> {
    const session = this.deps.store.get(sessionId)
    if (!session) return
    const keep = 8
    const oldTurns = session.turns.slice(0, -keep)
    if (oldTurns.length === 0) {
      this.deps.emit({ type: 'notice', sessionId, level: 'info', message: '轮次太少，无需压缩' })
      return
    }

    const transcript = oldTurns
      .map((t) => {
        const tag = t.role === 'user' ? '用户' : t.role === 'assistant' ? 'AI' : '系统'
        const tools = t.toolResults?.length
          ? `\n  [工具] ${t.toolResults.map((r) => `${r.name}${r.ok ? '✓' : '✗'}`).join(', ')}`
          : ''
        return `## ${tag}\n${t.text}${tools}`
      })
      .join('\n\n')
      // 摘要请求本身也要控成本：超长会话只取后 4 万字符（最早上下文价值最低）
      .slice(-40_000)

    this.deps.emit({
      type: 'notice',
      sessionId,
      level: 'info',
      message: auto ? '上下文接近上限，正在自动压缩…' : '正在压缩上下文…'
    })

    // 让 AI 写摘要；失败则回退本地摘要（保证压缩这件事一定完成，不卡住用户）
    let summary = ''
    try {
      summary = (await this.collectReply(sessionId, COMPACT_INSTRUCTION + '\n\n' + transcript)).trim()
    } catch (e) {
      Logger.warn('loop', `AI 摘要失败，回退本地摘要：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!summary) summary = this.buildFallbackSummary(oldTurns)

    this.deps.store.update(sessionId, (s) => ({
      ...s,
      compactedTurns: s.compactedTurns + oldTurns.length,
      turns: [
        {
          id: `turn_${nanoid(8)}`,
          role: 'system',
          text:
            `[Lidow 上下文压缩] 此前 ${oldTurns.length} 轮已压缩为下面的摘要。` +
            `摘要可能丢失细节，涉及结论时请读文件核实。

${summary}`,
          ts: Date.now(),
          status: 'done'
        },
        ...s.turns.slice(-keep)
      ]
    }))
    Logger.info('loop', `已压缩会话 ${sessionId}：折叠 ${oldTurns.length} 轮（摘要 ${summary.length} 字）`)
    this.deps.emit({
      type: 'notice',
      sessionId,
      level: 'info',
      message: `已压缩 ${oldTurns.length} 轮对话为摘要`
    })
    this.deps.emit({ type: 'session-updated', sessionId })
  }

  /** AI 摘要不可用时的兜底：保留每轮要点 + 工具痕迹 */
  private buildFallbackSummary(turns: ChatTurn[]): string {
    return turns
      .map((t) => {
        const tag = t.role === 'user' ? '用户' : t.role === 'assistant' ? 'AI' : '系统'
        const tools = t.toolResults?.map((r) => `${r.name}${r.ok ? '' : '(失败)'}`).join(',') ?? ''
        const flat = t.text.replace(/\n/g, ' ').slice(0, 300)
        return `- ${tag}: ${flat}${tools ? ` [工具: ${tools}]` : ''}`
      })
      .join('\n')
      .slice(0, 4000)
  }
}
