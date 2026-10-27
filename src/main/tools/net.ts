import { assertSafeUrl } from '@main/security/ssrf'
import type { ToolDef } from './types'
import { clampOutput, num, str } from './types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Lidow/0.1'

/** 手写 HTML→文本（避免重依赖）：去 script/style、块级标签换行、解常见实体 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** fetch 跟随重定向但每一跳都重新做 SSRF 校验（防止重定向绕过） */
async function safeFetch(rawUrl: string, ctxSettings: { ssrfProtection: boolean }, init?: RequestInit, depth = 0): Promise<Response> {
  if (ctxSettings.ssrfProtection) await assertSafeUrl(rawUrl)
  const res = await fetch(rawUrl, { ...init, redirect: 'manual', headers: { 'User-Agent': UA, ...(init?.headers ?? {}) } })
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location')
    if (loc && depth < 5) {
      return safeFetch(new URL(loc, rawUrl).toString(), ctxSettings, init, depth + 1)
    }
  }
  return res
}

export const webFetchTool: ToolDef = {
  name: 'webFetch',
  description: '抓取网页并转为纯文本。默认开启 SSRF 防护（拦截私网/回环/元数据地址）。',
  parameters: { url: { type: 'string', description: 'http(s) URL', required: true } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const url = str(input, 'url')
    try {
      const res = await safeFetch(url, ctx.settings, { signal: AbortSignal.timeout(20_000) })
      const ct = res.headers.get('content-type') ?? ''
      const body = await res.text()
      const text = ct.includes('html') ? htmlToText(body) : body
      return { ok: res.ok, output: clampOutput(`[HTTP ${res.status}] ${url}\n\n${text}`, ctx.settings.outputBufferLimit), error: res.ok ? undefined : `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, output: '', error: `抓取失败: ${String(e)}` }
    }
  }
}

const SEARCH_ENGINES: { name: string; build: (q: string) => string; extract: (html: string) => string }[] = [
  {
    name: 'duckduckgo',
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    extract: (html) => {
      const results: string[] = []
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && results.length < 8) {
        const title = m[2]!.replace(/<[^>]+>/g, '').trim()
        let url = m[1]!
        const uddg = /uddg=([^&]+)/.exec(url)
        if (uddg) url = decodeURIComponent(uddg[1]!)
        results.push(`${title}\n  ${url}`)
      }
      return results.join('\n')
    }
  },
  {
    name: 'bing',
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans`,
    extract: (html) => {
      const results: string[] = []
      const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && results.length < 8) {
        results.push(`${m[2]!.replace(/<[^>]+>/g, '').trim()}\n  ${m[1]!}`)
      }
      return results.join('\n')
    }
  }
]

export const webSearchTool: ToolDef = {
  name: 'webSearch',
  description: '联网搜索（来自 lingya 的能力）。返回标题与链接列表，可用 webFetch 深入阅读。',
  parameters: { query: { type: 'string', description: '搜索关键词', required: true } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const query = str(input, 'query')
    for (const engine of SEARCH_ENGINES) {
      try {
        const res = await safeFetch(engine.build(query), ctx.settings, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) continue
        const html = await res.text()
        const extracted = engine.extract(html)
        if (extracted.trim()) {
          return { ok: true, output: `[搜索引擎: ${engine.name}]\n${extracted}` }
        }
      } catch {
        continue
      }
    }
    return { ok: false, output: '', error: '所有搜索引擎均失败，可尝试 webFetch 直接访问' }
  }
}

export const todoWriteTool: ToolDef = {
  name: 'todoWrite',
  description: '维护人机共用的任务看板（项目 .lidow/todos.json，用户在「任务」视图同步可见）。每次传入完整清单。',
  parameters: { todos: { type: 'string', description: 'JSON 数组字符串：[{"title":"…","status":"pending|running|done"}]', required: true } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const raw = str(input, 'todos')
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not array')
      const items = parsed.map((t) => {
        const o = t as Record<string, unknown>
        const st = String(o.status ?? 'pending')
        return {
          title: String(o.title ?? ''),
          status: (['pending', 'running', 'done', 'failed', 'skipped'].includes(st) ? st : 'pending') as 'pending'
        }
      })
      const { TodoBoard } = await import('@main/ecosystem/todos')
      const saved = new TodoBoard(ctx.projectRoot).replace(items)
      ctx.audit?.('tool', 'todoWrite 更新任务看板', { count: saved.length })
      return { ok: true, output: `任务看板已更新（${saved.length} 项，用户可在「任务」视图实时看到）：\n${saved.map((t) => `- ${t.status} ${t.title}`).join('\n')}` }
    } catch (e) {
      return { ok: false, output: '', error: `todos 必须是 JSON 数组: ${String(e)}` }
    }
  }
}

export const injectJsTool: ToolDef = {
  name: 'injectJS',
  description: '在当前 AI 网页中执行 JS 并返回结果（页面自动化/调试用）。需确认。',
  parameters: { code: { type: 'string', description: 'JS 代码（求值表达式）', required: true } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    if (!ctx.injectJs) return { ok: false, output: '', error: '当前没有可注入的网页' }
    const ok = await ctx.confirm(`在网页中执行 JS：${str(input, 'code').slice(0, 120)}`)
    if (!ok) return { ok: false, output: '', error: '用户拒绝执行' }
    try {
      const result = await ctx.injectJs(str(input, 'code'))
      return { ok: true, output: clampOutput(typeof result === 'string' ? result : JSON.stringify(result), num(input, '_limit', 8000)) }
    } catch (e) {
      return { ok: false, output: '', error: String(e) }
    }
  }
}
