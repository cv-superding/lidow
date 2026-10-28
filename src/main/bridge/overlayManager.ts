import { ipcMain, webContents, type WebContents } from 'electron'
import type { OverlayCommand, OverlayEvent } from '@shared/types'
import { Logger } from '@main/infra/log'

const SEND_TIMEOUT_MS = 20_000
const REPLY_TIMEOUT_MS = 10 * 60_000

interface Channel {
  webContentsId: number
  streamBuf: string
  chunkResolvers: Set<(partial: string, tps: number) => void>
  replyResolvers: Set<(text: string) => void>
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
  /** webview 就绪（或重新导航）时回调，用于重发 configure */
  onReady?: (sessionId: string) => void

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
          for (const r of ch.replyResolvers) r(ch.netText?.length ? ch.netText : payload.text)
          ch.replyResolvers.clear()
        }, 12000)
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
          ch.netError = payload.text
          break
        }
        // finished：以网络层文本为准结束本轮（覆盖 DOM 兜底）
        ch.netText = payload.text
        if (ch.domFallbackTimer) {
          clearTimeout(ch.domFallbackTimer)
          ch.domFallbackTimer = undefined
        }
        for (const r of ch.chunkResolvers) r(payload.text, 0)
        ch.chunkResolvers.clear()
        for (const r of ch.replyResolvers) r(payload.text)
        ch.replyResolvers.clear()
        break
      }
      case 'net-error': {
        ch.netError = payload.reason
        break
      }
      case 'float-menu-action': {
        const sessionId = this.sessionOfWebContents(sender.id)
        if (sessionId && this.onFloatAction) this.onFloatAction(sessionId, payload.action)
        break
      }
      case 'ready': {
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

  bindSession(sessionId: string, webContentsId: number): void {
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

  /** 下发发送指令并等待 overlay 确认已注入页面 */
  async sendToPage(sessionId: string, text: string): Promise<void> {
    const ch = await this.waitForChannel(sessionId)
    if (!ch) throw new Error('网页未连接（平台页面未加载完成，请稍后重试）')
    const target = this.targetOf(ch)
    if (!target) throw new Error('webview 已销毁')
    this.startTs.delete(ch.webContentsId)
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
  /** 已完成注入的 (sessionId, wcId) 组合：重复 bindSession 不再重发 hook（防注入风暴） */
  private injectedPairs = new Set<string>()

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
    // 同会话同 webview 已注入过 → 不重复注入（死循环场景下会每秒注入几十次）
    const pairKey = `${sessionId}:${wcId}`
    if (this.injectedPairs.has(pairKey)) return true
    // 页面每次加载完成后补注（刷新/首次打开都能生效）
    if (!this.hookBoundWc.has(wcId)) {
      this.hookBoundWc.add(wcId)
      target.on('did-finish-load', () => {
        const src = this.hookSources.get(sessionId)
        if (src) void target.executeJavaScript(src, true).catch(() => undefined)
      })
    }
    for (let i = 0; i < 100; i++) {
      // webview 可能在此期间被销毁/重建（切平台、重挂载）：失效即止，靠 did-finish-load 或下次 configure 重来
      if (target.isDestroyed()) return false
      if (!target.isLoading()) {
        try {
          await target.executeJavaScript(source, true)
          this.injectedPairs.add(pairKey)
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

  /** 等待一轮完整回复（stream-end）；onChunk 提供流式增量 */
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

      const wrapped = (text: string): void => {
        clearTimeout(timer)
        ch.chunkResolvers.delete(onChunk)
        resolve(text)
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
