import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
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
  async run(input, ctx) {
    const action = str(input, 'action')
    const mode = ctx.settings.permissionMode ?? 'autonomous'
    if ((mode === 'plan' || mode === 'ask') && action === 'read') {
      const ok = await ctx.confirm('读取系统剪贴板内容（可能包含密码等敏感文本）')
      if (!ok) return { ok: false, output: '', error: '用户拒绝读取剪贴板' }
    }
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
    const mode = ctx.settings.permissionMode ?? 'autonomous'
    if (mode === 'plan' || mode === 'ask') {
      const ok = await ctx.confirm('截取当前屏幕并保存到项目目录')
      if (!ok) return { ok: false, output: '', error: '用户拒绝截屏' }
    }
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


export const sysinfoTool: ToolDef = {
  name: 'sysinfo',
  description: '读取系统运行状态：CPU 核数/负载、内存占用、运行时长、平台信息。',
  parameters: {},
  dangerLevel: 'safe',
  async run() {
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}GB`
    const load = os.loadavg().map((x) => x.toFixed(2)).join(', ')
    const lines = [
      `平台: ${os.platform()} ${os.arch()} (${os.type()} ${os.release()})`,
      `CPU: ${os.cpus().length} 核 × ${os.cpus()[0]?.speed ?? '?'}MHz · 负载(1/5/15min): ${load}`,
      `内存: 已用 ${gb(used)} / ${gb(total)}（${((used / total) * 100).toFixed(0)}%，空闲 ${gb(free)}）`,
      `运行时长: ${(os.uptime() / 3600).toFixed(1)} 小时`,
      `主机名: ${os.hostname()} · 用户: ${os.userInfo().username}`
    ]
    return { ok: true, output: lines.join('\n') }
  }
}
