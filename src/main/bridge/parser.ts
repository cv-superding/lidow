import { nanoid } from 'nanoid'
import type { ToolCall } from '@shared/types'

export interface ParsedReply {
  /** 去除工具调用块后的纯回复文本（展示用） */
  cleanText: string
  calls: ToolCall[]
  /** 解析失败但存在块时的原始内容，用于提示用户手动解析 */
  malformed: string[]
}

const FENCE_RE = /```(?:lidow|tool)(?:\w*)\s*\n([\s\S]*?)```/g

/**
 * 解析 AI 回复中的工具调用代码块：
 *   ```lidow
 *   {"tool": "write", "input": {"path": "a.txt", "content": "…"}}
 *   ```
 * 兼容多块、容忍尾部逗号；解析失败的块归入 malformed 提示。
 */
export function parseToolCalls(reply: string): ParsedReply {
  const calls: ToolCall[] = []
  const malformed: string[] = []
  let clean = reply

  for (const m of reply.matchAll(FENCE_RE)) {
    const raw = m[1] ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      try {
        // 容忍尾逗号
        parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))
      } catch {
        malformed.push(raw.slice(0, 500))
        clean = clean.replace(m[0], '')
        continue
      }
    }
    const obj = parsed as Record<string, unknown>
    const name = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' ? obj.name : null
    if (!name) {
      malformed.push(raw.slice(0, 500))
      clean = clean.replace(m[0], '')
      continue
    }
    const input = (obj.input ?? obj.args ?? {}) as Record<string, unknown>
    calls.push({ id: `call_${nanoid(8)}`, name, input })
    clean = clean.replace(m[0], '')
  }

  return { cleanText: clean.trim(), calls, malformed }
}

/** 构造给 AI 的观察结果消息 */
export function formatObservations(results: { name: string; ok: boolean; output: string; error?: string }[]): string {
  const body = results
    .map((r) => `【工具 ${r.name} → ${r.ok ? '成功' : '失败'}】\n${r.error ? `错误: ${r.error}\n` : ''}${r.output}`)
    .join('\n\n')
  return `${body}\n\n（以上是真实的工具执行结果，请基于它继续工作；任务未完成则继续调用工具，已全部完成则给出最终答复。）`
}

/** 系统提示词核心：工具协议说明（实现在 prompt/protocol.ts，此处保留兼容导出） */
export { protocolPrompt as toolProtocolPrompt } from '@main/prompt/protocol'

