import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'info' | 'warn' | 'error'

interface LogLine {
  ts: number
  level: Level
  tag: string
  msg: string
}

/** 单文件上限 8MB：超了滚动到 .1，防止长跑把日志刷成几百 MB 拖慢主进程 */
const MAX_BYTES = 8 * 1024 * 1024

/** 环形内存日志 + 文件落盘，renderer 可查询最近日志 */
export class Logger {
  private static buffer: LogLine[] = []
  private static readonly max = 2000
  private static file: string | null = null
  private static written = 0

  static init(dir: string): void {
    this.file = join(dir, 'lidow.log')
    try {
      // 启动时若已超限就直接滚走（兼容历史遗留的超大文件）
      const st = statSync(this.file)
      if (st.size > MAX_BYTES) {
        const old = this.file + '.1'
        try {
          unlinkSync(old)
        } catch {
          /* 不存在 */
        }
        renameSync(this.file, old)
        this.written = 0
      } else {
        this.written = st.size
      }
    } catch {
      this.written = 0
    }
  }

  private static rotate(): void {
    if (!this.file) return
    const old = this.file + '.1'
    try {
      try {
        unlinkSync(old)
      } catch {
        /* 不存在 */
      }
      renameSync(this.file, old)
    } catch {
      /* 滚动失败就继续追加，不阻塞主流程 */
    }
    this.written = 0
  }

  static log(level: Level, tag: string, msg: string): void {
    const line: LogLine = { ts: Date.now(), level, tag, msg }
    this.buffer.push(line)
    if (this.buffer.length > this.max) this.buffer.shift()
    const text = `[${new Date(line.ts).toISOString()}] [${level}] [${tag}] ${msg}`
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    if (this.file) {
      try {
        if (this.written > MAX_BYTES) this.rotate()
        appendFileSync(this.file, text + '\n')
        this.written += Buffer.byteLength(text) + 1
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  static info(tag: string, msg: string): void {
    this.log('info', tag, msg)
  }
  static warn(tag: string, msg: string): void {
    this.log('warn', tag, msg)
  }
  static error(tag: string, msg: string): void {
    this.log('error', tag, msg)
  }
  static recent(n = 200): LogLine[] {
    return this.buffer.slice(-n)
  }
}
