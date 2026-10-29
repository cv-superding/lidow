import { useEffect, useState } from 'react'
import type { ProviderDescriptor } from '@shared/types'
import { useStore } from '@renderer/store'
import { api } from '@renderer/api'
import { IconClose, IconGlobe } from '@renderer/components/icons'

function accountOf(provider?: ProviderDescriptor): string {
  return provider?.activeAccountId ?? provider?.accounts[0]?.id ?? ''
}

/** Web 版登录：在用户自己的浏览器登录平台后，把 Cookie 导入容器里的平台分区 */
export function WebLoginDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const provider = providers.find((p) => p.id === providerId)
  const [accountId, setAccountId] = useState(accountOf(provider))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setAccountId(accountOf(provider))
  }, [provider])

  const openLoginPage = (): void => {
    if (provider?.home) window.open(provider.home, '_blank', 'noopener,noreferrer')
  }

  const importCookies = async (): Promise<void> => {
    if (!provider || !text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.importProviderCookies(provider.id, text, accountId || undefined)
      if (result.imported === 0) throw new Error('没有可写入的 Cookie')
      useStore.getState().notice(`已导入 ${result.imported} 个 Cookie，新建任务即可使用`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-6"
      style={{ background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="anim-pop flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[18px]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: '0 24px 64px rgba(0,0,0,.28)' }}
      >
        <div className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <IconGlobe size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">登录平台</div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
              Web 版运行在容器里，登录态通过 Cookie 导入
            </div>
          </div>
          <button className="btn btn-sm btn-ghost btn-icon" title="关闭" disabled={busy} onClick={onClose}>
            <IconClose size={12} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>平台</span>
              <select
                className="field h-9"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>账号</span>
              <select
                className="field h-9"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {provider?.accounts.length ? (
                  provider.accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.id}</option>)
                ) : (
                  <option value="">默认账号</option>
                )}
              </select>
            </label>
          </div>

          <div
            className="rounded-[var(--r-md)] px-3 py-2.5 text-[11.5px] leading-[1.7]"
            style={{ background: 'var(--surface-sunken)', color: 'var(--text-dim)' }}
          >
            1. 点「打开登录页」在浏览器里登录平台；
            <br />
            2. 按 F12 → Network → 任一请求 → 复制请求头里的 <span className="font-mono">Cookie</span>；
            <br />
            3. 粘贴到下面。Google 登录会被平台拒绝，请用邮箱/验证码登录。
          </div>

          <textarea
            className="field min-h-[150px] resize-y py-2 font-mono text-[11px] leading-[1.6]"
            placeholder="粘贴 Cookie 请求头，或导出的 JSON Cookie 数组…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          {error && (
            <div className="rounded-[var(--r-md)] px-3 py-2 text-[11.5px]" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
        >
          <button className="btn btn-sm btn-outline" disabled={!provider?.home} onClick={openLoginPage}>
            打开登录页
          </button>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>取消</button>
            <button
              className="btn btn-sm btn-primary"
              disabled={!provider || !text.trim() || busy}
              onClick={() => void importCookies()}
            >
              {busy ? '导入中…' : '导入登录态'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
