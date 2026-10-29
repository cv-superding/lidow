import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHookSource, DEEPSEEK_HOOK } from '@main/providers/hooks'
import { parseToolCalls } from '@main/bridge/parser'

/**
 * 用真实的 buildHookSource 产物在 Node 里跑一遍注入脚本。
 * 注入源必须能在无 DOM 环境下执行（只用到 fetch/XHR/TextDecoder），
 * 因此这里用一个最小的假 window 让它跑起来，再把 SSE 按任意边界切片喂进去。
 */
interface Captured {
  response: { text: string; finished: boolean }[]
  errors: { text: string; reason: string }[]
  streams: string[]
  thinks: string[]
}

const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/deepseek-sse.txt'), 'utf8')

/** 按固定字节数切片，帧必然被切断（模拟真实网络的任意分块） */
function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** 在假 window 上执行 hook 源码，返回捕获到的事件 */
function runHook(sseText: string, chunkSize: number): Promise<Captured> {
  const captured: Captured = { response: [], errors: [], streams: [], thinks: [] }
  const bridge = {
    emit(kind: string, detail: { text?: string; finished?: boolean; reason?: string; think?: string }): void {
      if (kind === 'response') captured.response.push({ text: detail.text ?? '', finished: !!detail.finished })
      else if (kind === 'error') captured.errors.push({ text: detail.text ?? '', reason: detail.reason ?? '' })
      else if (kind === 'stream') {
        captured.streams.push(detail.text ?? '')
        captured.thinks.push(detail.think ?? '')
      }
    }
  }

  // 假 fetch：返回一个按 chunkSize 分块的 ReadableStream
  const pieces = chunk(sseText, chunkSize)
  const responseBody = {
    getReader() {
      let i = 0
      return {
        read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (i >= pieces.length) return Promise.resolve({ done: true })
          const value = new TextEncoder().encode(pieces[i++]!)
          return Promise.resolve({ done: false, value })
        }
      }
    }
  }
  const fakeFetch = (): Promise<{ body: unknown; clone(): { body: unknown } }> => {
    const resp = { body: responseBody, clone: () => resp }
    return Promise.resolve(resp)
  }

  // hook 只用这些全局量；XHR 用不到（本用例走 fetch 分支），给个空壳即可
  const xhrProto = { open(): void {}, send(): void {}, addEventListener(): void {} }

  const sandboxWindow = { fetch: fakeFetch, __lidowNet: bridge } as Record<string, unknown>
  const fn = new Function(
    'window',
    'XMLHttpRequest',
    'TextDecoder',
    'TextEncoder',
    'setInterval',
    'clearInterval',
    'Date',
    buildHookSource(DEEPSEEK_HOOK)
  )

  fn(sandboxWindow, { prototype: xhrProto } as unknown, TextDecoder, TextEncoder, () => 0, () => undefined, Date)

  // 触发被 hook 的 fetch；返回 promise 以便等待流读完
  const hooked = sandboxWindow.fetch as (url: string, init: unknown) => Promise<unknown>
  return hooked('/api/v0/chat/completion', { method: 'POST' }).then(
    () =>
      new Promise<Captured>((done) => {
        // 流是异步读的：轮询等 response/error 落地
        const started = Date.now()
        const tick = (): void => {
          if (captured.response.length > 0 || captured.errors.length > 0 || Date.now() - started > 4000) done(captured)
          else setTimeout(tick, 20)
        }
        tick()
      })
  )
}

describe('DeepSeek hook 注入源码', () => {
  it('String.raw 模板里的换行正则必须是单反斜杠', () => {
    // 双反斜杠在 String.raw 下会变成字面 \r\n 字符，永远匹配不到真实换行
    const src = buildHookSource(DEEPSEEK_HOOK)
    expect(src).not.toMatch(/split\(\/\\\\r/)
    expect(src).not.toMatch(/\/\\\\r\\\\n\|/)
  })

  it('按 7 字节碎片投喂也能还原完整回复', async () => {
    const r = await runHook(FIXTURE, 7)
    expect(r.errors).toHaveLength(0)
    expect(r.response).toHaveLength(1)
    const text = r.response[0]!.text
    expect(text).toContain('```lidow')
    expect(text).toContain('"tool"')
    expect(text).toContain('hello.txt')
    expect(text).toContain('OK')
    // 收尾围栏与换行都不能丢，否则解析器认不出块
    expect(text.trimEnd().endsWith('```')).toBe(true)
    expect(text).toContain('\n')
  })

  it('整块投喂与碎片投喂结果一致（帧解码不依赖分块边界）', async () => {
    const whole = await runHook(FIXTURE, FIXTURE.length)
    const tiny = await runHook(FIXTURE, 7)
    expect(tiny.response[0]!.text).toBe(whole.response[0]!.text)
  })

  it('思考片段不混进正文（同一路径 /fragments/-1/content 靠类型区分）', async () => {
    // 真实形态：先下发含 type 的 fragments 快照，之后增量补丁只给
    // response/fragments/-1/content —— 不带类型。若不记住类型表，
    // 思考内容会被当成正文整段显示（用户实测：思考过程出现在气泡里）
    const sse = [
      'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"我先想想"}]}}}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，这里要小心"}',
      '',
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"正文回答"}]}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，继续"}',
      '',
      'data: {"p":"response/status","v":"FINISHED"}',
      ''
    ].join('\n\n')
    const cap = await runHook(sse, 32)
    expect(cap.response).toHaveLength(1)
    const text = cap.response[0]!.text
    // 思考内容绝不能出现在正文里
    expect(text).not.toContain('我先想想')
    expect(text).not.toContain('这里要小心')
    // 正文要完整
    expect(text).toContain('正文回答')
    expect(text).toContain('继续')
  })

  it('重复快照不能清空类型表（思考内容不许漏进正文）', async () => {
    // 回归：此前每次快照都清空 fragmentTypes，后续的增量补丁无类型可查，
    // THINK 的内容被当成 RESPONSE 整段漏进气泡（用户实测）。
    const sse = [
      'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"用户说"}]}}}',
      '',
      'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"用户说，先看文件"}]}}}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，再回答"}',
      '',
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"正文回答"}]}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，结尾"}',
      '',
      'data: {"p":"response/status","v":"FINISHED"}',
      ''
    ].join('\n\n')
    const cap = await runHook(sse, 32)
    expect(cap.response).toHaveLength(1)
    const text = cap.response[0]!.text
    expect(text).toBe('正文回答，结尾')
    expect(text).not.toContain('用户说')
    const think = cap.thinks[cap.thinks.length - 1] ?? ''
    expect(think).toBe('用户说，先看文件，再回答')
  })

  it('hook 提取的文本能被工具解析器解析出 write 调用', async () => {
    const r = await runHook(FIXTURE, 7)
    const parsed = parseToolCalls(r.response[0]!.text)
    expect(parsed.malformed).toHaveLength(0)
    expect(parsed.calls).toHaveLength(1)
    expect(parsed.calls[0]!.name).toBe('write')
    expect(parsed.calls[0]!.input).toMatchObject({ path: 'hello.txt' })
    expect(String((parsed.calls[0]!.input as { content?: string }).content).trim()).toBe('OK')
  })
})

describe('请求体系统提示词注入', () => {
  /** 用假 XHR 跑 hook，返回原始 send 收到的 body */
  function runXhr(sysPrompt: string, userBody: string): string {
    let capturedBody = ''
    const proto = {
      open(): void {},
      send(this: unknown, body?: string): void {
        capturedBody = body ?? ''
      },
      addEventListener(): void {}
    }
    const sandboxWindow = { fetch: () => Promise.resolve({}), __lidowNet: { emit: () => undefined } } as Record<
      string,
      unknown
    >
    const fn = new Function(
      'window',
      'XMLHttpRequest',
      'TextDecoder',
      'TextEncoder',
      'setInterval',
      'clearInterval',
      'Date',
      buildHookSource(DEEPSEEK_HOOK, sysPrompt)
    )
    fn(sandboxWindow, { prototype: proto } as unknown, TextDecoder, TextEncoder, () => 0, () => undefined, Date)

    const xhr = Object.create(proto) as { open(m: string, u: string): void; send(b: string): void }
    xhr.open('POST', '/api/v0/chat/completion')
    xhr.send(userBody)
    return capturedBody
  }

  it('网页里自己发送时，系统提示词被拼进 prompt 字段', () => {
    const sys = '# 身份\n你是 Lidow 的 Agent，工作目录是 D:/proj'
    const out = runXhr(sys, JSON.stringify({ prompt: '建个文件', chat_session_id: 'x' }))
    const obj = JSON.parse(out) as { prompt: string; chat_session_id: string; parent_message_id?: number }
    expect(obj.prompt.startsWith('# 身份')).toBe(true)
    expect(obj.prompt).toContain('建个文件')
    // 其它字段必须原样保留，否则 DeepSeek 会话会断
    expect(obj.chat_session_id).toBe('x')
  })

  it('已经带系统提示词的请求不会被重复注入', () => {
    const sys = '# 身份\n你是 Lidow 的 Agent，工作目录是 D:/proj'
    const out = runXhr(sys, JSON.stringify({ prompt: sys + '\n\n---\n\n# 用户任务\n\n建个文件' }))
    const obj = JSON.parse(out) as { prompt: string }
    expect(obj.prompt.indexOf('# 身份')).toBe(0)
    expect(obj.prompt.match(/# 身份/g)).toHaveLength(1)
  })

  it('系统提示词为空时不改动请求体', () => {
    const raw = JSON.stringify({ prompt: '建个文件' })
    expect(runXhr('', raw)).toBe(raw)
  })
})

describe('上下文耗尽检测（cuckoo banner_info 同款）', () => {
  it('INCOMPLETE 终态 → error/reason=incomplete（DeepSeek 截断）', async () => {
    const sse = [
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"回答前半"}]}',
      '',
      'data: {"p":"response/status","v":"INCOMPLETE"}',
      ''
    ].join('\n\n')
    const cap = await runHook(sse, 64)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]!.reason).toBe('incomplete')
  })
})
