/* eslint-disable @typescript-eslint/no-explicit-any -- 这段函数会被序列化进网页执行，只能用 any 操作宿主 DOM */
import type { WebContents } from 'electron'

/**
 * 在 DeepSeek 网页里尽力删除一条对话：
 * 按 providerUrl 里的 chat id 定位侧边栏行 → 打开 ⋯ 菜单 → 点「删除」→ 确认。
 * 平台 DOM 改版时返回失败原因，不影响本地会话删除。
 */
async function deepSeekDeleteScript(args: { url: string; title: string }): Promise<{ ok: boolean; reason?: string }> {
  const g = globalThis as any
  const doc = g.document
  if (!doc) return { ok: false, reason: '页面不可用' }
  const sleep = (ms: number) => new Promise((r) => g.setTimeout(r, ms))
  const text = (el: any) => String(el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el: any) => {
    try {
      const r = el.getBoundingClientRect()
      const s = g.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
    } catch {
      return false
    }
  }
  const match = String(args.url || '').match(/\/a\/chat\/s\/([0-9a-fA-F-]{8,})/)
  const id = match ? match[1] : ''
  if (!id) return { ok: false, reason: '无法从会话 URL 识别对话 ID' }

  const deadline = Date.now() + 6000
  let anchor: any = null
  while (Date.now() < deadline) {
    anchor = [...doc.querySelectorAll('a[href]')].find((a: any) => String(a.href).includes(id))
    if (anchor) break
    await sleep(150)
  }
  if (!anchor) return { ok: false, reason: '侧边栏未找到该对话（可能未展开或不在可视区）' }

  const findMenuButton = (): any => {
    let row = anchor
    for (let i = 0; i < 8 && row; i++) {
      const btns = [...row.querySelectorAll('button,[role="button"]')].filter(
        (b: any) => visible(b) && !b.contains(anchor) && !anchor.contains(b)
      )
      if (btns.length > 0) {
        const named = btns.find((b: any) =>
          /more|option|menu|更多|菜单|操作/i.test(`${b.getAttribute('aria-label') ?? ''} ${text(b)}`)
        )
        return named ?? btns[btns.length - 1]
      }
      row = row.parentElement
    }
    return null
  }

  let more = findMenuButton()
  if (!more) {
    const hoverTarget = anchor.closest('div') ?? anchor.parentElement ?? anchor
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
      try {
        hoverTarget.dispatchEvent(new g.MouseEvent(type, { bubbles: true }))
      } catch {
        /* ignore */
      }
    }
    await sleep(250)
    more = findMenuButton()
  }
  if (!more) return { ok: false, reason: '未找到对话菜单按钮' }

  more.click()
  await sleep(350)

  const items = [...doc.querySelectorAll('[role="menuitem"],button,[role="button"],div')].filter(
    (el: any) => visible(el) && text(el) === '删除'
  )
  if (items.length === 0) return { ok: false, reason: '菜单中没有「删除」' }
  // 取层级最深（子元素最少）的节点，避免命中包含文本的外层容器
  items.sort((a: any, b: any) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)
  items[0].click()
  await sleep(450)

  const confirms = [...doc.querySelectorAll('button,[role="button"]')].filter(
    (el: any) => visible(el) && ['删除', '确认', '确定', '确认删除', '删除对话'].includes(text(el))
  )
  if (confirms.length > 0) {
    confirms[confirms.length - 1].click()
    await sleep(500)
  }
  return { ok: true }
}

export async function deleteDeepSeekChat(
  webContents: WebContents,
  providerUrl: string,
  title: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!webContents || webContents.isDestroyed()) return { ok: false, reason: '网页已关闭' }
  if (!/^https:\/\/chat\.deepseek\.com\//.test(providerUrl)) return { ok: false, reason: '不是 DeepSeek 对话' }
  try {
    const code = `(${deepSeekDeleteScript.toString()})(${JSON.stringify({ url: providerUrl, title })})`
    const result = await Promise.race([
      webContents.executeJavaScript(code, true),
      new Promise<{ ok: boolean; reason?: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: '网页操作超时' }), 12_000)
      )
    ])
    return result && typeof result === 'object' ? result : { ok: false, reason: '网页未返回结果' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
