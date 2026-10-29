import { useStore } from '../store'
import { IconClose, IconDownload, IconRefresh } from './icons'

function speedText(n?: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(n / 1024))} KB/s`
}

function sizeText(n?: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** 更新提示：发现新版本 → 下载（带进度条）→ 自动重启安装 */
export function UpdatePrompt(): React.JSX.Element | null {
  const state = useStore((s) => s.updateState)
  const dismissed = useStore((s) => s.updateDismissedVersion)
  const dismiss = useStore((s) => s.dismissUpdate)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const checkUpdate = useStore((s) => s.checkUpdate)

  const visible =
    state.phase === 'available' ||
    state.phase === 'downloading' ||
    state.phase === 'downloaded' ||
    (state.phase === 'error' && Boolean(state.manual))
  if (!visible) return null
  // 点「稍后」后隐藏；但下载中/下载完成仍然展示（完成后要提示重启）
  if (dismissed && dismissed === state.version && state.phase !== 'downloading' && state.phase !== 'downloaded') return null

  const percent = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)))
  const title =
    state.phase === 'downloading'
      ? '正在下载更新'
      : state.phase === 'downloaded'
        ? '更新已下载'
        : state.phase === 'error'
          ? '更新失败'
          : '发现新版本'
  const desc =
    state.phase === 'downloading'
      ? `${percent}%${speedText(state.bytesPerSecond) ? ` · ${speedText(state.bytesPerSecond)}` : ''}${
          sizeText(state.total) ? ` · ${sizeText(state.transferred ?? 0)} / ${sizeText(state.total)}` : ''
        }`
      : state.phase === 'downloaded'
        ? '正在重启并安装新版本，请稍候…'
        : state.phase === 'error'
          ? state.message || '请检查网络后重试'
          : state.portable
            ? `v${state.version} 已发布。便携版无法自动替换自身，点击后打开下载页。`
            : `v${state.version} 已发布，下载完成后会自动重启安装。`

  return (
    <div className="pointer-events-none fixed right-4 top-[58px] z-[60] w-[360px] max-w-[calc(100vw-32px)]">
      <div
        className="anim-pop pointer-events-auto rounded-[var(--r-xl)] p-3.5"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="flex items-start gap-2.5">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]"
            style={{
              background: state.phase === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
              color: state.phase === 'error' ? 'var(--danger)' : 'var(--accent)'
            }}
          >
            <IconDownload size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">{title}</span>
              {state.version && (
                <span
                  className="rounded-full px-1.5 py-[1px] text-[10px] font-medium"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  v{state.version}
                </span>
              )}
              <button
                className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-hint)' }}
                title="稍后提醒"
                onClick={dismiss}
              >
                <IconClose size={10} />
              </button>
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              {desc}
            </div>

            {(state.phase === 'downloading' || state.phase === 'downloaded') && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-active)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${percent}%`, background: 'var(--accent)' }}
                />
              </div>
            )}

            {(state.phase === 'available' || state.phase === 'error') && (
              <div className="mt-2.5 flex items-center justify-end gap-2">
                <button className="btn btn-sm btn-ghost" onClick={dismiss}>
                  稍后
                </button>
                {state.phase === 'error' ? (
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => void (state.version ? downloadUpdate() : checkUpdate(true))}
                  >
                    <IconRefresh size={12} /> 重试
                  </button>
                ) : (
                  <button className="btn btn-sm btn-primary" onClick={() => void downloadUpdate()}>
                    {state.portable ? '打开下载页' : '立即更新'}
                  </button>
                )}
              </div>
            )}
            {state.phase === 'downloaded' && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
                应用即将关闭并自动安装
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
