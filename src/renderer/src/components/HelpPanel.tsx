import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IconClose, IconSettings } from './icons'

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: 'Ctrl N', desc: '新建任务' },
  { keys: 'Enter', desc: '发送消息' },
  { keys: 'Shift Enter', desc: '消息内换行' },
  { keys: '/', desc: '唤起指令面板' },
  { keys: 'Ctrl `', desc: '打开 / 关闭终端' },
  { keys: 'Ctrl ,', desc: '打开设置' }
]

/**
 * 帮助面板：快捷键 / 工具清单 / 项目链接。
 * 工具清单从后端读（含 MCP 与插件注册的工具），不是写死的列表。
 */
export function HelpPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const [tools, setTools] = useState<{ name: string; description: string }[]>([])
  const version = useStore((s) => s.version)

  useEffect(() => {
    void api
      .listTools()
      .then((t) => setTools(t))
      .catch(() => setTools([]))
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(9, 12, 18, 0.5)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="anim-pop flex max-h-[82vh] w-[640px] max-w-full flex-col overflow-hidden rounded-[var(--r-2xl)]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-3.5" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="text-title flex-1">帮助</span>
          <span className="badge">v{version || '0.3.0'}</span>
          <button className="btn btn-ghost btn-icon btn-sm" title="关闭" onClick={onClose}>
            <IconClose size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* 快捷键 */}
          <div className="text-label mb-2">快捷键</div>
          <div className="mb-5 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-center gap-2 text-[12px]">
                <kbd
                  className="rounded-[var(--r-sm)] px-1.5 py-0.5 font-mono text-[10.5px]"
                  style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)', color: 'var(--text-body)' }}
                >
                  {s.keys}
                </kbd>
                <span style={{ color: 'var(--text-dim)' }}>{s.desc}</span>
              </div>
            ))}
          </div>

          {/* 已接入平台 */}
          <div className="text-label mb-2">已接入平台</div>
          <div className="mb-5 flex flex-wrap gap-1.5">
            {providers.length === 0 ? (
              <span className="text-[12px]" style={{ color: 'var(--text-hint)' }}>
                尚未添加平台 — 到设置里添加
              </span>
            ) : (
              providers.map((p) => (
                <span key={p.id} className="badge badge-accent">
                  {p.name}
                </span>
              ))
            )}
          </div>

          {/* 工具清单 */}
          <div className="mb-2 flex items-center gap-2">
            <span className="text-label">可用工具</span>
            <span className="badge">{tools.length}</span>
          </div>
          <div className="mb-5 space-y-1">
            {tools.length === 0 ? (
              <div className="text-[12px]" style={{ color: 'var(--text-hint)' }}>
                暂无工具
              </div>
            ) : (
              tools.map((t) => (
                <div key={t.name} className="flex items-start gap-2.5 rounded-[var(--r-sm)] px-2 py-1.5" style={{ background: 'var(--surface-sunken)' }}>
                  <span className="shrink-0 font-mono text-[11.5px] font-medium" style={{ color: 'var(--text)' }}>
                    {t.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                    {t.description}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* 关于 */}
          <div className="text-label mb-2">关于</div>
          <div className="space-y-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            <div>
              Lidow — 零 Token 成本的内嵌网页版 AI Agent。网页里的 AI 通过本机工具读写文件、执行命令。
            </div>
            <div>
              协议 GPL-3.0 · 仓库{' '}
              <a
                href="https://github.com/cv-superding/lidow"
                className="underline"
                style={{ color: 'var(--accent)' }}
                onClick={(e) => {
                  e.preventDefault()
                  void api.openExternal('https://github.com/cv-superding/lidow')
                }}
              >
                github.com/cv-superding/lidow
              </a>
            </div>
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
        >
          <span className="flex-1 text-[11px]" style={{ color: 'var(--text-hint)' }}>
            遇到问题可在仓库提 issue
          </span>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              onClose()
              useStore.getState().setView('settings')
            }}
          >
            <IconSettings size={12} /> 设置
          </button>
        </div>
      </div>
    </div>
  )
}
