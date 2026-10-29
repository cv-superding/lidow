import { ipcMain, webContents, type WebContents } from 'electron'
import type { OverlayCommand, OverlayEvent } from '@shared/types'
import { Logger } from '@main/infra/log'

const SEND_TIMEOUT_MS = 20_000
const REPLY_TIMEOUT_MS = 10 * 60_000

interface Channel {
  webContentsId: number
  streamBuf: string
  chunkResolvers: Set<(partial: string, tps: number) => void>
  /** 回复结束：正常给文本，失败给 Error（上层据此决定是否重试） */
  replyResolvers: Set<(text: string | Error) => void>
  sendResolvers: Set<(ok: boolean, err?: string) => void>
  /** 网络层上报的错误原因（供 loop 判断是否重试） */
  netError?: string
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
  /** 最近一次「把回复交给等待方」的时间：迟到的 net-response 不能再当成外部消息接管 */
  lastResolveAt?: number
}

/**
 * Overlay 管理器：webview(overlay preload) ↔ main 的桥。
 * 会话通过 bindSession(sessionId, webContentsId) 绑定；
 * 悬浮球动作经 onFloatAction 回调上抛（三层停止的第三层）。
 */
export class OverlayManager {
  private channels = new Map<number, Channel>()
  private bindings = new Map<string, number>()
  private onFloatAction?: (sessionId: string, action: string) => void
  /** 思考过程增量回调（供 renderer 折叠块显示） */
  private onThinkChunk?: (sessionId: string, think: string) => void
  /** 网页侧「AI 回复完成」常驻回调：用户直接在网页输入框发消息时也能接管（cuckoo observer 同款） */
  private onPageReply?: (sessionId: string, text: string) => void
  /** webview 就绪（或重新导航）时回调，用于重发 configure */
  onReady?: (sessionId: string) => void
  /**
   * 网页登录成功回调（按 webContentsId）。
   * 用于在「登录完成」这个时机把项目状态推给网页 —— 首次引导必须等登录后才出现。
   */
  onLogin?: (webContentsId: number) => void
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
  /** overlay 就绪（无论是否已绑定会话）：用于下发网页会话删除监听列表 */
  onAnyReady?: (webContentsId: number) => void

  /** 网页开关状态（深度思考 / 智能搜索）上报 */
  onToggleState?: (think: boolean, search: boolean) => void

  /** 会话当前绑定的 webContents id（未绑定为 undefined） */
  wcIdOfSession(sessionId: string): number | undefined {
    return this.bindings.get(sessionId)
  }

  /** 当前所有已绑定的会话 id（切项目时统一解绑用） */
  boundSessionIds(): string[] {
    return [...this.bindings.keys()]
  }

  setToggleStateHandler(fn: (think: boolean, search: boolean) => void): void {
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
        // 新一轮开始：上一轮的网络层权威文本不能留到这一轮兜底
        ch.netText = undefined
        ch.netError = undefined
        break
      case 'stream-chunk': {
        ch.streamBuf = payload.text
        for (const r of ch.chunkResolvers) r(payload.text, this.estimateTps(payload.text.length, ch))
        break
      }
      case 'stream-end': {
        // DOM 抓的是渲染后的 markdown 气泡：DeepSeek 分段渲染会截断尾部代码块。
        // 网络层（net-response）才是权威文本；DOM end 延迟 3s 兜底 resolve，
        // 期间 net-response 到达则覆盖（见 net-response 分支的 domFallbackTimer 清理）。
        ch.streamBuf = payload.text
        for (const r of ch.chunkResolvers) r(payload.text, 0)
        ch.chunkResolvers.clear()
        if (ch.replyResolvers.size === 0) break
        if (ch.domFallbackTimer) clearTimeout(ch.domFallbackTimer)
        ch.domFallbackTimer = setTimeout(() => {
          ch.domFallbackTimer = undefined
          ch.lastResolveAt = Date.now()
          for (const r of ch.replyResolvers) r(ch.netText?.length ? ch.netText : payload.text)
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
        const prevBuf = ch.streamBuf
        ch.streamBuf = payload.text
        // 文本不是上一段的延续 = 新的一轮流；若当前没有等待方，说明是用户
        // 在网页里自己发的消息，清掉「刚给过等待方」的标记以便正常接管
        if (ch.replyResolvers.size === 0 && prevBuf && !payload.text.startsWith(prevBuf)) {
          ch.lastResolveAt = undefined
        }
        ch.thinkBuf = payload.think ?? ''
        for (const r of ch.chunkResolvers) r(payload.text, this.estimateTps(payload.text.length, ch))
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
          // 用户停止：按空/中断处理，交给 loop 的停止逻辑
          for (const r of ch.chunkResolvers) r(payload.text, 0)
          ch.chunkResolvers.clear()
          for (const r of ch.replyResolvers) r('')
          ch.replyResolvers.clear()
          break
        }
        if (payload.status === 'error') {
          // 失败必须唤醒等待方并抛错，否则 loop 只能干等到 REPLY_TIMEOUT_MS，
          // 或者被 DOM 兜底把半截文本当成"完整回复" —— 两种表现都是「中断了、
          // 但没有任何重试」。保留已收到的部分文本供上层记录，错误原因带上细节。
          ch.netError = payload.text
          const reason = payload.reason ? `（${payload.reason}）` : ''
          const partial = payload.text ? `，已收到 ${payload.text.length} 字` : ''
          const err = new Error(`AI 回复中断${reason}${partial}`)
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
        if (hadWaiter) ch.lastResolveAt = Date.now()
        // 没有等待方 → 用户在网页里自己发的消息；但刚交给等待方的回复可能
        // 晚几百毫秒才从网络层到达（DOM 兜底已先 resolve），不能再次接管，
        // 否则同一段工具调用会被执行两遍。
        if (!hadWaiter && payload.text.trim() && Date.now() - (ch.lastResolveAt ?? 0) > 8_000) {
          const sessionId = this.sessionOfWebContents(sender.id)
          if (sessionId) this.onPageReply?.(sessionId, payload.text)
        }
        break
      }
      case 'net-error': {
        // 网络层失败（HTTP 429 / 流异常 / 业务错误码）：同 error 状态，必须唤醒等待方
        ch.netError = payload.reason
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
        this.onToggleState?.(payload.think, payload.search)
        break
      }
      case 'nav': {
        // 页面导航：会话 ↔ 平台对话 URL 的映射在此建立（换绑回原对话的依据）
        const sid = this.sessionOfWebContents(sender.id)
        if (sid) this.onNav?.(sid, payload.url, payload.title)
        break
      }
      case 'chat-deleted': {
        this.onChatDeleted?.(sender.id, payload.url)
        break
      }
      case 'login-state': {
        // 登录成功的那一刻 = 该弹初始化引导的时候。
        // 这里把「有没有工作目录」重新推一次：overlay 会据此在页面里显示引导，
        // 登录页没有输入框，那时弹引导既看不懂也用不上。
        if (payload.loggedIn) this.onLogin?.(sender.id)
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

  /** 下发发送指令并等待 overlay 确认已注入页面 */
  async sendToPage(sessionId: string, text: string): Promise<void> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) throw new Error('网页未连接（平台页面未加载完成，请稍后重试）')
    const target = this.targetOf(ch)
    if (!target) throw new Error('webview 已销毁')
    this.startTs.delete(ch.webContentsId)
    // 新请求落地前清空上一轮的权威文本/错误：DOM 兜底只会用本轮的数据
    ch.netText = undefined
    ch.netError = undefined
    ch.streamBuf = ''
    const sendP = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('发送超时（页面可能弹出拦截确认）')), SEND_TIMEOUT_MS)
      ch.sendResolvers.add((ok, err) => {
        clearTimeout(timer)
        if (ok) resolve()
        else reject(new Error(err ?? '发送失败'))
      })
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

  /** 等待一轮完整回复；失败时 reject（供 loop 的重试引擎接管） */
  async awaitReply(sessionId: string, onChunk: (partial: string, tps: number) => void): Promise<string> {
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
    if (ch.domFallbackTimer) {
      clearTimeout(ch.domFallbackTimer)
      ch.domFallbackTimer = undefined
    }
    ch.replyResolvers.clear()
    ch.chunkResolvers.clear()
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
