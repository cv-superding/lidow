import { describe, expect, it } from 'vitest'
import { stripCitationMarkers, stripToolArtifacts } from '../src/renderer/src/textClean'

/**
 * 渲染侧清理：用户截图里的"乱码"就是整段 DSML 被当正文渲染。
 * 夹具取自真实回复，包含参数里裹着整份 HTML 的情形。
 */
describe('stripToolArtifacts', () => {
  it('剔除 DSML 整段调用，只留正文', () => {
    const text = [
      '我来创建这个文件。',
      '',
      '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="write"> <｜｜DSML｜｜ parameter name="path" string="true">pelican-bike.html</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="content" string="true"><!DOCTYPE html><html><body>鹈鹕</body></html></｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'
    ].join('\n')
    const out = stripToolArtifacts(text)
    expect(out).toBe('我来创建这个文件。')
    expect(out).not.toContain('DSML')
    expect(out).not.toContain('DOCTYPE')
  })

  it('剔除 ¶lidow 工具块', () => {
    const text = '好的，写入：\n```lidow\n{"tool":"write","input":{"path":"a.txt"}}\n```\n完成。'
    const out = stripToolArtifacts(text)
    expect(out).toContain('好的，写入：')
    expect(out).toContain('完成。')
    expect(out).not.toContain('"tool"')
  })

  it('语言标记被 DOM 污染（lidow复制下载）的代码块也要剔除', () => {
    const text = '结果：\n```\nlidow复制下载{"tool": "bash", "command": "ls"}\n```\n完成。'
    const out = stripToolArtifacts(text)
    expect(out).toContain('结果：')
    expect(out).toContain('完成。')
    expect(out).not.toContain('"tool"')
    expect(out).not.toContain('复制下载')
  })

  it('普通文本保持原样', () => {
    const text = '这个项目的主入口在 src/main.tsx，用到了 React 18。'
    expect(stripToolArtifacts(text)).toBe(text)
  })

  it('参数里的大段 HTML 不会漏进正文', () => {
    const text = '生成中\n<｜｜DSML｜｜invoke name="write"><｜｜DSML｜｜parameter name="content"><div>这里是页面内容</div>'
    const out = stripToolArtifacts(text)
    expect(out).toBe('生成中')
    expect(out).not.toContain('页面内容')
  })

  it('通用 XML invoke（无 DSML 标记）也会被清掉', () => {
    const text = '处理：\n<calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></calls>'
    const out = stripToolArtifacts(text)
    expect(out).toBe('处理：')
  })
})

describe('stripCitationMarkers', () => {
  it('剔除 DeepSeek 搜索引用角标，保留正文', () => {
    expect(stripCitationMarkers('晴到晴间多云，白天回暖尚可，夜间降温快[reference:0]。')).toBe(
      '晴到晴间多云，白天回暖尚可，夜间降温快。'
    )
    expect(stripCitationMarkers('风力 3~4 级[reference:4]，空气质量良[reference:5]。')).toBe(
      '风力 3~4 级，空气质量良。'
    )
  })

  it('没有角标时保持原样', () => {
    const text = '这个项目的主入口在 src/main.tsx。'
    expect(stripCitationMarkers(text)).toBe(text)
  })

  it('历史轮次正文后又粘进整段已思考快照时，只保留正文', () => {
    const text =
      '济南今天晴，11~23℃。\n\n提醒：早晚温差大。\n已思考（用时 10 秒）搜索到 12 个网页济南今天晴，11~23℃。提醒：早晚温差大。'
    expect(stripCitationMarkers(text)).toBe('济南今天晴，11~23℃。\n\n提醒：早晚温差大。')
  })
})
