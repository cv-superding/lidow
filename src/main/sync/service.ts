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
      return res.ok
    } catch (e) {
      Logger.warn('sync', `${channel} 推送失败: ${String(e)}`)
      return false
    }
  }

  async pushAll(text: string): Promise<void> {
    await Promise.allSettled((['feishu', 'wecom', 'dingtalk'] as SyncChannel[]).map((c) => this.push(c, text)))
  }

  private payload(channel: SyncChannel, text: string): Record<string, unknown> {
    const msg = text.slice(0, 3000)
    if (channel === 'feishu') return { msg_type: 'text', content: { text: msg } }
    if (channel === 'wecom') return { msgtype: 'text', text: { content: msg } }
    return { msgtype: 'text', text: { content: msg } } // dingtalk
  }
}
