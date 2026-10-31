/**
 * webview 注册表：按标签 id 索引真实的 webview 元素。
 *
 * 不能用 document.querySelector('webview')：所有标签的 webview 同时挂载
 * （非激活只是 display:none），querySelector 永远返回 DOM 里第一个——
 * 第二个平台的新会话会被绑到第一个平台的页面，adapter/hook/系统提示词全部串台。
 */
const registry = new Map<string, Electron.WebviewTag>()

export function registerWebview(tabId: string, el: Electron.WebviewTag | null): void {
  if (el) registry.set(tabId, el)
  else registry.delete(tabId)
}

/** 标签对应 webview 的 webContentsId；未挂载/未 attach 返回 -1 */
export function webviewWcId(tabId: string): number {
  const el = registry.get(tabId)
  if (!el) return -1
  try {
    return el.getWebContentsId()
  } catch {
    return -1
  }
}

/** 标签对应 webview 当前打开的网页 URL（未挂载/读取失败返回空） */
export function webviewUrl(tabId: string): string {
  const el = registry.get(tabId) as (Electron.WebviewTag & { getURL?: () => string }) | undefined
  if (!el) return ''
  try {
    return el.getURL?.() || ''
  } catch {
    return ''
  }
}

/** 等待 webview attach（首次打开时 React 渲染晚于状态更新） */
export async function waitWebviewWcId(tabId: string, tries = 60, intervalMs = 150): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const id = webviewWcId(tabId)
    if (id > 0) return id
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return webviewWcId(tabId)
}
