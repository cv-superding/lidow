import type { LidowBridge } from '@shared/global'
import type { LidowEvent } from '@shared/ipc'

const TOKEN_KEY = 'lidow:web-token'
const urlToken = new URLSearchParams(window.location.search).get('token')
if (urlToken) {
  try {
    localStorage.setItem(TOKEN_KEY, urlToken)
  } catch {
    /* 隐私模式忽略 */
  }
}

function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token() ? { authorization: `Bearer ${token()}` } : {})
    },
    body: JSON.stringify({ method, args })
  })
  if (res.status === 401) throw new Error('访问令牌无效，请在 URL 追加 ?token=...')
  const data = (await res.json()) as { ok?: boolean; result?: unknown; error?: string }
  if (!data.ok) throw new Error(data.error || `调用 ${method} 失败`)
  return data.result
}

function onEvent(cb: (event: LidowEvent) => void): () => void {
  const suffix = token() ? `?token=${encodeURIComponent(token())}` : ''
  const source = new EventSource(`/api/events${suffix}`)
  source.onmessage = (ev) => {
    try {
      cb(JSON.parse(ev.data) as LidowEvent)
    } catch {
      /* 忽略坏消息 */
    }
  }
  return () => source.close()
}

window.lidow = { invoke, onEvent } as LidowBridge
