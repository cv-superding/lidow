import type { AppSettings, ChatTurn, Session, StopLevel, ToolCall, ToolResult } from '@shared/types'
import { nanoid } from 'nanoid'
import type { ToolRegistry } from '@main/tools/registry'
import type { ToolContext } from '@main/tools/types'
import {
  formatObservations,
  looksLikeActionRequest,
  looksLikePlanOnlyReply,
  looksLikeToolCapabilityDenial,
  looksLikeWildToolIntent,
  parseToolCalls
} from './parser'
import { attemptRewrite, extractMemoryMarkers, interceptCheck } from '@main/security/refusal'
import { Logger } from '@main/infra/log'
import { backoffDelay, isContextExhausted } from './resilience'

/**
 * 循环实际使用的会话存储能力。
 * 注意：deps.store 是「按会话路由到所属项目」的门面，不是完整 SessionStore，
 * 没有 create/delete。新建会话必须走 createSession 依赖，否则运行期报
 * “store.create is not a function”（实测导致自动续接一直失败）。
 */
export interface LoopSessionStore {
  get(sessionId: string): Session | null
  appendTurn(sessionId: string, turn: ChatTurn): Session
  patchTurn(sessionId: string, turnId: string, patch: Partial<ChatTurn>): Session
  update(sessionId: string, fn: (s: Session) => Session): Session
}

export interface LoopDeps {
  store: LoopSessionStore
  tools: ToolRegistry
  /** 工具执行上下文基座：按「当前会话」取，切项目后不能串根目录 */
  toolCtxBase: (sessionId: string) => Omit<ToolContext, 'confirm'>
  /** 在指定项目里新建会话（自动续接用；routed 门面没有 create） */
  createSession: (projectId: string, providerId: string, parentSessionId: string, accountId?: string) => Session
  confirm: (sessionId: string, reason: string) => Promise<boolean>
  /** 把消息送进网页（overlay 注入发送），resolve 于发送成功 */
  sendToPage: (sessionId: string, text: string) => Promise<void>
  /** 等待网页上的 AI 回复完成，返回完整回复文本 */
  awaitReply: (sessionId: string, onChunk: (partial: string, tps: number) => void) => Promise<string>
  /** 中断网页侧生成 */
  interruptPage: (sessionId: string) => void
  /** 放弃当前等待（看门狗判死/超时后清理，避免下一轮报「已有等待中的回复请求」） */
  abandonReply?: (sessionId: string) => void
  /** 工具执行遮罩（网页内横幅 + 停止按钮，cuckoo tool-mask 同款） */
  toolMask?: (sessionId: string, show: boolean, text?: string) => void
  /** 任务完成系统通知（仅在窗口失焦时真正弹出，由实现方判断） */
  notifyDone?: (sessionId: string, snippet: string) => void
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
  /** 取走本轮模型思考过程（折叠展示用；无思考时为空串） */
  takeThinking: (sessionId: string) => string
  /** 把网页载体切到指定会话（自动续接用：新会话需要自己的 webview 绑定） */
  rebindToSession: (sessionId: string, fromSessionId?: string) => Promise<void>
}

const MAX_TURNS = 40 // 单次任务最大工具循环轮数，防失控
/** 格式纠偏最大次数（对齐 cuckoo 的 FORMAT_HINT_MAX，防 AI 在两种错误格式间来回切换） */
const MAX_WILD_HINTS = 10

/** 格式纠偏提示：AI 输出了不支持的调用格式时发回给它 */
const FORMAT_FIX_PROMPT =
  '你上一条回复使用了不支持的调用格式（XML / DSML / <invoke>）。\n' +
  '请严格改用 lidow 协议：只输出如下代码块，块外正常写字，不要在代码块里嵌别的代码块。\n\n' +
  '```lidow\n{"tool":"write","input":{"path":"相对路径","content":"文件内容"}}\n```\n\n' +
  '# 用户原始任务\n\n'

/** 压缩时发给 AI 的摘要指令（要求保留决策与未完成事项，而非泛泛概括） */
const COMPACT_INSTRUCTION =
  '请把下面这段对话压缩成一份**可交接**的摘要，供后续轮次继续工作使用。要求：\n' +
  '1. 保留：用户的目标与约束、已确认的结论、关键的代码/文件路径、已做出的决策及其理由\n' +
  '2. 明确列出：已完成的项、未完成的项、已知的风险或待确认的问题\n' +
  '3. 省略：寒暄、重复内容、失败后已废弃的尝试（只需一句说明放弃原因）\n' +
  '4. 用中文，结构化输出，直接给摘要本身，不要复述本指令\n\n' +
  '# 待压缩对话\n\n'

/** 工具调用的一句话摘要：折叠列表里只露关键信息（路径/命令/URL），不糊整段参数 */
function toolSummary(call: ToolCall): string {
  const pick = (k: string): string => {
    const v = call.input[k]
    return typeof v === 'string' ? v : ''
  }
  const oneLine = (s: string, max = 80): string => s.replace(/\s+/g, ' ').trim().slice(0, max)
  switch (call.name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'deleteFile':
      return oneLine(pick('path'))
    case 'bash':
    case 'pwsh':
      return oneLine(pick('command'))
    case 'glob':
    case 'grep':
      return oneLine(pick('pattern'))
    case 'webFetch':
      return oneLine(pick('url'))
    case 'webSearch':
      return oneLine(pick('query'))
    case 'mysql':
      return oneLine(pick('sql'))
    case 'mcpCall':
      return [pick('server'), pick('tool')].filter(Boolean).join('.')
    case 'runAgent':
      return oneLine(pick('task'), 60)
    case 'remember':
    case 'forgetMemory':
      return oneLine(pick('title') || pick('keyword'))
    case 'planSubmit':
      return oneLine(pick('goal'), 60)
    case 'readSkill':
      return oneLine(pick('name'))
    case 'kbSearch':
      return [pick('kb'), oneLine(pick('query'), 40)].filter(Boolean).join(' · ')
    default: {
      const first = Object.values(call.input).find((v) => typeof v === 'string')
      return typeof first === 'string' ? oneLine(first, 60) : ''
    }
  }
}

interface RunningLoop {
  sessionId: string
  stopped: Set<StopLevel>
  resolveStop?: () => void
  /** 当前工具批次的取消句柄：stop('tool') 用它中止正在执行的命令 */
  abort?: AbortController
}

/**
 * Agent 循环：send → collect → parse → (confirm) → execute → observe → repeat。
 * 三层停止：generate（打断当前网页生成）、tool（取消当前工具）、auto-loop（终止循环）。
 */
export class AgentLoop {
  private running = new Map<string, RunningLoop>()
  /** 正在压缩的会话：压缩也是一轮 AI 对话，看门狗必须挂起，否则会把摘要请求误判为卡死 */
  private compacting = new Set<string>()
  /** 压缩中的 promise：同一会话的压缩请求合并，避免两个 awaitReply 抢同一个网页 */
  private compactRuns = new Map<string, Promise<void>>()
  /** 已接管的网页侧回复指纹：DOM 与网络层双通道会重复上报同一条回复 */
  private adoptedRecently = new Map<string, number>()

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
    // 工具批次自带 AbortController：中止正在跑的 shell 命令并跳过剩余调用
    if (level === 'tool' || level === 'all') r.abort?.abort()
    if ((level === 'auto-loop' || level === 'all') && r.resolveStop) r.resolveStop()
  }

  /** 会话可能因自动续接而换 id：把 running 表中的键迁移到新会话 */
  private rekeyRunning(state: RunningLoop, from: string, to: string): void {
    if (from === to) return
    if (this.running.get(from) === state) this.running.delete(from)
    state.sessionId = to
    this.running.set(to, state)
  }

  /** 从 running 表移除（键可能已经迁移，按对象匹配而不是按最初 id） */
  private finishRunning(state: RunningLoop): void {
    for (const [sid, s] of this.running) {
      if (s === state) this.running.delete(sid)
    }
  }

  private async waitWhileCompacting(sessionId: string): Promise<void> {
    // 压缩通常几秒完成；极端情况下（摘要请求卡住）最多等 90 秒，
    // 之后仍继续启动，交给 collectReply 的等待队列兜底。
    if (this.compacting.has(sessionId)) {
      this.deps.emit({ type: 'notice', sessionId, level: 'info', message: '上下文压缩中，任务将在压缩完成后自动开始' })
    }
    for (let i = 0; i < 450 && this.compacting.has(sessionId); i++) {
      await this.sleep(200)
    }
  }

  async run(sessionId: string, userText: string): Promise<void> {
    if (this.running.has(sessionId)) {
      this.deps.emit({ type: 'notice', sessionId, level: 'warn', message: '当前会话已有任务在执行，已忽略' })
      return
    }
    // 自动压缩也是一轮网页对话：等它结束再发新一轮，否则两个 awaitReply
    // 抢同一个网页（表现为「已有等待中的回复请求」或把摘要当成任务回复）
    await this.waitWhileCompacting(sessionId)
    if (this.running.has(sessionId)) {
      this.deps.emit({ type: 'notice', sessionId, level: 'warn', message: '当前会话已有任务在执行，已忽略' })
      return
    }
    const state: RunningLoop = { sessionId, stopped: new Set() }
    this.running.set(sessionId, state)

    try {
      // 丢弃初始化提示/网页直发遗留的思考缓冲，避免挂到新任务的第一轮
      this.deps.takeThinking(sessionId)
      const store = this.deps.store
      // 首条消息前判断：默认每个网页对话只注入一次系统提示词（初始化/新会话首条）。
      // 旧会话没有这个标记时，有历史轮次就视为已注入过，避免升级后又重复一遍。
      const before = store.get(sessionId)
      const repeatPrompt = this.deps.settings().injectSystemPromptEveryTurn
      // 有历史轮次但 flag 为 false（旧版本/异常落盘）也按“已发过”处理，
      // 避免升级后给正在用的会话再插一整段系统提示词。
      const promptSentBefore = before
        ? before.systemPromptSent !== false || before.turns.length > 0
        : false
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

      // 默认只发一次：网页版会保留同一对话的历史，每轮重复注入既污染正文又占上下文。
      // 需要兼容平台清空上下文的情况时，可在设置里开启「每轮重复注入系统提示词」。
      let prompt = userText
      let injectedPrompt = false
      if (repeatPrompt || !promptSentBefore) {
        const sys = this.deps.systemPromptFor(sessionId)
        if (sys) {
          prompt = sys + '\n\n---\n\n# 用户任务\n\n' + userText
          injectedPrompt = true
        }
      }
      await this.toolLoop(sessionId, state, prompt)
      // 只有本轮真正跑完才记为已注入；发送失败/未连接时保留 false，
      // 下一条用户消息还能补上系统提示词。
      if (injectedPrompt) store.update(sessionId, (s) => ({ ...s, systemPromptSent: true }))
    } catch (err) {
      this.handleLoopError(state.sessionId, err)
    } finally {
      this.finishRunning(state)
      // 任务收尾才是自动压缩的正确时机：此刻没有在途的发送/等待，
      // 且上一任务留下的长转录正是需要摘要的对象
      this.maybeCompact(state.sessionId)
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
    // 压缩正在等摘要回复：不能再起一轮发送/等待，否则两边互相抢
    if (this.compacting.has(sessionId)) return
    if (!text.trim()) return
    // 去重：同一条回复会经两条路到达（DOM stream-end 兜底 + 网络层 net-response），
    // 重复接管会弹两遍提示、执行两遍工具。按「会话 + 文本指纹 + 时间窗」拦掉。
    const fingerprint = `${sessionId}:${text.length}:${text.slice(-80)}`
    const now = Date.now()
    const prev = this.adoptedRecently.get(fingerprint)
    if (prev && now - prev < 15_000) {
      Logger.info('loop', `忽略重复的网页侧回复（两条上报通道）session=${sessionId}`)
      return
    }
    this.adoptedRecently.set(fingerprint, now)
    // 简单清理，防长期运行无限增长
    if (this.adoptedRecently.size > 50) {
      for (const [k, ts] of this.adoptedRecently) {
        if (now - ts > 60_000) this.adoptedRecently.delete(k)
      }
    }
    const state: RunningLoop = { sessionId, stopped: new Set() }
    this.running.set(sessionId, state)
    try {
      // 网页直发的回复也可能带思考流：取走后随本轮落盘（无工具调用时自然丢弃）
      const think = this.deps.takeThinking(sessionId)
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
          // 默认不再整段重发系统提示词（网页对话里已有）；只有显式开启每轮注入时才带
          const sys = this.deps.settings().injectSystemPromptEveryTurn
            ? this.deps.systemPromptFor(sessionId)
            : ''
          const fixPrompt =
            (sys ? sys + '\n\n---\n\n' : '') + FORMAT_FIX_PROMPT + this.lastUserTextOf(sessionId)
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
        // 入库用清理后的文本：方言标签不进转录（与 toolLoop 口径一致）
        text: parsed.cleanText || text,
        ts: Date.now(),
        status: 'streaming',
        think: think || undefined
      }
      store.appendTurn(sessionId, turn)
      this.deps.emit({ type: 'session-updated', sessionId })
      const results: ToolResult[] = []
      const abort = new AbortController()
      state.abort = abort
      try {
        for (const call of parsed.calls) {
          if (state.stopped.has('tool')) {
            results.push({
              callId: call.id,
              name: call.name,
              ok: false,
              output: '',
              error: '用户中止了工具执行',
              durationMs: 0
            })
            break
          }
          const result = await this.executeCall(sessionId, call, abort.signal)
          results.push(result)
          store.patchTurn(sessionId, turn.id, { toolResults: results.slice() })
          this.deps.emit({ type: 'tool-start', sessionId, result })
        }
      } finally {
        state.abort = undefined
        state.stopped.delete('tool')
      }
      store.patchTurn(sessionId, turn.id, { toolResults: results, status: 'done' })
      this.deps.emit({ type: 'session-updated', sessionId })
      await this.toolLoop(
        sessionId,
        state,
        formatObservations(results.map((r) => ({ name: r.name, ok: r.ok, output: r.output, error: r.error })))
      )
    } catch (err) {
      this.handleLoopError(state.sessionId, err)
    } finally {
      this.finishRunning(state)
      this.maybeCompact(state.sessionId)
    }
  }

  /** 取会话里最近一条用户消息（纠偏时还原原始任务）；续接会话没有用户轮次时沿血缘回溯 */
  private lastUserTextOf(sessionId: string): string {
    let sid: string | undefined = sessionId
    for (let depth = 0; depth < 5 && sid; depth++) {
      const session = this.deps.store.get(sid)
      const turns = session?.turns ?? []
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]!.role === 'user') return turns[i]!.text
      }
      sid = session?.parentSessionId
    }
    return ''
  }

  private handleLoopError(sessionId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    Logger.warn('loop', `循环结束 session=${sessionId}: ${msg}`)
    this.deps.emit({ type: 'notice', sessionId, level: 'info', message: `任务结束：${msg}` })
    try {
      this.deps.store.appendTurn(sessionId, {
        id: `turn_${nanoid(8)}`,
        role: 'system',
        text: `[Lidow] ${msg}`,
        ts: Date.now(),
        status: 'stopped'
      })
      this.deps.emit({ type: 'session-updated', sessionId })
    } catch (e) {
      // 会话可能已被用户删除：错误轮次写不进去不能再抛（否则变成未处理 rejection）
      Logger.warn('loop', `无法记录错误轮次（会话可能已删除）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 工具循环主体（发送 → 收集 → 解析 → 执行 → 回传）。
   */
  private async toolLoop(sessionId: string, state: RunningLoop, initialPrompt: string): Promise<void> {
    const store = this.deps.store
    let prompt = initialPrompt
    let wildHintCount = 0
    let planNudgeCount = 0
    let capabilityNudgeCount = 0
    // 上下文耗尽会自动续接到新会话：此后所有落盘/发送/事件都以新 id 为准
    let activeSid = sessionId
    const collect = async (p: string): Promise<string> => {
      const r = await this.collectReply(activeSid, p)
      if (r.sessionId !== activeSid) {
        const prev = activeSid
        this.rekeyRunning(state, prev, r.sessionId)
        activeSid = r.sessionId
        Logger.info('loop', `任务已切换到续接会话 ${activeSid}（原 ${prev}）`)
      }
      return r.text
    }
    for (let round = 0; round < MAX_TURNS; round++) {
      if (state.stopped.has('auto-loop')) throw new Error('用户中止了自动循环')

      // 1. 发送并收集回复（含流式 chunk 上报 + 看门狗 + 拒绝改写）
      let reply = await collect(prompt)
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
            this.deps.emit({ type: 'notice', sessionId: activeSid, level: 'warn', message: '拒绝改写已达上限，按原回复继续' })
          }
          break
        }
        rewriteCount++
        Logger.info('loop', `检测到拒绝，改写重试 ${rewriteCount}/${mod.maxRewrites}`)
        reply = await collect(outcome.followUp)
      }

      // 1.5 自定义拦截：命中即终止本轮，不执行工具
      {
        const mod = this.deps.securityMod()
        const hit = interceptCheck(reply, mod.customPatterns)
        if (hit) {
          Logger.warn('loop', `回复命中拦截规则: ${hit}`)
          this.deps.emit({
            type: 'notice',
            sessionId: activeSid,
            level: 'warn',
            message: mod.customNotice || `回复命中拦截规则（${hit}），已阻止工具执行`
          })
        }
      }

      // 1.6 [记忆] 正文标记自动捕获
      for (const marker of extractMemoryMarkers(reply)) {
        this.deps.captureMemory(marker)
      }
      // 思考过程：取走本轮缓冲，随 assistant turn 落盘（UI 默认折叠，可展开查看）
      const think = this.deps.takeThinking(activeSid)
      const intercepted = interceptCheck(reply, this.deps.securityMod().customPatterns) !== null
      // 先解析一次，后续入库/渲染/执行共用结果。
      // 入库文本用 cleanText：工具块与平台原生方言都不该给用户看。
      const parsed = parseToolCalls(reply)
      const turn: ChatTurn = {
        id: `turn_${nanoid(8)}`,
        role: 'assistant',
        text: parsed.cleanText || reply,
        ts: Date.now(),
        // 有工具调用时先标记 streaming：UI 据此显示「正在执行中 · Ns」计时；
        // 工具批次结束后再改回 done。
        status: intercepted ? 'stopped' : parsed.calls.length > 0 ? 'streaming' : 'done',
        think: think || undefined
      }
      store.appendTurn(activeSid, turn)
      this.deps.emit({ type: 'session-updated', sessionId: activeSid })

      if (intercepted) break

      // 2. 工具调用
      if (parsed.calls.length === 0) {
        if (parsed.malformed.length > 0) {
          prompt = `你的工具调用块无法解析（JSON 错误），原始内容：\n${parsed.malformed.join('\n---\n')}\n请修正后重新输出工具调用块。`
          continue
        }
        // 有工具意图但格式完全没法本地还原 → 发一轮纠偏，
        // 否则用户看到的就是「AI 吐了一屏标签乱码，然后什么都没发生」
        if (looksLikeWildToolIntent(reply)) {
          if (wildHintCount++ >= MAX_WILD_HINTS) {
            Logger.warn('loop', `格式纠偏已达上限 ${MAX_WILD_HINTS} 次，放弃`)
            this.deps.emit({
              type: 'notice', sessionId: activeSid, level: 'warn',
              message: 'AI 多次使用了不支持的调用格式，已停止自动纠正，请换个说法重新提问'
            })
            break
          }
          Logger.info('loop', `回复含野生工具格式，发纠偏提示（${wildHintCount}/${MAX_WILD_HINTS}）`)
          this.deps.emit({
            type: 'notice', sessionId: activeSid, level: 'info',
            message: 'AI 用了不支持的调用格式，已自动纠正并重试'
          })
          prompt = FORMAT_FIX_PROMPT + this.lastUserTextOf(activeSid)
          continue
        }
        const userTask = this.lastUserTextOf(activeSid)
        // 模型误判自己没有工具、只给“安装指导”：先把真实工具清单重新塞给它。
        // DeepSeek 网页版会被平台自带的 search/open 等工具提示带偏，这一步是必要的。
        if (
          capabilityNudgeCount === 0 &&
          looksLikeActionRequest(userTask) &&
          looksLikeToolCapabilityDenial(reply)
        ) {
          capabilityNudgeCount++
          Logger.info('loop', `AI 否认工具能力，重发工具清单纠偏 session=${activeSid.slice(-6)}`)
          this.deps.emit({
            type: 'notice',
            sessionId: activeSid,
            level: 'info',
            message: 'AI 误以为没有本地工具，已重新注入工具清单并催促执行'
          })
          prompt =
            '你运行在 Lidow 中，拥有下列本地工具，不要声称“没有 bash/write/工具”，也不要只给安装指导。\n' +
            '请直接执行用户任务；需要工具时按 lidow 协议输出 JSON 工具块。安装 GitHub 技能可直接调用 installSkill。\n\n' +
            '## 可用工具（参数见系统提示）\n' +
            this.deps.tools.names().join('、') +
            '\ninstallSkill 参数：url（必填）、scope（project/user）、category（可选）\n\n# 用户任务\n\n' +
            userTask
          continue
        }
        // 只说了「我先看看/接下来我查一下」却没有工具调用：这是模型把计划当成了完成。
        // 执行型任务自动催一轮，否则用户看到 AI 说完计划就停在原地。
        if (
          planNudgeCount === 0 &&
          looksLikeActionRequest(userTask) &&
          looksLikePlanOnlyReply(reply)
        ) {
          planNudgeCount++
          Logger.info('loop', `AI 仅给出计划，自动催促执行 session=${activeSid.slice(-6)}`)
          this.deps.emit({
            type: 'notice',
            sessionId: activeSid,
            level: 'info',
            message: 'AI 只说明了计划，已自动催促继续执行'
          })
          prompt =
            '请直接执行你刚才说明的下一步，不要只说明计划；需要工具时按 lidow 协议输出工具调用块。\n' +
            '如果你认为缺少权限或工具，请先检查上面的系统提示与可用工具清单，不要直接下结论。\n\n' +
            '# 用户任务\n\n' +
            userTask
          continue
        }
        // 纯答复，任务完成：窗口失焦时系统通知（用户切走了也能知道干完了）
        this.deps.notifyDone?.(activeSid, parsed.cleanText.slice(0, 120))
        break
      }
      if (parsed.native) {
        // 平台原生方言也能本地还原并执行，省掉一轮往返
        Logger.info('loop', `识别到平台原生工具调用 ${parsed.calls.length} 个，直接执行`)
        wildHintCount = 0
      }

      // 3. 执行工具（带确认门 + 网页内执行遮罩 + 可中止）
      this.deps.toolMask?.(activeSid, true, `工具执行中（${parsed.calls.length} 个，第 ${round + 1} 轮）…`)
      const abort = new AbortController()
      state.abort = abort
      const results: ToolResult[] = []
      // 工具组在 UI 上实时增长：节流写盘（长批次/大输出时避免每次调用都重写会话）
      let lastPatchAt = 0
      try {
        for (const call of parsed.calls) {
          if (state.stopped.has('auto-loop')) break
          if (state.stopped.has('tool')) {
            // 「停止工具」：不再启动后续调用，把取消结果回传给 AI
            results.push({
              callId: call.id,
              name: call.name,
              ok: false,
              output: '',
              error: '用户中止了工具执行',
              durationMs: 0
            })
            break
          }
          const result = await this.executeCall(activeSid, call, abort.signal)
          results.push(result)
          const now = Date.now()
          if (now - lastPatchAt > 400 || results.length === parsed.calls.length) {
            lastPatchAt = now
            store.patchTurn(activeSid, turn.id, { toolResults: results.slice() })
          }
          this.deps.emit({ type: 'tool-start', sessionId: activeSid, result })
        }
      } finally {
        state.abort = undefined
        // 停止标志只作用于当前批次：下一轮 AI 正常调度工具不应继续被取消
        state.stopped.delete('tool')
        this.deps.toolMask?.(activeSid, false)
      }
      store.patchTurn(activeSid, turn.id, { toolResults: results, status: 'done' })
      // 让 UI 收到最终状态（执行中 → 已完成、文件变更统计刷新）
      this.deps.emit({ type: 'session-updated', sessionId: activeSid })

      if (state.stopped.has('auto-loop')) throw new Error('用户中止了自动循环')

      // 4. 观察结果回传
      prompt = formatObservations(
        results.map((r) => ({ name: r.name, ok: r.ok, output: r.output, error: r.error }))
      )
      // （自动压缩在任务收尾触发：循环进行中调用只会被 running 守卫推迟，
      //  而任务结束后没人再查 —— 之前放在这里等于永不触发）
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
  private async collectReply(sessionId: string, prompt: string): Promise<{ text: string; sessionId: string }> {
    const { watchdog: wdCfg, retry: retryCfg } = this.deps.settings()
    // 停止标志按「调用时的 running 键」检查：续接会把键迁到新会话，
    // 迁移由调用方（toolLoop）负责，这里用固定的 state 引用判断用户是否喊停
    const runState = this.running.get(sessionId)
    // 上下文耗尽续接会把整个批次挪到新会话，所以 sid 需要可变
    let sid = sessionId
    let cur = prompt
    // 「任务原文」：发送类失败（页面没就绪/输入框填不进）意味着这条消息从未落地，
    // 重试必须重发原文 —— 否则新会话的第一句话会是「刚才的回复似乎中断了…」这种无上下文的话
    let originalPrompt = prompt
    let attempt = 0
    let prompt429 = 0
    let continueCount = 0

    for (;;) {
      try {
        return { text: await this.awaitWithWatchdog(sid, cur, wdCfg), sessionId: sid }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 用户主动停止：不要重试
        if (runState?.stopped.has('generate')) throw err

        // 上下文耗尽：不是普通失败，重试也没用 —— 压缩后带摘要开新会话继续。
        // 压缩流程自身也可能收到耗尽信号：此时再续接会无限递归，直接上抛。
        if (isContextExhausted(msg) && !this.compacting.has(sid) && this.deps.settings().autoContinue.enabled) {
          if (continueCount++ >= 1) throw err // 只续接一次，避免死循环
          const prev = sid
          const next = await this.continueInNewSession(prev)
          if (!next) throw err
          // 新会话从「摘要 + 交接提示 + 原任务」开始，避免 AI 盲信残缺摘要
          const summary = this.lastSummaryOf(next)
          const handoff = this.deps.settings().autoContinue.handoffPrompt
          sid = next
          // 新会话是新的网页对话，必须带上系统提示词，否则续接后的首轮
          // 没有工具协议/工作目录，AI 会答“我没有文件访问权限”。
          const sys = this.deps.systemPromptFor(next)
          cur = [sys, summary, handoff, this.lastUserTextOf(prev)].filter(Boolean).join('\n\n---\n\n')
          if (sys) this.deps.store.update(next, (s) => ({ ...s, systemPromptSent: true }))
          // 交接提示成了这一轮的「任务原文」：后续发送类失败要重发的是它
          originalPrompt = cur
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
        // 发送类失败（页面没就绪/填不进输入框）意味着消息从未落地：重发任务原文，
        // 而不是把「刚才的回复似乎中断了…」发成一个新对话的第一句
        const isSendFailure = /输入框填入失败|发送超时|网页未连接|发送失败|webview 已关闭/.test(msg)
        cur = isSendFailure && cur === originalPrompt ? originalPrompt : retryCfg.prompt
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

    // 看门狗需要能主动判死本轮：自己造一个 reject 句柄，与等待回复的 promise 竞速。
    // 只置标志位不够 —— 等待方是个悬挂的 promise，不 reject 就永远返回不了。
    let failWatchdog: ((e: Error) => void) | null = null
    const watchdogPromise = new Promise<never>((_, reject) => {
      failWatchdog = reject
    })

    const armWatchdog = (): void => {
      if (!wd.enabled || wd.idleMs <= 0) return
      // 压缩期间挂起：摘要请求走的也是同一网页会话，静默期比普通回复长
      if (this.compacting.has(sessionId)) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        if (wd.maxRetries >= 0 && nudges >= wd.maxRetries) {
          Logger.warn('loop', `看门狗已达上限 ${wd.maxRetries} 次，判定任务中断`)
          // 催了这么多次仍然没动静 = 这一轮确实死了。必须抛错交给上层重试，
          // 否则等待方会一直挂到 REPLY_TIMEOUT_MS（10 分钟）才动，用户感觉就是"卡住不动了"
          this.deps.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            message: `AI 已 ${wd.maxRetries} 次无响应，转为自动重试`
          })
          this.deps.interruptPage(sessionId)
          failWatchdog?.(new Error(`AI 无响应（看门狗催继续 ${wd.maxRetries} 次仍未恢复）`))
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
      // 看门狗判死与正常回复竞速（看门狗只在静默超限时 reject，其余时候永远 pending）
      const reply = await Promise.race([chunkPromise, watchdogPromise])
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
      // 认输的那一方不消耗另一方：看门狗判死后，原等待仍在 overlay 里挂着，
      // 会在下一轮 collectReply 报「已有等待中的回复请求」。主动摘掉它。
      void chunkPromise.catch(() => undefined)
      this.deps.abandonReply?.(sessionId)
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
      await this.compactNow(sessionId, false, true)
      const session = this.deps.store.get(sessionId)
      if (!session) return null
      const summary = this.lastSummaryOf(sessionId)

      const next = this.deps.createSession(session.projectId, session.providerId, session.id, session.accountId)
      this.deps.store.update(next.id, (s) => ({ ...s, title: `${session.title}（续）`.slice(0, 40) }))
      // 摘要必须落进新会话：调用方用 lastSummaryOf(next) 组装续接 prompt，
      // 不落盘的话新会话的第一句话会丢掉全部压缩上下文。
      if (summary) {
        this.deps.store.appendTurn(next.id, {
          id: `turn_${nanoid(8)}`,
          role: 'system',
          text: summary,
          ts: Date.now(),
          status: 'done'
        })
      }
      this.deps.emit({ type: 'session-updated', sessionId: next.id })
      Logger.info('loop', `上下文耗尽 → 新会话 ${next.id}（父 ${sessionId}）`)

      // 切网页载体到新会话；之后由调用方把摘要作为 prompt 发送
      await this.deps.rebindToSession(next.id, session.id)
      // 渲染层需要把当前标签/活动会话迁到新会话，否则后续落盘都在新会话、
      // 用户眼前还停在旧会话，也看不到续接后的回复
      this.deps.emit({ type: 'session-switched', fromSessionId: sessionId, sessionId: next.id })
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

  private async executeCall(sessionId: string, call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now()
    const summary = toolSummary(call)
    const def = this.deps.tools.get(call.name)
    if (!def) {
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        output: '',
        summary,
        error: `未知工具: ${call.name}`,
        durationMs: 0
      }
    }
    const base = this.deps.toolCtxBase(sessionId)
    const ctx: ToolContext = {
      ...base,
      sessionId,
      signal,
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
        summary,
        error: out.error,
        durationMs: Date.now() - started
      }
    } catch (e) {
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        output: '',
        summary,
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
    if (this.compacting.has(sessionId)) return
    // 子代理会话可能在压缩期间被删除：失败只记录，不能变成未处理 rejection
    void this.compactNow(sessionId, true).catch((e) => {
      Logger.warn('loop', `自动压缩失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /**
   * 压缩上下文。
   *
   * 用 AI 生成真实摘要（而不是截断原文）：截断会丢掉「未完成的决定」和
   * 「为什么这么做」，后续轮次基于残缺上下文行动容易跑偏。
   * 摘要请求走同一网页会话，因此也受看门狗/重试保护。
   *
   * 同一会话同时只跑一个压缩；automatic 触发撞上已有压缩时直接返回，
   * 手动触发则等待同一个 promise。
   *
   * @param auto 由阈值触发的自动压缩（用于区分提示文案）
   * @param force 循环内部（上下文耗尽续接）调用：允许在任务运行中压缩
   */
  async compactNow(sessionId: string, auto = false, force = false): Promise<void> {
    // 任务执行中手动压缩会与循环的 awaitReply 抢同一网页，直接拒绝
    if (!force && this.running.has(sessionId)) {
      this.deps.emit({ type: 'notice', sessionId, level: 'warn', message: '任务执行中，暂时不能压缩上下文' })
      return
    }
    const inflight = this.compactRuns.get(sessionId)
    if (inflight) {
      if (auto) return
      await inflight
      return
    }
    this.compacting.add(sessionId)
    const run = this.doCompact(sessionId, auto).finally(() => {
      this.compacting.delete(sessionId)
      this.compactRuns.delete(sessionId)
    })
    this.compactRuns.set(sessionId, run)
    await run
  }

  private async doCompact(sessionId: string, auto: boolean): Promise<void> {
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
      summary = (await this.collectReply(sessionId, COMPACT_INSTRUCTION + '\n\n' + transcript)).text.trim()
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
