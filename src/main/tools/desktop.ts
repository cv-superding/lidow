import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard, desktopCapturer } from 'electron'
import type { ToolDef } from './types'
import { num, str } from './types'

/** 桌面工具：剪贴板读写 + 截屏（nexus-desktop 灵感） */

export const clipboardTool: ToolDef = {
  name: 'clipboard',
  description: '读写系统剪贴板文本。action=read 读取；action=write+text 写入。',
  parameters: {
    action: { type: 'string', description: 'read | write', required: true },
    text: { type: 'string', description: 'write 时要写入的文本' }
  },
  dangerLevel: 'safe',
  async run(input) {
    const action = str(input, 'action')
    if (action === 'read') {
      const text = await clipboard.readText()
      return { ok: true, output: text ? `剪贴板内容（${text.length} 字符）：\n${text.slice(0, 4000)}` : '剪贴板为空或非文本' }
    }
    if (action === 'write') {
      const text = str(input, 'text')
      clipboard.writeText(text)
      return { ok: true, output: `已写入剪贴板（${text.length} 字符）` }
    }
    return { ok: false, output: '', error: `未知 action: ${action}（仅支持 read/write）` }
  }
}

export const screenshotTool: ToolDef = {
  name: 'screenshot',
  description: '截取屏幕保存为 PNG 到项目 .lidow/screenshots/，返回文件路径（用户可在文件视图查看）。',
  parameters: { width: { type: 'number', description: '缩略图宽度，默认 1280（保护输出体积）' } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const width = num(input, 'width', 1280)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height: Math.round((width * 9) / 16) }
    })
    if (sources.length === 0) return { ok: false, output: '', error: '没有可用屏幕' }
    const primary = sources[0]!
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const rel = `.lidow/screenshots/screen-${ts}.png`
    const abs = join(ctx.projectRoot, rel)
    mkdirSync(join(ctx.projectRoot, '.lidow', 'screenshots'), { recursive: true })
    writeFileSync(abs, primary.thumbnail.toPNG())
    ctx.audit?.('tool', `截屏 ${rel}`, { path: abs, bytes: primary.thumbnail.toPNG().length })
    return { ok: true, output: `截屏已保存：${rel}（${Math.round(primary.thumbnail.toPNG().length / 1024)}KB，主显示器）` }
  }
}
