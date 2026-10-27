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
  return results
    .map((r) => `【工具 ${r.name} → ${r.ok ? '成功' : '失败'}】\n${r.error ? `错误: ${r.error}\n` : ''}${r.output}`)
    .join('\n\n')
}

/** 系统提示词核心：工具协议说明 */
export function toolProtocolPrompt(tools: string): string {
  return `你是运行在 Lidow 桌面端中的 AI Agent，运行在用户的 AI 网页会话内，可以调用本地工具完成真实操作。

## 工具调用协议
需要调用工具时，输出如下代码块（可一次输出多个）：
\`\`\`lidow
{"tool": "工具名", "input": { 参数对象 }}
\`\`\`
- 系统会执行工具并把结果作为下一条消息回传给你（观察），然后你继续。
- 所有工具执行完毕、任务完成后，输出不含工具块的最终答复。
- 文本回答用 Markdown；不要在工具块外编造执行结果。

## 可用工具
${tools}

## 约束
- 文件操作一律使用项目内相对路径
- 危险命令会请求用户确认，被拒绝时调整方案而不是重试原命令
- 长任务先输出简短计划，再逐步执行`
}
