import { describe, expect, it } from 'vitest'
import { formatObservations, parseToolCalls, toolProtocolPrompt } from '@main/bridge/parser'

describe('parseToolCalls', () => {
  it('解析单工具块并清除原文', () => {
    const reply = `我先创建文件。\n\`\`\`lidow\n{"tool":"write","input":{"path":"a.txt","content":"hi"}}\n\`\`\`\n完成。`
    const r = parseToolCalls(reply)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.name).toBe('write')
    expect(r.calls[0]!.input).toEqual({ path: 'a.txt', content: 'hi' })
    expect(r.cleanText).toContain('完成。')
    expect(r.cleanText).not.toContain('lidow')
  })

  it('解析多个工具块', () => {
    const reply = '```lidow\n{"tool":"read","input":{"path":"a"}}\n```\n中间文本\n```lidow\n{"tool":"glob","input":{"pattern":"**/*.ts"}}\n```'
    const r = parseToolCalls(reply)
    expect(r.calls.map((c) => c.name)).toEqual(['read', 'glob'])
    expect(r.malformed).toHaveLength(0)
  })

  it('容忍尾逗号', () => {
    const reply = '```lidow\n{"tool":"read","input":{"path":"a",}}\n```'
    const r = parseToolCalls(reply)
    expect(r.calls).toHaveLength(1)
  })

  it('兼容 tool/name 与 input/args 字段名', () => {
    expect(parseToolCalls('```lidow\n{"name":"read","args":{"path":"x"}}\n```').calls[0]!.name).toBe('read')
  })

  it('畸形 JSON 归入 malformed 并提示', () => {
    const reply = '```lidow\n{"tool":"read" "input":}\n```'
    const r = parseToolCalls(reply)
    expect(r.calls).toHaveLength(0)
    expect(r.malformed).toHaveLength(1)
  })

  it('无工具块的纯回复', () => {
    const r = parseToolCalls('# 标题\n\n正文内容')
    expect(r.calls).toHaveLength(0)
    expect(r.cleanText).toContain('正文内容')
  })

  it('拒绝缺少工具名的块', () => {
    const r = parseToolCalls('```lidow\n{"input":{}}\n```')
    expect(r.calls).toHaveLength(0)
    expect(r.malformed).toHaveLength(1)
  })
})

describe('formatObservations', () => {
  it('拼装成功与失败结果', () => {
    const text = formatObservations([
      { name: 'read', ok: true, output: 'file content' },
      { name: 'bash', ok: false, output: '', error: 'timeout' }
    ])
    expect(text).toContain('【工具 read → 成功】')
    expect(text).toContain('file content')
    expect(text).toContain('【工具 bash → 失败】')
    expect(text).toContain('错误: timeout')
  })
})

describe('toolProtocolPrompt', () => {
  it('包含工具清单', () => {
    const p = toolProtocolPrompt('- read(path): 读取文件')
    expect(p).toContain('```lidow')
    expect(p).toContain('- read(path): 读取文件')
    expect(p).toContain('观察')
  })
})

describe('protocolPrompt（升级后的系统提示词）', () => {
  it('包含协议关键段与自查清单', async () => {
    const { protocolPrompt } = await import('@main/prompt/protocol')
    const p = protocolPrompt('- read(path): 读取')
    expect(p).toContain('```lidow')
    expect(p).toContain('自查清单')
    expect(p).toContain('外科手术式')
    expect(p).toContain('先读后改')
    expect(p).toContain('- read(path): 读取')
    expect(p).toContain('禁忌')
  })
})
