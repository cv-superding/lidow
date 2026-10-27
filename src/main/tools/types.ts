import type { ToolDisplay } from '@shared/types'

/** 工具执行上下文：由 Agent 循环注入 */
export interface ToolContext {
  /** 项目根目录（工具路径隔离基准） */
  projectRoot: string
  settings: {
    commandTimeoutMs: number
    sandboxTimeoutMs: number
    outputBufferLimit: number
    ssrfProtection: boolean
    dangerConfirm: boolean
  }
  /** 危险操作确认门（UI 二次确认），返回是否放行 */
  confirm: (reason: string) => Promise<boolean>
  /** 注入 JS 到当前网页（injectJS 工具用） */
  injectJs?: (code: string) => Promise<unknown>
  /** 审计记录回调 */
  audit?: (kind: 'file-write' | 'file-delete' | 'command' | 'tool', summary: string, detail: Record<string, unknown>, backupPath?: string) => void
}

export interface ToolOutput {
  ok: boolean
  output: string
  display?: ToolDisplay
  error?: string
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema 参数描述（拼进系统提示词） */
  parameters: Record<string, { type: string; description: string; required?: boolean }>
  dangerLevel: 'safe' | 'confirm'
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
}

export function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

export function num(input: Record<string, unknown>, key: string, dflt?: number): number {
  const v = input[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return dflt ?? 0
}

/** 截断超限输出，保护上下文与 UI */
export function clampOutput(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return text.slice(0, head) + `\n…[输出已截断，原始 ${text.length} 字符，保留首尾]…\n` + text.slice(-tail)
}
