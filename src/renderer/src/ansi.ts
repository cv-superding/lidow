/**
 * 极简 ANSI SGR 解析器：把终端输出的颜色/样式转义码转成可渲染的片段。
 *
 * 只处理 SGR（Select Graphic Rendition，`ESC[...m`）——这是 PowerShell /
 * ls / git 等命令真正的着色手段。光标移动、清屏等 CSI 序列直接丢弃即可
 * （我们是逐行渲染的历史输出，不做真实终端模拟）。
 */

export interface AnsiSpan {
  text: string
  /** 前景色（CSS 颜色）；undefined 表示继承 */
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  /** 反色（背景/前景互换）——less、htop 常用 */
  inverse?: boolean
}

/** 16 色基础调色板（偏柔和，适配深浅两套主题） */
const BASE_16 = [
  '#000000', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4',
  '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7cc4ff', '#e29bf5', '#6fd6e2', '#ffffff'
]

/** 256 色：前 16 用调色板，16–231 是 6×6×6 立方，232–255 是灰阶 */
function color256(n: number): string | undefined {
  if (n < 16) return BASE_16[n]
  if (n < 232) {
    const i = n - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const to = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${to(r)}, ${to(g)}, ${to(b)})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v}, ${v}, ${v})`
}

/** 当前样式状态 */
interface StyleState {
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

function applySgr(state: StyleState, params: number[]): StyleState {
  const next: StyleState = { ...state }
  // 空参数等价于 0（重置）
  const list = params.length === 0 ? [0] : params
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!
    if (p === 0) {
      next.color = undefined
      next.bold = false
      next.dim = false
      next.italic = false
      next.underline = false
      next.inverse = false
    } else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 22) {
      next.bold = false
      next.dim = false
    } else if (p === 23) next.italic = false
    else if (p === 24) next.underline = false
    else if (p === 27) next.inverse = false
    else if (p >= 30 && p <= 37) next.color = BASE_16[p - 30]
    else if (p === 39) next.color = undefined
    else if (p >= 90 && p <= 97) next.color = BASE_16[p - 90 + 8]
    else if (p === 38 || p === 48) {
      // 扩展色：38;5;n（256 色）或 38;2;r;g;b（真彩）
      const mode = list[i + 1]
      if (mode === 5) {
        const n = list[i + 2]
        if (typeof n === 'number') {
          if (p === 38) next.color = color256(n)
          i += 2
        }
      } else if (mode === 2) {
        const r = list[i + 2] ?? 0
        const g = list[i + 3] ?? 0
        const b = list[i + 4] ?? 0
        if (p === 38) next.color = `rgb(${r}, ${g}, ${b})`
        i += 4
      }
    }
  }
  return next
}

/**
 * 把一行带 ANSI 转义码的文本解析成片段数组。
 * 无法识别的 CSI / OSC 序列会被剥离，不会泄漏成可见乱码。
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const out: AnsiSpan[] = []
  let state: StyleState = {}
  let buf = ''
  let i = 0

  const flush = (): void => {
    if (!buf) return
    out.push({ text: buf, ...state })
    buf = ''
  }

  while (i < input.length) {
    const ch = input[i]!

    // ESC 序列
    if (ch === '\x1b') {
      const nextCh = input[i + 1]

      // CSI: ESC [ ... 终止字节(0x40-0x7E)
      if (nextCh === '[') {
        let j = i + 2
        // 参数字节 0x30-0x3F，中间字节 0x20-0x2F
        while (j < input.length && !/[a-zA-Z@`{\]|~^_]/.test(input[j]!)) j++
        const final = input[j] ?? ''
        const body = input.slice(i + 2, j)
        if (final === 'm') {
          flush()
          const params = body
            .split(';')
            .map((s) => (s === '' ? NaN : Number(s)))
            .filter((n) => !Number.isNaN(n) || n === 0) as number[]
          state = applySgr(state, params)
        }
        // 其余 CSI（移动光标、清屏、隐藏光标…）直接丢弃
        i = j + 1
        continue
      }

      // OSC: ESC ] ... BEL 或 ESC \
      if (nextCh === ']') {
        let j = i + 2
        while (j < input.length && input[j] !== '\x07' && !(input[j] === '\x1b' && input[j + 1] === '\\')) j++
        if (input[j] === '\x1b') j += 2
        else j += 1
        i = j
        continue
      }

      // 其它两字节 ESC 序列（如 ESC ( B）
      i += 2
      continue
    }

    // 退格：删除前一个字符（进度条效果）
    if (ch === '\b') {
      buf = buf.slice(0, -1)
      i++
      continue
    }

    // 回车：回到行首——历史输出里通常用于覆盖上一行，简单丢弃
    if (ch === '\r') {
      i++
      continue
    }

    buf += ch
    i++
  }
  flush()
  return out.filter((s) => s.text.length > 0)
}

/** 是否包含 ANSI 转义码（用于快速判断） */
export function hasAnsi(s: string): boolean {
  return s.includes('\x1b[') || s.includes('\x1b]')
}
