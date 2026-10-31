import type { AppSettings } from '@shared/types'
import { Logger } from '@main/infra/log'

/**
 * 多端同步：飞书 / 企业微信 / 钉钉群机器人 webhook 推送（出站）。
 * 每窗口可独立绑定；入站方向（手机端回消息/中止任务）经由飞书长连接需企业自建应用凭证，
 * 以 server 模式预留接口，未配置时仅出站推送。
 */

export type SyncChannel = 'feishu' | 'wecom' | 'dingtalk'

export class SyncService {
  constructor(private getSettings: () => AppSettings) {}

  private webhookOf(channel: SyncChannel): string | null {
    const s = this.getSettings().sync
    const cfg = s[channel]
    return cfg?.enabled && cfg.webhookUrl ? cfg.webhookUrl : null
  }

  /** 出站：发送文本到指定渠道群 */
  async push(channel: SyncChannel, text: string): Promise<boolean> {
    const url = this.webhookOf(channel)
    if (!url) return false
    const body = this.payload(channel, text)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      })
      // 三家机器人出错时大多仍返回 HTTP 200，错误码在 body 里
      const raw = await res.text().catch(() => '')
      if (!res.ok) {
        Logger.warn('sync', `${channel} 推送失败 HTTP ${res.status}: ${raw.slice(0, 200)}`)
        return false
      }
      type WebhookResp = {
        code?: unknown
        errcode?: unknown
        StatusCode?: unknown
        msg?: unknown
        errmsg?: unknown
      }
      let parsed: WebhookResp | null = null
      try {
        parsed = JSON.parse(raw) as WebhookResp
      } catch {
        /* 非 JSON 响应按成功处理 */
      }
      const code = parsed?.code ?? parsed?.errcode ?? parsed?.StatusCode
      if (typeof code === 'number' && code !== 0) {
        Logger.warn('sync', `${channel} 推送被拒绝 code=${code}: ${String(parsed?.msg ?? parsed?.errmsg ?? '')}`)
        return false
      }
      return true
    } catch (e) {
      Logger.warn('sync', `${channel} 推送失败: ${String(e)}`)
      return false
    }
  }

  async pushAll(text: string): Promise<void> {
    await Promise.allSettled((['feishu', 'wecom', 'dingtalk'] as SyncChannel[]).map((c) => this.push(c, text)))
  }

  private payload(channel: SyncChannel, text: string): Record<string, unknown> {
    // 企微文本上限 2048 字节（不是字符），中文按 3 字节算会超限
    const limit = channel === 'wecom' ? 2000 : channel === 'feishu' ? 30_000 : 20_000
    const msg = truncateUtf8(text, limit)
    if (channel === 'feishu') return { msg_type: 'text', content: { text: msg } }
    if (channel === 'wecom') return { msgtype: 'text', text: { content: msg } }
    return { msgtype: 'text', text: { content: msg } } // dingtalk
  }
}

/** 按 UTF-8 字节数截断，避免把多字节字符劈成乱码 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf-8')
    if (bytes + n > maxBytes) break
    bytes += n
    out += ch
  }
  return out + '…'
}
