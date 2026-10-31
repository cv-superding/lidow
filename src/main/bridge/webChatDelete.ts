/* eslint-disable @typescript-eslint/no-explicit-any -- 这段函数会被序列化进网页执行，只能用 any 操作宿主 DOM */
import type { WebContents } from 'electron'

/**
 * 在平台网页里尽力删除一条对话：
 * 按 providerUrl 定位侧边栏行 → 打开 ⋯ 菜单 → 点「删除」→ 确认。
 * 不同平台菜单文案/结构不同，命中不到时返回失败原因，不影响本地会话删除。
 */
async function webChatDeleteScript(args: { url: string; title: string }): Promise<{ ok: boolean; reason?: string }> {
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
  const DELETE_LABELS = [
    '删除',
    '删除对话',
    '删除会话',
    '移除',
    '移除对话',
    'delete',
    'delete chat',
    'delete conversation',
    'remove',
    'remove chat',
    'remove conversation'
  ]
  const CONFIRM_LABELS = [
    ...DELETE_LABELS,
    '确认',
    '确定',
    '确认删除',
    '确定删除',
    'ok',
    'okay',
    'confirm'
  ]
  const hasLabel = (el: any, labels: string[]) => {
    const t = `${text(el)} ${el?.getAttribute?.('aria-label') ?? ''} ${el?.getAttribute?.('title') ?? ''}`
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
    return labels.some((l) => t === l || (l.length >= 2 && t.includes(l)))
  }

  let target: URL
  try {
    target = new g.URL(String(args.url || ''))
  } catch {
    return { ok: false, reason: '无效的对话地址' }
  }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, reason: '无效的对话地址' }
  if (g.location.origin !== target.origin) return { ok: false, reason: '当前页面与对话地址不一致' }
  const path = target.pathname.replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  const id = segments[segments.length - 1] ?? ''
  if (!id || id.length < 4) return { ok: false, reason: '无法从会话 URL 识别对话 ID' }

  // DeepSeek 侧栏菜单结构改版后「...」里找不到删除项；它自己的删除接口最稳：
  // POST /api/v0/chat_session/delete { chat_session_ids: [id] }。
  if (target.origin === 'https://chat.deepseek.com') {
    try {
      const res = await g.fetch('/api/v0/chat_session/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_ids: [id] })
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: '网页未登录，无法删除网页端对话' }
      }
      const json = await res.json().catch(() => null)
      const code = json?.data?.biz_code ?? json?.code
      if (code === 40003 || /INVALID_TOKEN/i.test(String(json?.msg ?? ''))) {
        return { ok: false, reason: '网页未登录，无法删除网页端对话' }
      }
      if (res.ok && code === 0) {
        // 直接调接口不会更新侧栏的 React 状态；刷新一次让网页端列表同步消失
        g.setTimeout(() => {
          try {
            if (g.location.pathname.includes(id)) g.location.href = '/'
            else g.location.reload()
          } catch {
            /* ignore */
          }
        }, 300)
        return { ok: true }
      }
    } catch {
      /* 接口异常时继续走下面的 UI 菜单兜底 */
    }
  }
  const sameChat = (a: any): boolean => {
    try {
      const u = new g.URL(String(a.href), g.location.href)
      return u.origin === target.origin && u.pathname.replace(/\/+$/, '') === path
    } catch {
      return false
    }
  }

  const deadline = Date.now() + 6000
  let anchor: any = null
  while (Date.now() < deadline) {
    anchor = [...doc.querySelectorAll('a[href]')].find((a: any) => sameChat(a) || String(a.href).includes(id))
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

  // 页面里的删除监听看到这个标记会跳过，避免本地删除又反向触发一次同步
  const busyAttr = 'data-lidow-chat-delete-busy'
  try {
    doc.documentElement.setAttribute(busyAttr, '1')
    more.click()
    await sleep(350)

    const items = [...doc.querySelectorAll('[role="menuitem"],button,[role="button"],div')].filter(
      (el: any) => visible(el) && hasLabel(el, DELETE_LABELS)
    )
    if (items.length === 0) return { ok: false, reason: '菜单中没有「删除」' }
    // 取层级最深（子元素最少）的节点，避免命中包含文本的外层容器
    items.sort((a: any, b: any) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)
    items[0].click()
    await sleep(450)

    const confirms = [...doc.querySelectorAll('button,[role="button"]')].filter(
      (el: any) => visible(el) && hasLabel(el, CONFIRM_LABELS)
    )
    if (confirms.length > 0) {
      confirms[confirms.length - 1].click()
      await sleep(500)
    }
    // 确认点击后等侧栏真正移除，避免“点了删除但平台没删”被误报成功
    const verifyDeadline = Date.now() + 2_000
    while (Date.now() < verifyDeadline) {
      const still = [...doc.querySelectorAll('a[href]')].some((a: any) => visible(a) && (sameChat(a) || String(a.href).includes(id)))
      if (!still) return { ok: true }
      await sleep(150)
    }
    return { ok: false, reason: '网页端删除后对话仍在侧边栏' }
  } finally {
    try {
      doc.documentElement.removeAttribute(busyAttr)
    } catch {
      /* ignore */
    }
  }
}

export async function deleteWebChat(
  webContents: WebContents,
  providerUrl: string,
  title: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!webContents || webContents.isDestroyed()) return { ok: false, reason: '网页已关闭' }
  if (!/^https?:\/\//.test(providerUrl)) return { ok: false, reason: '没有可定位的网页对话地址' }
  try {
    const code = `(${webChatDeleteScript.toString()})(${JSON.stringify({ url: providerUrl, title })})`
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

/** 兼容旧调用/测试名 */
export const deleteDeepSeekChat = deleteWebChat
