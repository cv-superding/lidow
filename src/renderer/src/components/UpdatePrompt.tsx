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

/** 更新提示：屏幕中央的发现新版本确认卡；下载进度继续居中展示但不拦截其他区域 */
export function UpdatePrompt(): React.JSX.Element | null {
  const state = useStore((s) => s.updateState)
  const dismissed = useStore((s) => s.updateDismissedVersion)
  const dismiss = useStore((s) => s.dismissUpdate)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const checkUpdate = useStore((s) => s.checkUpdate)

  const downloading = state.phase === 'downloading'
  const downloaded = state.phase === 'downloaded'
  const modal = state.phase === 'available' || (state.phase === 'error' && Boolean(state.manual))
  if (!modal && !downloading && !downloaded) return null
  // 点「稍后」后隐藏同一版本；下载/下载完成/失败仍要展示状态
  if (state.phase === 'available' && dismissed && dismissed === state.version) return null

  const percent = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)))
  const title = downloading
    ? '正在下载更新'
    : downloaded
      ? '更新已下载'
      : state.phase === 'error'
        ? '更新失败'
        : '发现新版本'
  const desc = downloading
    ? `${percent}%${speedText(state.bytesPerSecond) ? ` · ${speedText(state.bytesPerSecond)}` : ''}${
        sizeText(state.total) ? ` · ${sizeText(state.transferred ?? 0)} / ${sizeText(state.total)}` : ''
      }`
    : downloaded
      ? '即将关闭应用并自动安装新版本。'
      : state.phase === 'error'
        ? state.message || '请检查网络后重试'
        : state.portable
          ? `v${state.version} 已发布。便携版无法自动替换自身，点击后打开下载页。`
          : `v${state.version} 已发布，下载完成后会自动重启安装。`

  return (
    <div
      className={`fixed inset-0 z-[68] flex items-center justify-center px-6 ${
        modal ? '' : 'pointer-events-none'
      }`}
      style={modal ? { background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' } : undefined}
      role="dialog"
      aria-modal={modal || undefined}
      aria-label="软件更新"
    >
      <div
        className="anim-pop pointer-events-auto w-full max-w-[420px] overflow-hidden rounded-[18px]"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 24px 64px rgba(0,0,0,.28)'
        }}
      >
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
              style={{
                background: state.phase === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                color: state.phase === 'error' ? 'var(--danger)' : 'var(--accent)'
              }}
            >
              <IconDownload size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold leading-tight">{title}</span>
                {state.version && (
                  <span
                    className="rounded-full px-1.5 py-[1px] text-[10px] font-medium"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    v{state.version}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                {downloading || downloaded ? '请保持应用运行' : 'Lidow 桌面端'}
              </div>
            </div>
            {modal && (
              <button
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-hint)' }}
                title="稍后提醒"
                onClick={dismiss}
              >
                <IconClose size={11} />
              </button>
            )}
          </div>

          <div className="mt-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            {desc}
          </div>

          {(downloading || downloaded) && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-active)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${downloaded ? 100 : percent}%`, background: 'var(--accent)' }}
              />
            </div>
          )}

          {downloading && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-hint)' }}>
              下载完成后会自动重启并安装，请勿关闭应用。
            </div>
          )}
          {downloaded && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
              <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
              应用即将关闭并自动安装
            </div>
          )}
        </div>

        {modal && (
          <div
            className="flex items-center justify-end gap-2 border-t px-5 py-3"
            style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
          >
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
      </div>
    </div>
  )
}
