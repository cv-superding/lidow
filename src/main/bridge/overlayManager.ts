import { ipcMain, webContents, type WebContents } from 'electron'
import type { ModelPickerInfo, OverlayCommand, OverlayEvent } from '@shared/types'
import { Logger } from '@main/infra/log'
import { quietWindow, remainingSendDelay } from '@main/bridge/sendTiming'

const SEND_TIMEOUT_MS = 20_000
const REPLY_TIMEOUT_MS = 10 * 60_000
/**
 * 网络层报「截断/空回复」后不要立刻重试：DeepSeek 可能只是这一段 SSE
 * 结束，页面仍在生成（甚至马上会接上下一段）。等 DOM 真正停下来再决定，
 * 否则用户会看到网页还在回答，Lidow 就自动插了一条「回复中断」的消息。
 */
const ERROR_GRACE_MS = 20_000

/** 去空白/标点后比较：网络层纯文本与 DOM markdown 的差异不应被当成两条回复 */
function sameReply(a: string | undefined, b: string): boolean {
  if (!a) return false
  const norm = (s: string): string =>
    s
      .replace(/\s+/g, '')
      .replace(/[*_`#>~|:：\-—，。；、,.;!?！？"'“”‘’（）()【】<>《》]/g, '')
  const nb = norm(b)
  return Boolean(nb) && norm(a) === nb
}

interface Channel {
  webContentsId: number
  streamBuf: string
  chunkResolvers: Set<(partial: string, tps: number) => void>
  /** 回复结束：正常给文本，失败给 Error（上层据此决定是否重试） */
  replyResolvers: Set<(text: string | Error) => void>
  sendResolvers: Set<(ok: boolean, err?: string) => void>
  /** 网络层上报的错误原因（供 loop 判断是否重试） */
  netError?: string
  /** 软错误（截断/空回复）的宽限计时：页面可能仍在生成，先等 DOM 收尾 */
  errorGraceTimer?: NodeJS.Timeout
  pendingError?: { reason: string; text: string }
  /** 本次停止是 Lidow 主动发的（看门狗/用户点停止），不是网页侧自己停的 */
  lidowStopped?: boolean
  /** 思考过程缓冲（来自 SSE reasoning 帧） */
  thinkBuf?: string
  /** 网络层收到的权威完整文本（DOM 兜底前先等它） */
  netText?: string
  /** DOM stream-end 兜底 resolve 定时器 */
  domFallbackTimer?: NodeJS.Timeout
  /** did-finish-load 重注入监听是否已绑定 */
  hookBound?: boolean
  /** 上一轮的服务端累计 token（accumulated_token_usage 是会话累计值，本轮消耗 = 差值） */
  lastAcc?: number
  /** 最近一次交给等待方的回复文本：迟到的同一段 net-response 不能再接管 */
  lastResolvedText?: string
  /** 最近一次网页流活动（网络层/ DOM）：发送前据此等页面真正静下来 */
  lastActivityAt?: number
}

/**
 * Overlay 管理器：webview(overlay preload) ↔ main 的桥。
 * 会话通过 bindSession(sessionId, webContentsId) 绑定；
 * 悬浮球动作经 onFloatAction 回调上抛（三层停止的第三层）。
 */
export class OverlayManager {
  private channels = new Map<number, Channel>()
  private bindings = new Map<string, number>()
  /** 同一网页的发送串行化：避免连续消息把平台频率打满 */
  private sendChains = new Map<number, Promise<void>>()
  private lastSendAt = new Map<number, number>()
  private sendIntervalProvider: () => number = () => 1000
  /** openChatInPage 的应答（overlay 回传 open-chat-result） */
  private openChatResolvers = new Set<(ok: boolean) => void>()
  private onFloatAction?: (sessionId: string, action: string) => void
  /** 思考过程增量回调（供 renderer 折叠块显示） */
  private onThinkChunk?: (sessionId: string, think: string) => void
  /** 网页侧「AI 回复完成」常驻回调：用户直接在网页输入框发消息时也能接管（cuckoo observer 同款） */
  private onPageReply?: (sessionId: string, text: string) => void
  /** 网页侧自行发起任务时的实时流文本（没有 loop 等待方时推给纯净模式） */
  onPageStream?: (sessionId: string, text: string, tps: number) => void
  /** 用户在网页输入框里亲手发送的消息（同步回纯净模式的用户轮次） */
  private onPageUserMessage?: (sessionId: string, text: string) => void
  /** 页面重挂载后的最后一条 AI 回答（补齐重启/重载期间缺失的最终答复） */
  private onPageSnapshot?: (sessionId: string, text: string, think?: string) => void
  /** webview 就绪（或重新导航）时回调，用于重发 configure */
  onReady?: (sessionId: string) => void
  /**
   * 网页登录成功回调（按 webContentsId）。
   * 用于在「登录完成」这个时机把项目状态推给网页 —— 首次引导必须等登录后才出现。
   */
  onLogin?: (webContentsId: number) => void
  /** 登录态变化（用于把“已登录/未登录”同步到平台账号列表） */
  onLoginState?: (webContentsId: number, loggedIn: boolean) => void
  /** 网页侧账号显示名（用于自动命名账号） */
  onProfileName?: (webContentsId: number, name: string) => void
  /** 服务端权威 token 消耗（每轮差值）——供主进程累计持久化 */
  onTokenUsage?: (sessionId: string, deltaTokens: number) => void
  /** 网页内「初始化项目」点击（按 webContentsId，不依赖会话绑定） */
  onInitProject?: (webContentsId: number) => void
  /** 网页内「使用此目录，开始」：确认目录后自动发一轮初始化提示词 */
  onConfirmProject?: (webContentsId: number) => void
  /** 网页内「延续上个对话」：压缩旧会话并把摘要发进新对话 */
  onContinueProject?: (webContentsId: number) => void
  /** 网页内请求把当前/指定 URL 交给系统浏览器（Google 登录被阻止时使用） */
  onOpenExternal?: (webContentsId: number, url?: string) => void
  /** 页面导航（会话已绑定时）——建立会话 ↔ 平台对话 URL 映射 */
  onNav?: (sessionId: string, url: string, title?: string) => void
  /** 网页侧用户删除了对话（按 webContentsId 上报 URL） */
  onChatDeleted?: (webContentsId: number, url: string) => void
  /** 网页侧点击了属于某个 Lidow 项目的对话 */
  onActivateChat?: (webContentsId: number, url: string, reload?: boolean) => void
  /** 用户点平台自己的「新对话」：解绑原会话并恢复初始化引导 */
  onNativeNewChat?: (webContentsId: number) => void
  /** overlay 就绪（无论是否已绑定会话）：用于下发网页会话删除监听列表 */
  onAnyReady?: (webContentsId: number) => void

  /** 网页开关状态（思考 / 搜索）上报 + 页面上是否存在对应按钮 */
  onToggleState?: (
    think: boolean,
    search: boolean,
    thinkAvailable?: boolean,
    searchAvailable?: boolean
  ) => void

  /** 会话当前绑定的 webContents id（未绑定为 undefined） */
  wcIdOfSession(sessionId: string): number | undefined {
    return this.bindings.get(sessionId)
  }

  /** 当前所有已绑定的会话 id（切项目时统一解绑用） */
  boundSessionIds(): string[] {
    return [...this.bindings.keys()]
  }

  setToggleStateHandler(
    fn: (
      think: boolean,
      search: boolean,
      thinkAvailable?: boolean,
      searchAvailable?: boolean
    ) => void
  ): void {
    this.onToggleState = fn
  }

  setTokenUsageHandler(fn: (sessionId: string, deltaTokens: number) => void): void {
    this.onTokenUsage = fn
  }

  /** 向所有已连接的 webview 广播命令（项目切换后同步 set-project 用） */
  /**
   * 向所有网页广播命令。
   *
   * 不能只遍历 this.channels —— 它仅在 overlay 上报过事件后才存在；
   * 首次引导阶段（还没绑会话、页面刚加载）可能一个 channel 都没有，
   * 命令就发不出去，表现为「选完目录弹窗内容不变」。
   * 因此直接遍历所有 webview 类型的 webContents。
   */
  broadcastCmd(cmd: OverlayCommand): void {
    const seen = new Set<number>()
    for (const ch of this.channels.values()) seen.add(ch.webContentsId)
    for (const [, wcId] of this.bindings) seen.add(wcId)
    // 兜底：已登记过的 hook webview（含未绑会话的）
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'webview') seen.add(wc.id)
    }
    for (const id of seen) {
      const target = webContents.fromId(id)
      if (target && !target.isDestroyed()) target.send('lidow:overlay-cmd', cmd)
    }
  }

  /**
   * 插件网页脚本：登记到会话名下并在「页面加载完成」时注入。
   *
   * 为什么不能直接 executeJs：configure 到达时页面常还在加载，
   * 脚本会打在 about:blank 上静默丢失；且页面刷新后主世界脚本全部清空。
   * 这里与 hook 同一套时机：等 isLoading 翻false 立即注入 + did-finish-load 重放。
   */
  private webScriptsBySession = new Map<string, string[]>()
  private webScriptWc = new Set<number>()

  setWebScripts(sessionId: string, codes: string[]): void {
    if (codes.length === 0) this.webScriptsBySession.delete(sessionId)
    else this.webScriptsBySession.set(sessionId, codes)
  }

  async injectWebScripts(sessionId: string): Promise<void> {
    const codes = this.webScriptsBySession.get(sessionId)
    if (!codes || codes.length === 0) return
    let wcId = this.bindings.get(sessionId)
    for (let i = 0; i < 50 && !wcId; i++) {
      await new Promise((r) => setTimeout(r, 200))
      wcId = this.bindings.get(sessionId)
    }
    const target = wcId ? webContents.fromId(wcId) : undefined
    if (!target || target.isDestroyed()) return
    if (!this.webScriptWc.has(wcId!)) {
      this.webScriptWc.add(wcId!)
      target.on('did-finish-load', () => {
        // 会话会换绑：重放时按“当前绑到这个 wcId 的会话”取脚本，
        // 闭包里的 sessionId 是注册时的旧值，重放会注入别人的脚本
        const currentSid = [...this.bindings.entries()].find(([, w]) => w === wcId)?.[0]
        const list = currentSid ? this.webScriptsBySession.get(currentSid) : undefined
        if (!list) return
        for (const code of list) void target.executeJavaScript(code, true).catch(() => undefined)
      })
    }
    for (let i = 0; i < 50; i++) {
      if (target.isDestroyed()) return
      if (!target.isLoading()) {
        for (const code of codes) {
          try {
            await target.executeJavaScript(code, true)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg.includes('disposed')) return
          }
        }
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  constructor() {
    ipcMain.on('lidow:overlay', (event, payload: OverlayEvent) => {
      this.handleOverlayEvent(event.sender, payload)
    })
  }

  setFloatActionHandler(fn: (sessionId: string, action: string) => void): void {
    this.onFloatAction = fn
  }

  /** 用户在设置里调整网页发送间隔后立即生效 */
  setSendIntervalProvider(fn: () => number): void {
    this.sendIntervalProvider = fn
  }

  private channelFor(sender: WebContents): Channel {
    let ch = this.channels.get(sender.id)
    if (!ch) {
      ch = {
        webContentsId: sender.id,
        streamBuf: '',
        chunkResolvers: new Set(),
        replyResolvers: new Set(),
        sendResolvers: new Set(),
        netError: undefined
      }
      this.channels.set(sender.id, ch)
    }
    return ch
  }

  private handleOverlayEvent(sender: WebContents, payload: OverlayEvent): void {
    const ch = this.channelFor(sender)
    switch (payload.type) {
      case 'stream-start':
        ch.streamBuf = ''
        ch.lastActivityAt = Date.now()
        ch.lidowStopped = false
        // 新一轮开始：上一轮的网络层权威文本不能留到这一轮兜底
        ch.netText = undefined
        ch.netError = undefined
        this.clearErrorGrace(ch)
        break
      case 'stream-chunk': {
        ch.streamBuf = payload.text
        ch.lastActivityAt = Date.now()
        // 有内容说明页面还在生成：把软错误的宽限往后顺延
        this.rearmErrorGrace(ch)
        const tps = this.estimateTps(payload.text.length, ch)
        for (const r of ch.chunkResolvers) r(payload.text, tps)
        // 没有 loop 等待方 = 用户在网页里自己发的任务：这里直接把流推给
        // 纯净模式，否则要等整段回复结束才一次性出现（大代码块会像卡死）。
        if (ch.chunkResolvers.size === 0) {
          const sid = this.sessionOfWebContents(sender.id)
          if (sid) this.onPageStream?.(sid, payload.text, tps)
        }
        break
      }
      case 'stream-heartbeat': {
        // 页面确实还在生成（只是暂停出字）：重置发送静默、截断宽限与看门狗，
        // 避免「思考 90 秒」被当成卡死然后插一条重试消息。
        ch.lastActivityAt = Date.now()
        this.rearmErrorGrace(ch)
        for (const r of ch.chunkResolvers) r(ch.streamBuf, 0)
        break
      }
      case 'stream-end': {
        // DOM 已确认这一轮结束：即使网络层报过截断，也以页面最终文本为准，
        // 不再触发「中途插话」式重试。
        this.clearErrorGrace(ch)
        ch.streamBuf = payload.text
        ch.lastActivityAt = Date.now()
        for (const r of ch.chunkResolvers) r(payload.text, 0)
        ch.chunkResolvers.clear()
        if (ch.replyResolvers.size === 0) {
          // 没有等待方：网页侧自己发的消息，或网络 hook 失败后的 DOM 兜底
          if (payload.text.trim() && !sameReply(ch.lastResolvedText, payload.text)) {
            ch.lastResolvedText = payload.text
            const sid = this.sessionOfWebContents(sender.id)
            if (sid) this.onPageReply?.(sid, payload.text)
          }
          break
        }
        if (ch.domFallbackTimer) clearTimeout(ch.domFallbackTimer)
        ch.domFallbackTimer = setTimeout(() => {
          ch.domFallbackTimer = undefined
          const finalText = ch.netText?.length ? ch.netText : payload.text
          ch.lastResolvedText = finalText
          for (const r of ch.replyResolvers) r(finalText)
          ch.replyResolvers.clear()
          // 3 秒足够等网络层权威文本（它通常与 DOM 结束同时到达）。
          // 此前 12 秒会让没有 net hook 的平台每轮都多等 12 秒，且长回复期间
          // 会被上一轮的 netText 提前 resolve。
        }, 3000)
        break
      }
      case 'send-result':
        for (const r of ch.sendResolvers) r(payload.ok, payload.error)
        ch.sendResolvers.clear()
        break
      // ---------- 网络层 hook（不依赖 DOM，优先于 DOM 轮询）----------
      case 'net-stream': {
        // 主世界 SSE 增量：直接把完整文本交给等待方（比 DOM 轮询更准更快）
        ch.streamBuf = payload.text
        if (payload.text || payload.think) ch.lastActivityAt = Date.now()
        ch.thinkBuf = payload.think ?? ''
        // 有增量 = 页面仍在生成；把软错误宽限顺延，避免中途插话
        if (payload.text || payload.think) this.rearmErrorGrace(ch)
        for (const r of ch.chunkResolvers)
          r(payload.text, this.estimateTps(payload.text.length, ch))
        // 思考过程流式上报（纯净模式折叠块显示）
        if (payload.think) {
          const sessionId = this.sessionOfWebContents(sender.id)
          if (sessionId) this.onThinkChunk?.(sessionId, payload.think)
        }
        break
      }
      case 'net-response': {
        ch.streamBuf = payload.text
        if (payload.status === 'stopped') {
          // 网页侧自己停了（用户点了停止/平台中断）：不能当成失败去重试，
          // 否则用户刚停，Lidow 立刻插一句「回复似乎中断了，请重新回答」。
          // 只有 Lidow 主动停止（看门狗/停止按钮）才交给 loop 的停止逻辑。
          const byLidow = ch.lidowStopped === true
          ch.lidowStopped = false
          if (!byLidow) {
            for (const r of ch.replyResolvers) r(new Error('用户在网页侧停止了生成'))
            ch.replyResolvers.clear()
            ch.chunkResolvers.clear()
            break
          }
          this.clearErrorGrace(ch)
          for (const r of ch.chunkResolvers) r(payload.text, 0)
          ch.chunkResolvers.clear()
          for (const r of ch.replyResolvers) r('')
          ch.replyResolvers.clear()
          break
        }
        if (payload.status === 'error') {
          ch.netError = payload.text
          const reason = payload.reason ?? 'error'
          // 截断/空回复先给页面 20 秒收尾：DeepSeek 的 INCOMPLETE 常常只是
          // 当前 SSE 段落结束，正文可能还在继续。期间 DOM 结束就用 DOM 文本，
          // 彻底没动静才抛错触发重试 —— 不能再「网页还在写就插一条重试消息」。
          if (this.isSoftStreamError(reason)) {
            this.armErrorGrace(ch, reason, payload.text)
            break
          }
          this.clearErrorGrace(ch)
          const detail = payload.reason ? `（${payload.reason}）` : ''
          const partial = payload.text ? `，已收到 ${payload.text.length} 字` : ''
          const err = new Error(`AI 回复中断${detail}${partial}`)
          for (const r of ch.replyResolvers) r(err)
          ch.replyResolvers.clear()
          ch.chunkResolvers.clear()
          if (ch.domFallbackTimer) {
            clearTimeout(ch.domFallbackTimer)
            ch.domFallbackTimer = undefined
          }
          break
        }
        // finished：以网络层文本为准结束本轮（覆盖 DOM 兜底）
        this.clearErrorGrace(ch)
        ch.netText = payload.text
        // 服务端权威 token：accumulated 是会话累计，本轮消耗 = 本轮 − 上一轮
        if (typeof payload.tokens === 'number') {
          const delta = payload.tokens - (ch.lastAcc ?? 0)
          ch.lastAcc = payload.tokens
          if (delta > 0) {
            const sid = this.sessionOfWebContents(sender.id)
            if (sid) this.onTokenUsage?.(sid, delta)
          }
        }
        if (ch.domFallbackTimer) {
          clearTimeout(ch.domFallbackTimer)
          ch.domFallbackTimer = undefined
        }
        // 有等待方 → 交给 loop 的 collectReply；没有等待方 → 是用户在网页里
        // 自己发的消息，交给常驻回调接管（否则这条回复无人处理，AI 也就永远
        // 不知道有工具和工作目录可用）
        const hadWaiter = ch.replyResolvers.size > 0
        for (const r of ch.chunkResolvers) r(payload.text, 0)
        ch.chunkResolvers.clear()
        for (const r of ch.replyResolvers) r(payload.text)
        ch.replyResolvers.clear()
        if (hadWaiter) ch.lastResolvedText = payload.text
        // 没有等待方 → 可能是用户在网页里自己发的新消息，也可能是多阶段回答的
        // 最终一段（搜索/深度思考完成后会再发一轮）。只按文本去重，不再用
        // 「距上次 resolve 不足 8 秒」直接丢弃 —— 那会把最终答案吞掉。
        if (!hadWaiter && payload.text.trim() && !sameReply(ch.lastResolvedText, payload.text)) {
          ch.lastResolvedText = payload.text
          const sessionId = this.sessionOfWebContents(sender.id)
          if (sessionId) this.onPageReply?.(sessionId, payload.text)
        }
        break
      }
      case 'net-error': {
        // 网络层失败（HTTP 429 / 流异常 / 业务错误码）
        ch.netError = payload.reason
        if (this.isSoftStreamError(payload.reason)) {
          this.armErrorGrace(ch, payload.reason, payload.text)
          break
        }
        this.clearErrorGrace(ch)
        const detail = payload.text ? `：${payload.text.slice(0, 200)}` : ''
        const err = new Error(`AI 请求失败（${payload.reason}）${detail}`)
        for (const r of ch.replyResolvers) r(err)
        ch.replyResolvers.clear()
        ch.chunkResolvers.clear()
        if (ch.domFallbackTimer) {
          clearTimeout(ch.domFallbackTimer)
          ch.domFallbackTimer = undefined
        }
        break
      }
      case 'float-menu-action': {
        // 初始化项目不依赖会话绑定：首次使用场景下 webview 还没绑任何会话，
        // sessionOfWebContents 返回 undefined，走 sessionId 分支会整个断掉 ——
        // 用户点「初始化项目」毫无反应。按 webContentsId 直达。
        if (payload.action === 'init-project') {
          this.onInitProject?.(sender.id)
          break
        }
        if (payload.action === 'confirm-project') {
          this.onConfirmProject?.(sender.id)
          break
        }
        if (payload.action === 'continue-project') {
          this.onContinueProject?.(sender.id)
          break
        }
        if (payload.action === 'open-external') {
          this.onOpenExternal?.(sender.id, payload.url)
          break
        }
        const sessionId = this.sessionOfWebContents(sender.id)
        if (sessionId && this.onFloatAction) this.onFloatAction(sessionId, payload.action)
        break
      }
      case 'toggle-state': {
        // 网页里平台自带开关的真实状态：转发给渲染层给 chip 上色
        this.onToggleState?.(
          payload.think,
          payload.search,
          payload.thinkAvailable,
          payload.searchAvailable
        )
        break
      }
      case 'nav': {
        // 页面导航：会话 ↔ 平台对话 URL 的映射在此建立（换绑回原对话的依据）
        const sid = this.sessionOfWebContents(sender.id)
        if (sid) this.onNav?.(sid, payload.url, payload.title)
        break
      }
      case 'user-message': {
        // 网页侧直发的用户消息：只记到当前绑定的会话，避免串台
        const sessionId = this.sessionOfWebContents(sender.id)
        if (sessionId && payload.text.trim()) this.onPageUserMessage?.(sessionId, payload.text)
        break
      }
      case 'page-snapshot': {
        const sessionId = this.sessionOfWebContents(sender.id)
        if (sessionId && payload.text.trim())
          this.onPageSnapshot?.(sessionId, payload.text, payload.think)
        break
      }
      case 'chat-deleted': {
        this.onChatDeleted?.(sender.id, payload.url)
        break
      }
      case 'activate-chat': {
        if (payload.url) this.onActivateChat?.(sender.id, payload.url, payload.reload)
        break
      }
      case 'native-new-chat': {
        this.onNativeNewChat?.(sender.id)
        break
      }
      case 'open-chat-result': {
        for (const r of [...this.openChatResolvers]) r(payload.ok)
        break
      }
      case 'login-state': {
        // 登录成功的那一刻 = 该弹初始化引导的时候。
        // 这里把「有没有工作目录」重新推一次：overlay 会据此在页面里显示引导，
        // 登录页没有输入框，那时弹引导既看不懂也用不上。
        this.onLoginState?.(sender.id, Boolean(payload.loggedIn))
        if (payload.loggedIn) this.onLogin?.(sender.id)
        break
      }
      case 'profile-name': {
        const name = String(payload.name || '').trim()
        if (name) this.onProfileName?.(sender.id, name)
        break
      }
      case 'model-options': {
        const waiter = this.modelInfoWaiters.get(sender.id)
        if (waiter) {
          this.modelInfoWaiters.delete(sender.id)
          waiter({ current: payload.current, options: payload.options })
        }
        break
      }
      case 'model-selected': {
        const waiter = this.modelSelectWaiters.get(sender.id)
        if (waiter) {
          this.modelSelectWaiters.delete(sender.id)
          waiter({ ok: payload.ok, label: payload.label, error: payload.error })
        }
        break
      }
      case 'ready': {
        this.onAnyReady?.(sender.id)
        const sessionId = this.sessionOfWebContents(sender.id)
        if (sessionId && this.onReady) this.onReady(sessionId)
        break
      }
      default:
        break
    }
  }

  private startTs = new Map<number, number>()

  private estimateTps(chars: number, ch: Channel): number {
    const id = ch.webContentsId
    if (!this.startTs.has(id)) this.startTs.set(id, Date.now())
    const seconds = Math.max(1, (Date.now() - this.startTs.get(id)!) / 1000)
    return Math.round(chars / 4 / seconds) // 近似：4 字符 ≈ 1 token
  }

  sessionOfWebContents(webContentsId: number): string | undefined {
    for (const [sid, wcId] of this.bindings) if (wcId === webContentsId) return sid
    return undefined
  }

  private channelOfSession(sessionId: string): Channel | null {
    const wcId = this.bindings.get(sessionId)
    if (wcId === undefined) return null
    const ch = this.channels.get(wcId)
    if (!ch || !webContents.fromId(wcId)) return null
    return ch
  }

  private targetOf(ch: Channel): WebContents | undefined {
    return webContents.fromId(ch.webContentsId)
  }

  setThinkChunkHandler(fn: (sessionId: string, think: string) => void): void {
    this.onThinkChunk = fn
  }

  /** 注册「网页侧 AI 回复完成」回调（用户在网页里自行发送时也走这条） */
  setPageReplyHandler(fn: (sessionId: string, text: string) => void): void {
    this.onPageReply = fn
  }

  /** 注册「用户在网页里自己发消息」回调（纯净模式同步用户轮次） */
  setPageUserMessageHandler(fn: (sessionId: string, text: string) => void): void {
    this.onPageUserMessage = fn
  }

  /** 注册「页面重挂载时的最后一条 AI 回答」回调 */
  setPageSnapshotHandler(fn: (sessionId: string, text: string, think?: string) => void): void {
    this.onPageSnapshot = fn
  }

  bindSession(sessionId: string, webContentsId: number): void {
    // 单绑定不变量：一个 webview 同时只承载一个会话。
    // 换绑时不解除旧会话（此前 renderer 只调 bindSession），sessionOfWebContents
    // 会一直返回最早绑定的会话 —— 导航 URL、思考流、网页输入框回复全部归错会话。
    for (const [sid, wcId] of this.bindings) {
      if (wcId === webContentsId && sid !== sessionId) this.bindings.delete(sid)
    }
    const same = this.bindings.get(sessionId) === webContentsId
    this.bindings.set(sessionId, webContentsId)
    // 绑定值没变时降低日志噪音（死循环场景每秒会打几十条）
    if (!same) Logger.info('overlay', `绑定会话 ${sessionId} → webContents ${webContentsId}`)
  }

  unbindSession(sessionId: string): void {
    this.bindings.delete(sessionId)
  }

  sendCmd(sessionId: string, cmd: OverlayCommand): boolean {
    const ch = this.channelOfSession(sessionId)
    if (!ch) return false
    this.targetOf(ch)?.send('lidow:overlay-cmd', cmd)
    return true
  }

  /**
   * 不按会话、直接按 webview 下发命令。
   * 用于「还没有会话」的场景：无项目时打开 AI 页面，要把
   * projectRoot=null 告诉 overlay 让它弹首次引导，但此时没有 sessionId。
   */
  sendCmdToWebContents(webContentsId: number, cmd: OverlayCommand): boolean {
    const target = webContents.fromId(webContentsId)
    if (!target || target.isDestroyed()) return false
    target.send('lidow:overlay-cmd', cmd)
    return true
  }

  private modelInfoWaiters = new Map<number, (info: ModelPickerInfo) => void>()
  private modelSelectWaiters = new Map<number, (r: { ok: boolean; label?: string; error?: string }) => void>()

  /** 读取网页模型菜单（打开→读→关闭），返回当前模型与可选项 */
  async getModels(sessionId: string): Promise<ModelPickerInfo> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) return { current: '', options: [] }
    const wcId = ch.webContentsId
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.modelInfoWaiters.delete(wcId)
        resolve({ current: '', options: [] })
      }, 8000)
      this.modelInfoWaiters.set(wcId, (info) => {
        clearTimeout(timer)
        this.modelInfoWaiters.delete(wcId)
        resolve(info)
      })
      if (!this.sendCmd(sessionId, { kind: 'get-models' })) {
        clearTimeout(timer)
        this.modelInfoWaiters.delete(wcId)
        resolve({ current: '', options: [] })
      }
    })
  }

  /** 在网页模型菜单里选择指定模型 */
  async selectModel(
    sessionId: string,
    label: string
  ): Promise<{ ok: boolean; label?: string; error?: string }> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) return { ok: false, error: '网页未连接' }
    const wcId = ch.webContentsId
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.modelSelectWaiters.delete(wcId)
        resolve({ ok: false, error: '切换模型超时' })
      }, 8000)
      this.modelSelectWaiters.set(wcId, (r) => {
        clearTimeout(timer)
        this.modelSelectWaiters.delete(wcId)
        resolve(r)
      })
      if (!this.sendCmd(sessionId, { kind: 'select-model', modelLabel: label })) {
        clearTimeout(timer)
        this.modelSelectWaiters.delete(wcId)
        resolve({ ok: false, error: '网页未连接' })
      }
    })
  }

  /** 下发发送指令并等待 overlay 确认已注入页面；同一网页按设置的最小间隔串行发送 */
  async sendToPage(sessionId: string, text: string): Promise<void> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) throw new Error('网页未连接（平台页面未加载完成，请稍后重试）')
    const wcId = ch.webContentsId
    const run = async (): Promise<void> => {
      // 排队期间可能已经切换会话/页面：绝不能把旧消息打进新对话
      if (this.bindings.get(sessionId) !== wcId) throw new Error('会话已切换，已取消排队消息')
      const interval = Math.max(0, Math.min(60_000, Number(this.sendIntervalProvider()) || 0))
      const wait = (this.lastSendAt.get(wcId) ?? 0) + interval - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (this.bindings.get(sessionId) !== wcId) throw new Error('会话已切换，已取消排队消息')
      // 网络层还在出字/思考时不要发：重试提示会被平台排成“中途插话”
      await this.waitForPageQuiet(ch, quietWindow(interval))
      if (this.bindings.get(sessionId) !== wcId) throw new Error('会话已切换，已取消排队消息')
      // 设置里的间隔是“上一条回复结束后等多久”，从页面最后一次活动算起，
      // 不能从上次发送算起：长回复早就超过间隔，等于没有等待。
      const remain = remainingSendDelay(ch.lastActivityAt, interval)
      if (remain > 0) await new Promise((r) => setTimeout(r, remain))
      if (this.bindings.get(sessionId) !== wcId) throw new Error('会话已切换，已取消排队消息')
      this.lastSendAt.set(wcId, Date.now())
      await this.sendNow(ch, text)
    }
    const prev = this.sendChains.get(wcId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(run)
    this.sendChains.set(wcId, next)
    try {
      await next
    } finally {
      if (this.sendChains.get(wcId) === next) this.sendChains.delete(wcId)
    }
  }

  /** 等网页流真正静下来再发送（最多 20 秒），避免在生成中途插话 */
  private async waitForPageQuiet(ch: Channel, quietMs = 1500, maxMs = 20_000): Promise<void> {
    const deadline = Date.now() + maxMs
    for (;;) {
      const idleFor = Date.now() - (ch.lastActivityAt ?? 0)
      if (!ch.lastActivityAt || idleFor >= quietMs) return
      if (Date.now() >= deadline) throw new Error('页面仍在生成回复，已暂缓发送')
      await new Promise((r) => setTimeout(r, Math.min(300, quietMs - idleFor)))
    }
  }

  private async sendNow(ch: Channel, text: string): Promise<void> {
    const target = this.targetOf(ch)
    if (!target) throw new Error('webview 已销毁')
    this.startTs.delete(ch.webContentsId)
    // 新请求落地前清空上一轮的权威文本/错误：DOM 兜底只会用本轮的数据
    this.clearErrorGrace(ch)
    ch.lidowStopped = false
    ch.netText = undefined
    ch.lastResolvedText = undefined
    ch.netError = undefined
    ch.streamBuf = ''
    // 页面正在首屏加载/整页跳转时，overlay 的 preload 上下文会被销毁，
    // send-result 永远回不来（之前只能干等 20 秒超时再重试）。这里等加载完成，
    // 并在发送期间监听主框架跳转：一旦跳转立即失败，让 loop 快速重试。
    for (let i = 0; i < 40 && !target.isDestroyed() && target.isLoading(); i++) {
      await new Promise((r) => setTimeout(r, 150))
    }
    if (target.isDestroyed()) throw new Error('webview 已销毁')
    if (target.isLoading()) throw new Error('页面仍在加载，请稍后重试')
    const sendP = new Promise<void>((resolve, reject) => {
      let cleanup = (): void => undefined
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('发送超时（页面可能弹出拦截确认）'))
      }, SEND_TIMEOUT_MS)
      const onNav = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
        if (!details.isMainFrame || details.isSameDocument) return
        cleanup()
        reject(new Error('页面正在跳转，发送已取消'))
      }
      const onSend = (ok: boolean, err?: string): void => {
        cleanup()
        if (ok) resolve()
        else reject(new Error(err ?? '发送失败'))
      }
      cleanup = (): void => {
        clearTimeout(timer)
        target.removeListener('did-start-navigation', onNav)
        ch.sendResolvers.delete(onSend)
      }
      ch.sendResolvers.add(onSend)
      target.on('did-start-navigation', onNav)
    })
    target.send('lidow:overlay-cmd', { kind: 'send', text } satisfies OverlayCommand)
    return sendP
  }

  /** 会话 → hook 源码（页面导航/重载后需要重新注入，SPA 内部跳转不会丢） */
  private hookSources = new Map<string, string>()
  private hookBoundWc = new Set<number>()
  /**
   * (sessionId, wcId) 最近一次注入时间：只用于防短时间重复注入。
   * 不能像此前那样永久短路 —— 会话 A→B→A 切回时必须重新执行，
   * 否则页面里的 __lidowSysPrompt__ 还停在上一个会话，网页输入框直发的消息
   * 会带着错误会话/目录的系统提示词。
   */
  private lastHookInject = new Map<string, number>()

  /**
   * 向 webview 主世界注入网络层 hook。
   * executeJavaScript 默认就在主世界执行；页面 reload/导航后主世界脚本会丢失，
   * 因此同时挂 did-finish-load 重新注入。
   */
  async injectHook(sessionId: string, source: string): Promise<boolean> {
    this.hookSources.set(sessionId, source)
    // 直接用 binding 里的 webContentsId，不走 channel ——
    // channels 只在 overlay 主动上报事件时才创建，hook 注入时可能还没建立。
    let wcId = this.bindings.get(sessionId)
    for (let i = 0; i < 60 && !wcId; i++) {
      await new Promise((r) => setTimeout(r, 200))
      wcId = this.bindings.get(sessionId)
    }
    if (!wcId) {
      Logger.warn('overlay', `injectHook: 会话未绑定 webContents session=${sessionId}`)
      return false
    }
    const target = webContents.fromId(wcId)
    if (!target || target.isDestroyed()) {
      Logger.warn('overlay', 'injectHook: webContents 不存在')
      return false
    }
    // 同一 (会话, webview) 短时间内重复 configure 时跳过（防注入风暴）；
    // 但不能永久跳过 —— 会话切走再切回必须重跑以刷新页面里的系统提示词。
    const pairKey = `${sessionId}:${wcId}`
    const last = this.lastHookInject.get(pairKey) ?? 0
    if (Date.now() - last < 500) return true
    // 页面每次加载完成后补注（刷新/首次打开都能生效）。
    // 会话会换绑：闭包里的 sessionId 是首次注入时的旧值，恢复时必须按
    // 「当前绑到这个 webview 的会话」取源码，否则会把别的会话的提示词注入回来。
    if (!this.hookBoundWc.has(wcId)) {
      this.hookBoundWc.add(wcId)
      target.on('did-finish-load', () => {
        const currentSid = this.sessionOfWebContents(wcId)
        const src = currentSid ? this.hookSources.get(currentSid) : undefined
        if (src) void target.executeJavaScript(src, true).catch(() => undefined)
      })
    }
    for (let i = 0; i < 100; i++) {
      // webview 可能在此期间被销毁/重建（切平台、重挂载）：失效即止，靠 did-finish-load 或下次 configure 重来
      if (target.isDestroyed()) return false
      if (!target.isLoading()) {
        try {
          await target.executeJavaScript(source, true)
          this.lastHookInject.set(pairKey, Date.now())
          Logger.info('overlay', `hook 注入成功 session=${sessionId} try=${i + 1}`)
          return true
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('disposed')) return false
          if (i === 0) Logger.warn('overlay', `hook 注入异常: ${msg}`)
        }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  /** 等待会话的网页通道就绪（webview 尚未 attach 时轮询，最多 waitMs） */
  private async waitForChannel(sessionId: string, waitMs = 8000): Promise<Channel | null> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const ch = this.channelOfSession(sessionId)
      if (ch) return ch
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /** 等待网页当前轮真正结束（供 loop 在注册等待器之前调用） */
  async waitPageIdle(sessionId: string): Promise<void> {
    const ch = await this.waitForChannel(sessionId)
    if (ch) {
      const interval = Math.max(0, Math.min(60_000, Number(this.sendIntervalProvider()) || 0))
      await this.waitForPageQuiet(ch, quietWindow(interval))
    }
  }

  /**
   * 让网页通过点击侧栏链接做 SPA 切换（避免整页 reload 后项目文件夹消失几秒）。
   * overlay 回传是否找到了链接；找不到由调用方回退 loadURL。
   */
  async openChatInPage(sessionId: string, url: string): Promise<boolean> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) return false
    const target = this.targetOf(ch)
    if (!target) return false
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        this.openChatResolvers.delete(finish)
        resolve(ok)
      }
      this.openChatResolvers.add(finish)
      target.send('lidow:overlay-cmd', { kind: 'open-chat', url } satisfies OverlayCommand)
      const timer = setTimeout(() => finish(false), 1800)
      timer.unref?.()
    })
  }

  /** 等待一轮完整回复；失败时 reject（供 loop 的重试引擎接管） */
  async awaitReply(
    sessionId: string,
    onChunk: (partial: string, tps: number) => void
  ): Promise<string> {
    // 首次发送时 webview 可能还在 attach：等待通道就绪而不是立即失败
    const ch = await this.waitForChannel(sessionId)
    if (!ch) return Promise.reject(new Error('网页未连接（平台页面未加载完成，请稍后重试）'))
    if (ch.replyResolvers.size > 0) return Promise.reject(new Error('已有等待中的回复请求'))

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ch.chunkResolvers.delete(onChunk)
        ch.replyResolvers.delete(wrapped)
        reject(new Error('等待回复超时（页面可能未发送或流未结束）'))
      }, REPLY_TIMEOUT_MS)

      const wrapped = (text: string | Error): void => {
        clearTimeout(timer)
        ch.chunkResolvers.delete(onChunk)
        if (text instanceof Error) reject(text)
        else resolve(text)
      }
      ch.chunkResolvers.add(onChunk)
      ch.replyResolvers.add(wrapped)
    })
  }

  interruptPage(sessionId: string): void {
    const ch = this.channelOfSession(sessionId)
    if (!ch) return
    // 打标：随后的 stopped 事件是 Lidow 主动停止，不是用户/平台自己停的
    ch.lidowStopped = true
    const timer = setTimeout(() => {
      if (ch.lidowStopped) ch.lidowStopped = false
    }, 15_000)
    timer.unref?.()
    this.targetOf(ch)?.send('lidow:overlay-cmd', { kind: 'stop' } satisfies OverlayCommand)
  }

  /**
   * 放弃当前等待（看门狗判死 / 上层超时后调用）。
   * 不清理的话 replyResolvers 会一直非空，下一轮直接报「已有等待中的回复请求」，
   * 表现就是"第一次中断之后再也不重试了"。
   */
  abandonReply(sessionId: string): void {
    const ch = this.channelOfSession(sessionId)
    if (!ch) return
    this.clearErrorGrace(ch)
    if (ch.domFallbackTimer) {
      clearTimeout(ch.domFallbackTimer)
      ch.domFallbackTimer = undefined
    }
    ch.replyResolvers.clear()
    ch.chunkResolvers.clear()
  }

  /** 截断/空回复/流或网络异常都可能只是网络层误报：先等页面自己收尾，不急着重试 */
  private isSoftStreamError(reason: string): boolean {
    return /incomplete|^empty$|^stream(-error)?$|^network$|^xhr$/i.test(reason)
  }

  private clearErrorGrace(ch: Channel): void {
    if (ch.errorGraceTimer) clearTimeout(ch.errorGraceTimer)
    ch.errorGraceTimer = undefined
    ch.pendingError = undefined
  }

  /** 收到新内容时顺延宽限：页面还在写，就继续等 DOM 收尾 */
  private rearmErrorGrace(ch: Channel): void {
    const pending = ch.pendingError
    if (pending) this.armErrorGrace(ch, pending.reason, pending.text)
  }

  private armErrorGrace(ch: Channel, reason: string, text: string): void {
    ch.pendingError = { reason, text }
    if (ch.errorGraceTimer) clearTimeout(ch.errorGraceTimer)
    ch.errorGraceTimer = setTimeout(() => {
      ch.errorGraceTimer = undefined
      const pending = ch.pendingError
      ch.pendingError = undefined
      if (!pending || ch.replyResolvers.size === 0) return
      const got = ch.netText?.length ? ch.netText : ch.streamBuf
      const partial = got ? `，已收到 ${got.length} 字` : ''
      const err = new Error(`AI 回复中断（${pending.reason}）${partial}`)
      for (const r of ch.replyResolvers) r(err)
      ch.replyResolvers.clear()
      ch.chunkResolvers.clear()
      if (ch.domFallbackTimer) {
        clearTimeout(ch.domFallbackTimer)
        ch.domFallbackTimer = undefined
      }
    }, ERROR_GRACE_MS)
    ch.errorGraceTimer.unref?.()
  }

  /** 在网页内执行 JS（injectJS 工具落点），返回求值结果的字符串化 */
  async executeJs(sessionId: string, code: string): Promise<string> {
    const ch = this.channelOfSession(sessionId)
    if (!ch) throw new Error('网页未连接')
    const target = this.targetOf(ch)
    if (!target) throw new Error('webview 已销毁')
    const result = await target.executeJavaScript(code, true)
    if (result === undefined || result === null) return '(undefined)'
    return typeof result === 'string' ? result : JSON.stringify(result).slice(0, 8000)
  }

  /** webview 销毁/导航时清理，挂起的等待以空文本收场（循环侧判空报错） */
  disposeWebContents(webContentsId: number): void {
    const ch = this.channels.get(webContentsId)
    if (ch) {
      for (const r of ch.replyResolvers) r('')
      ch.replyResolvers.clear()
      ch.chunkResolvers.clear()
      for (const r of ch.sendResolvers) r(false, 'webview 已关闭')
      ch.sendResolvers.clear()
    }
    this.channels.delete(webContentsId)
    this.startTs.delete(webContentsId)
    for (const [sid, wcId] of this.bindings) {
      if (wcId === webContentsId) this.bindings.delete(sid)
    }
  }
}
