import { nanoid } from 'nanoid'
import type { ToolCall } from '@shared/types'

export interface ParsedReply {
  /** 去除工具调用块后的纯回复文本（展示用） */
  cleanText: string
  calls: ToolCall[]
  /** 解析失败但存在块时的原始内容，用于提示用户手动解析 */
  malformed: string[]
  /** 本次是否消费了平台原生方言（DSML / XML invoke） */
  native?: boolean
}

const FENCE_RE = /```(?:lidow|tool)(?:\w*)\s*\n([\s\S]*?)```/g

/**
 * 平台原生工具调用方言的标记：DeepSeek 的 `<｜｜DSML｜｜calls>` 用全角竖线，
 * 也有模型退回通用 `<invoke name="…">`。标记可能带空白（`< ｜ ｜ DSML ｜ ｜ calls>`），
 * 且闭合标签经常缺斜杠（实测 `<｜｜DSML｜｜parameter>` 既是开也是闭），
 * 所以不能按标准 XML 解析，只能按标签顺序扫描。
 */
const DSML_MARK_RE = /\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*/gi

/** 去掉标记后的单个标签：<(/)invoke|parameter|calls 属性> */
const NATIVE_TAG_RE = /<(\/?)(invoke|parameter|calls)\b([^>]*)>/gi

function attrValue(attrs: string, key: string): string | null {
  const m = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  if (!m) return null
  return (m[1] ?? m[2] ?? m[3] ?? '').trim()
}

/**
 * 解析平台原生工具调用方言。
 *
 * 为什么必须自己做：网页版 AI 一旦没按 lidow 协议输出，就会退回它自己的
 * 服务端方言（DeepSeek 的 DSML）。这段文本会被网页渲染成一堆标签"乱码"，
 * 而工具一个都不会执行 —— 用户看到的就是「AI 吐了一屏乱码，然后什么都没发生」。
 *
 * @returns 命中的调用、剔除方言后的干净文本、是否检测到方言
 */
export function parseNativeCalls(reply: string): { calls: ToolCall[]; cleanText: string; hit: boolean } {
  const hasMark = new RegExp(DSML_MARK_RE.source, 'i').test(reply)
  if (!hasMark && !/<invoke\s+name\s*=/i.test(reply)) return { calls: [], cleanText: reply, hit: false }

  // 归一化标记：`< ｜ ｜ DSML ｜ ｜ invoke name="x">` → `<invoke name="x">`
  const s = reply.replace(DSML_MARK_RE, '')
  const calls: ToolCall[] = []
  let cur: { name: string; input: Record<string, unknown> } | null = null
  let param: { key: string; asJson: boolean; value: string } | null = null
  let dirtyStart = -1
  let dirtyEnd = -1

  const flushParam = (): void => {
    if (!cur || !param) return
    const target = cur
    const p = param
    param = null
    const raw = p.value.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    if (p.asJson) {
      try {
        target.input[p.key] = JSON.parse(raw)
        return
      } catch {
        /* 声明是 JSON 但解析失败：按原文保留，别丢内容 */
      }
    }
    target.input[p.key] = raw
  }
  const flushCall = (): void => {
    flushParam()
    if (cur && cur.name) calls.push({ id: `call_${nanoid(8)}`, name: cur.name, input: cur.input })
    cur = null
  }

  NATIVE_TAG_RE.lastIndex = 0
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = NATIVE_TAG_RE.exec(s)) !== null) {
    // 两个标签之间的纯文本：参数还没闭合就属于参数值
    const between = s.slice(lastEnd, m.index)
    if (param) param.value += between
    lastEnd = m.index + m[0].length

    const closing = m[1] === '/'
    const tag = (m[2] ?? '').toLowerCase()
    const attrs = m[3] ?? ''
    if (dirtyStart < 0) dirtyStart = m.index
    dirtyEnd = lastEnd

    if (tag === 'calls') {
      flushCall()
      continue
    }
    if (tag === 'invoke') {
      flushCall()
      if (closing) continue
      const name = attrValue(attrs, 'name')
      if (name) cur = { name, input: {} }
      continue
    }
    // parameter：无论是开还是闭（方言里闭合常缺斜杠），都先结算上一个参数
    flushParam()
    if (closing) continue
    const key = attrValue(attrs, 'name')
    if (!key) continue
    param = { key, asJson: /string\s*=\s*["']?false/i.test(attrs), value: '' }
  }
  flushCall()

  // 剥掉方言段。没有闭合标签时（流被截断）参数值会落在最后一个标签之后，
  // 因此截断到行尾整段丢弃，不把残余的 a.txt 之类漏进正文。
  // 整段闭合（</calls> 或 </invoke> 在场）→ 只删方言区间，块后正文保留；
  // 未闭合（流被截断）→ 从标记处截到结尾，参数残余不再漏进正文。
  const wholeClosed = /<\/\s*calls\s*>/i.test(s) || /<\/\s*invoke\s*>/i.test(s)
  let rest = s
  if (dirtyStart >= 0 && !wholeClosed) {
    rest = s.slice(0, dirtyStart)
  } else if (dirtyStart >= 0 && dirtyEnd > dirtyStart) {
    rest = s.slice(0, dirtyStart) + s.slice(dirtyEnd)
  }
  const clean = rest.replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleanText: clean, hit: true }
}

/**
 * 解析 AI 回复中的工具调用。
 *
 * 两条通路：
 *  1. lidow 协议 —— ```lidow 代码块内是 JSON（首选，协议文档要求的形式）
 *  2. 平台原生方言 —— DSML / 通用 XML invoke（模型跑偏时的兜底，见 parseNativeCalls）
 *
 * 能在本地还原的方言直接执行，比"让 AI 重写一遍"省一轮往返；
 * 完全无法识别时才交给调用方发格式纠偏提示。
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
    // 参数来源（按优先级）：
    //  1) input / args 字段（协议规定的写法）
    //  2) 顶层剩余字段 —— 模型经常偷懒写成 {"tool":"bash","command":"ls -la"}，
    //     只认 input 会解析出空参数：确认框里命令是空的、工具执行无输入
    let input = (obj.input ?? obj.args ?? null) as Record<string, unknown> | null
    if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
      const extra: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'tool' || k === 'name' || k === 'input' || k === 'args' || k === 'id') continue
        extra[k] = v
      }
      input = Object.keys(extra).length > 0 ? extra : {}
    }
    calls.push({ id: `call_${nanoid(8)}`, name, input })
    clean = clean.replace(m[0], '')
  }

  if (calls.length > 0) return { cleanText: clean.trim(), calls, malformed }

  // lidow 协议没命中 → 看是不是平台原生方言
  const native = parseNativeCalls(clean)
  if (native.calls.length > 0) {
    return { cleanText: native.cleanText, calls: native.calls, malformed, native: true }
  }
  // 方言标记存在但没提取出调用：把方言块也剔掉，至少不让它糊在正文里
  if (native.hit) return { cleanText: native.cleanText, calls: [], malformed, native: true }

  return { cleanText: clean.trim(), calls, malformed }
}

/**
 * 识别「AI 有工具意图但格式不对」的回复。
 * 网页版 AI 不知道 lidow 协议时常见的野生格式：
 *   <write><path>a.txt</path><content>x</content></write>
 *   <｜tool▁calls｜> / <invoke name="write">…（DeepSeek 原生 DSML）
 *   纯 JSON 代码块 {"tool":"write","input":{…}}
 * 命中说明它想调工具、只是格式被拒 —— 值得用系统提示词纠一轮，
 * 而不是当普通闲聊忽略（用户会以为「AI 根本没动手」）。
 */
const WILD_TOOL_RE =
  /<\s*(?:[\w-]+:)?(?:invoke|parameter)\s+name=|<[ \t]*｜｜DSML｜｜|<\s*(write|read|edit|glob|grep|bash|pwsh|delete|webFetch|todoWrite)\b[^>]*>|["'](?:tool|name)["']\s*:\s*["'](?:write|read|edit|glob|grep|bash|pwsh|delete|webFetch|todoWrite)["']/i

export function looksLikeWildToolIntent(reply: string): boolean {
  return WILD_TOOL_RE.test(reply)
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

