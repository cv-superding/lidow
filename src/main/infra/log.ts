import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'info' | 'warn' | 'error'

interface LogLine {
  ts: number
  level: Level
  tag: string
  msg: string
}

/** 环形内存日志 + 文件落盘，renderer 可查询最近日志 */
export class Logger {
  private static buffer: LogLine[] = []
  private static readonly max = 2000
  private static file: string | null = null

  static init(dir: string): void {
    this.file = join(dir, 'lidow.log')
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
        appendFileSync(this.file, text + '\n')
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
