import { describe, expect, it } from 'vitest'
import { hasAnsi, parseAnsi } from '../src/renderer/src/ansi'

/** 把解析结果还原成纯文本（用于断言内容不丢） */
const plain = (s: string): string => parseAnsi(s).map((x) => x.text).join('')

describe('ANSI 解析', () => {
  it('剥离 SGR 颜色码，文本内容完整保留', () => {
    // 用户截图里 PowerShell ls 的真实输出片段
    const raw = '\x1b[32;1mMode\x1b[0m \x1b[32;1mLastWriteTime\x1b[0m \x1b[32;1mLength\x1b[0m'
    const spans = parseAnsi(raw)
    expect(spans.map((s) => s.text).join('')).toBe('Mode LastWriteTime Length')
    expect(spans.some((s) => s.color === '#98c379' && s.bold)).toBe(true)
  })

  it('解析 ls 的目录行，颜色与粗体正确', () => {
    const raw = '\x1b[32;1m----\x1b[0m \x1b[32;1m----------\x1b[0m \x1b[32;1m-------\x1b[0m'
    const spans = parseAnsi(raw)
    expect(spans.every((s) => !s.text.includes('\x1b'))).toBe(true)
    expect(spans[0]!.color).toBe('#98c379')
    expect(spans[0]!.bold).toBe(true)
  })

  it('256 色与真彩色', () => {
    expect(parseAnsi('\x1b[38;5;196mX\x1b[0m')[0]!.color).toBe('rgb(255, 0, 0)')
    expect(parseAnsi('\x1b[38;2;10;20;30mY\x1b[0m')[0]!.color).toBe('rgb(10, 20, 30)')
  })

  it('丢弃光标/清屏等非 SGR 序列，不泄漏成可见字符', () => {
    const raw = '\x1b[2J\x1b[H\x1b[1;32mOK\x1b[0m\x1b[?25l'
    expect(plain(raw)).toBe('OK')
  })

  it('处理反色与重置', () => {
    const raw = '\x1b[7mINV\x1b[0m normal'
    const spans = parseAnsi(raw)
    expect(spans[0]!.inverse).toBe(true)
    expect(spans[0]!.text).toBe('INV')
    // 重置后 inverse 显式为 false（或未定义），都表示不再反色
    expect(spans[1]!.inverse).toBeFalsy()
    expect(spans[1]!.text).toBe(' normal')
  })

  it('无 ANSI 时原样返回，且 hasAnsi 判定正确', () => {
    expect(plain('普通输出 no color')).toBe('普通输出 no color')
    expect(hasAnsi('普通输出')).toBe(false)
    expect(hasAnsi('\x1b[31mred\x1b[0m')).toBe(true)
  })

  it('保留中文与换行', () => {
    const raw = '\x1b[32;1m目录: F:\\项目\x1b[0m\n第二行'
    expect(plain(raw)).toBe('目录: F:\\项目\n第二行')
  })
})
