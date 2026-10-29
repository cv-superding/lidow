/**
 * 正文清理：把工具调用痕迹从给用户看的文本里剔除。
 *
 * 与 main/bridge/parser 的 cleanText 保持一致，但用途不同：
 * 那边是"执行前提取调用"，这边是"渲染前清干净"。渲染侧必须独立一份，
 * 因为历史消息是修复前入库的，正文里就带着整段 DSML 标签。
 */

/** 代码围栏：语言标记可能被 DOM 抓取污染（如 `lidow复制下载{"tool":…}`），按内容再判一次 */
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g

/** DSML 标记（全角竖线，可能带空格） */
const DSML_MARK_RE = /\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*/gi

export function stripToolArtifacts(text: string): string {
  let out = text.replace(FENCE_RE, (whole, body: string) => {
    if (/^```(?:lidow|tool)/i.test(whole)) return ''
    // 普通代码围栏里带 tool JSON 也要删（DOM 抓取会把代码块头部的
    // 「lidow + 复制/下载」混进内容，语言标记因此丢失）
    return /"tool"\s*:/.test(body) ? '' : whole
  })
  // DSML 或通用 XML invoke/calls 都要清。DSML 一旦出现，它之后基本都是调用数据
  // （参数里可能裹着整份 HTML），从标记处截断，避免把参数内容当正文渲染出来。
  const hasDsml = new RegExp(DSML_MARK_RE.source, 'i').test(out)
  if (hasDsml) out = out.replace(DSML_MARK_RE, '')
  if (hasDsml || /<calls\b|<invoke\s+name\s*=/i.test(out)) {
    const at = out.search(/<calls\b|<invoke\s+name\s*=/i)
    if (at >= 0) out = out.slice(0, at)
    out = out.replace(/<\/?calls>/gi, '').replace(/<invoke[\s\S]*$/i, '')
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
