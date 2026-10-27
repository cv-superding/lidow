import { useEffect } from 'react'
import { useStore, type ViewId } from '../store'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { SessionsView, FilesView, PluginsView, MemoryView, KnowledgeView, AuditView, SettingsView } from './views'

const RAIL: { id: ViewId; icon: string; label: string }[] = [
  { id: 'home', icon: '⌂', label: '工作台' },
  { id: 'sessions', icon: '💬', label: '会话' },
  { id: 'files', icon: '📁', label: '文件' },
  { id: 'plugins', icon: '🧩', label: '插件' },
  { id: 'memory', icon: '🧠', label: '记忆' },
  { id: 'knowledge', icon: '📚', label: '知识库' },
  { id: 'audit', icon: '🕘', label: '审计' },
  { id: 'settings', icon: '⚙', label: '设置' }
]

export function LeftRail(): React.JSX.Element {
  const { view, setView } = useStore()
  return (
    <div
      className="group/rail flex h-full flex-col gap-1 border-r py-3 transition-panel"
      style={{ width: 56, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.width = '176px'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.width = '56px'
      }}
    >
      <div className="mb-3 flex h-9 items-center gap-2.5 overflow-hidden px-4">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[15px] font-bold text-white" style={{ background: 'var(--accent)' }}>
          L
        </span>
        <span className="whitespace-nowrap text-[13.5px] font-semibold opacity-0 transition-opacity group-hover/rail:opacity-100">Lidow</span>
      </div>
      {RAIL.map((item) => (
        <button
          key={item.id}
          className="flex h-9 items-center gap-2.5 overflow-hidden px-4 text-[13px] transition-panel"
          style={{
            background: view === item.id ? 'var(--bg-hover)' : 'transparent',
            color: view === item.id ? 'var(--text)' : 'var(--text-dim)'
          }}
          onClick={() => setView(item.id)}
        >
          <span className="w-4 shrink-0 text-center text-[14px]">{item.icon}</span>
          <span className="whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">{item.label}</span>
        </button>
      ))}
      <div className="mt-auto px-4">
        <button
          className="flex h-9 w-full items-center gap-2.5 overflow-hidden text-[13px]"
          style={{ color: 'var(--text-dim)' }}
          onClick={() => void useStore.getState().setPure(!useStore.getState().pureMode)}
        >
          <span className="w-4 shrink-0 text-center">⛶</span>
          <span className="whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">纯净模式</span>
        </button>
      </div>
    </div>
  )
}

export function AppShell(): React.JSX.Element {
  const { booted, view, rightOpen, pureMode, toggleRight, stop, notices, streamingText } = useStore()

  useEffect(() => {
    void useStore.getState().boot()
  }, [])

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--text-dim)' }}>
        正在启动…
      </div>
    )
  }

  if (pureMode) {
    return (
      <div className="relative h-full">
        <ChatPanel />
        <button
          className="absolute right-3 top-3 z-10 rounded-lg px-2.5 py-1 text-[11.5px]"
          style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
          onClick={() => void useStore.getState().setPure(false)}
        >
          退出纯净模式
        </button>
      </div>
    )
  }

  const running = streamingText.length > 0

  return (
    <div className="flex h-full overflow-hidden">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部极简地址栏 */}
        <div className="flex h-10 items-center gap-2 border-b px-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
          <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
            {view === 'home' ? '工作台' : RAIL.find((r) => r.id === view)?.label}
          </span>
          {running && (
            <span className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]" style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} />
              Agent 运行中
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {running && (
              <button className="rounded-lg px-2.5 py-1 text-[11.5px] text-white" style={{ background: '#c04c4c' }} onClick={() => void stop('all')}>
                全部停止
              </button>
            )}
            {view === 'home' && (
              <button className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }} onClick={toggleRight}>
                {rightOpen ? '收起面板' : '展开面板'}
              </button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1" style={{ background: 'var(--bg)' }}>
            {view === 'home' && <WebTabs />}
            {view === 'sessions' && <SessionsView />}
            {view === 'files' && <FilesView />}
            {view === 'plugins' && <PluginsView />}
            {view === 'memory' && <MemoryView />}
            {view === 'knowledge' && <KnowledgeView />}
            {view === 'audit' && <AuditView />}
            {view === 'settings' && <SettingsView />}
          </div>
          {view === 'home' && rightOpen && (
            <div className="transition-panel shrink-0 border-l" style={{ width: 440, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
              <ChatPanel />
            </div>
          )}
        </div>
      </div>

      {/* 通知浮层 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {notices.slice(-3).map((n, i) => (
          <div
            key={`${n.ts}-${i}`}
            className="rounded-xl px-3.5 py-2 text-[12.5px]"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow)',
              color: n.level === 'error' ? '#e06c6c' : n.level === 'warn' ? '#d0a23c' : 'var(--text)'
            }}
          >
            {n.message}
          </div>
        ))}
      </div>
    </div>
  )
}
