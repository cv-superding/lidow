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
        sendResolvers: new Set()
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
      case 'stream-end':
        ch.streamBuf = payload.text
        for (const r of ch.chunkResolvers) r(payload.text, 0)
        ch.chunkResolvers.clear()
        for (const r of ch.replyResolvers) r(payload.text)
        ch.replyResolvers.clear()
        break
      case 'send-result':
        for (const r of ch.sendResolvers) r(payload.ok, payload.error)
        ch.sendResolvers.clear()
        break
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

  bindSession(sessionId: string, webContentsId: number): void {
    this.bindings.set(sessionId, webContentsId)
    Logger.info('overlay', `绑定会话 ${sessionId} → webContents ${webContentsId}`)
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
    const ch = this.channelOfSession(sessionId)
    if (!ch) throw new Error('网页未连接（webview 未就绪或会话未绑定）')
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

  /** 等待一轮完整回复（stream-end）；onChunk 提供流式增量 */
  awaitReply(sessionId: string, onChunk: (partial: string, tps: number) => void): Promise<string> {
    const ch = this.channelOfSession(sessionId)
    if (!ch) return Promise.reject(new Error('网页未连接'))
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
