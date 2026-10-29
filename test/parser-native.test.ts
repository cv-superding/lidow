import { describe, expect, it } from 'vitest'
import { parseToolCalls } from '@main/bridge/parser'

/**
 * 平台原生工具调用方言的解析。
 * 夹具直接取自用户实测截图里 DeepSeek 输出的原文（含全角竖线、缺失斜杠的闭合标签）。
 */
describe('parseToolCalls: 平台原生方言', () => {
  it('解析 DeepSeek DSML 的完整 calls（截图原始格式）', () => {
    const reply = [
      '我来创建这个文件。',
      '',
      '<｜｜DSML｜｜calls>',
      '<｜｜DSML｜｜invoke name="write">',
      '<｜｜DSML｜｜parameter name="path" string="true">pelican-bike.html</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="content" string="true"><!DOCTYPE html>',
      '<html lang="zh-CN"><head><meta charset="UTF-8"></head></html></｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜calls>'
    ].join('\n')

    const parsed = parseToolCalls(reply)
    expect(parsed.calls).toHaveLength(1)
    expect(parsed.calls[0]!.name).toBe('write')
    expect(parsed.calls[0]!.input.path).toBe('pelican-bike.html')
    expect(String(parsed.calls[0]!.input.content)).toContain('<!DOCTYPE html>')
    expect(parsed.native).toBe(true)
    // 正文里必须不残留任何方言标记，否则界面就是一屏乱码
    expect(parsed.cleanText).toBe('我来创建这个文件。')
    expect(parsed.cleanText).not.toContain('DSML')
    expect(parsed.cleanText).not.toContain('invoke')
  })

  it('多个 invoke 依次解析', () => {
    const reply = [
      '<｜｜DSML｜｜calls>',
      '<｜｜DSML｜｜invoke name="read">',
      '<｜｜DSML｜｜parameter name="path" string="true">a.txt</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="bash">',
      '<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜calls>'
    ].join('\n')

    const parsed = parseToolCalls(reply)
    expect(parsed.calls.map((c) => c.name)).toEqual(['read', 'bash'])
    expect(parsed.calls[1]!.input.command).toBe('ls -la')
  })

  it('string="false" 的参数按 JSON 字面量解析', () => {
    const reply = [
      '<｜｜DSML｜｜calls>',
      '<｜｜DSML｜｜invoke name="todoWrite">',
      '<｜｜DSML｜｜parameter name="items" string="false">[{"id":"1","status":"pending"}]</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜calls>'
    ].join('\n')

    const parsed = parseToolCalls(reply)
    expect(parsed.calls).toHaveLength(1)
    expect(Array.isArray(parsed.calls[0]!.input.items)).toBe(true)
  })

  it('流被截断（没有闭合标签）也不把标签糊在正文里', () => {
    const reply = '开始写文件\n<｜｜DSML｜｜calls>\n<｜｜DSML｜｜invoke name="write">\n<｜｜DSML｜｜parameter name="path">a.txt'
    const parsed = parseToolCalls(reply)
    expect(parsed.cleanText).toBe('开始写文件')
    expect(parsed.cleanText).not.toContain('DSML')
  })

  it('通用 XML invoke（无 DSML 标记）也能识别', () => {
    const reply = [
      '处理中：',
      '<invoke name="write">',
      '<parameter name="path">x.md</parameter>',
      '<parameter name="content"># 标题</parameter>',
      '</invoke>'
    ].join('\n')

    const parsed = parseToolCalls(reply)
    expect(parsed.calls).toHaveLength(1)
    expect(parsed.calls[0]!.name).toBe('write')
    expect(parsed.calls[0]!.input.content).toBe('# 标题')
  })

  it('lidow 协议块优先，且不受方言逻辑干扰', () => {
    const reply = '```lidow\n{"tool":"read","input":{"path":"a.txt"}}\n```'
    const parsed = parseToolCalls(reply)
    expect(parsed.calls).toHaveLength(1)
    expect(parsed.native).toBeUndefined()
    expect(parsed.cleanText).toBe('')
  })

  it('参数写在顶层（模型偷懒写法）：{"tool":"bash","command":"ls -la"}', () => {
    // 实测高频形态：AI 不写 input 包裹，直接把参数放顶层。
    // 只认 obj.input 会得到空参数 —— 确认框显示「执行命令：$」而后什么都没有
    const parsed = parseToolCalls(['```lidow', '{"tool":"bash","command":"ls -la"}', '```'].join('\n'))
    expect(parsed.calls).toHaveLength(1)
    expect(parsed.calls[0]!.name).toBe('bash')
    expect(parsed.calls[0]!.input).toEqual({ command: 'ls -la' })
  })

  it('input 与顶层混用时优先 input', () => {
    const parsed = parseToolCalls(['```lidow', '{"tool":"read","input":{"path":"a.txt"},"extra":1}', '```'].join('\n'))
    expect(parsed.calls[0]!.input).toEqual({ path: 'a.txt' })
  })

  it('普通文本回复完全不受影响', () => {
    const reply = '这个项目用了 React 和 TypeScript，入口在 src/main.tsx。'
    const parsed = parseToolCalls(reply)
    expect(parsed.calls).toHaveLength(0)
    expect(parsed.cleanText).toBe(reply)
  })
})
