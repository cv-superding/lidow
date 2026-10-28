import { useEffect } from 'react'
import { useStore, useProject, type ViewId } from '../store'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { PureModeShell } from './PureModeShell'
import { SessionsView, FilesView, TasksView, PluginsView, MemoryView, KnowledgeView, AuditView, SettingsView } from './views'

const RAIL: { id: ViewId; icon: string; label: string }[] = [
  { id: 'home', icon: '⌂', label: '工作台' },
  { id: 'sessions', icon: '💬', label: '会话' },
  { id: 'files', icon: '📁', label: '文件' },
  { id: 'tasks', icon: '☑', label: '任务' },
  { id: 'plugins', icon: '🧩', label: '插件' },
  { id: 'memory', icon: '🧠', label: '记忆' },
  { id: 'knowledge', icon: '📚', label: '知识库' },
  { id: 'audit', icon: '🕘', label: '审计' },
  { id: 'settings', icon: '⚙', label: '设置' }
]

/** thinkrail 式面板头：大写小字号标题 + 右侧控制钮 */
export function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-header)' }}>
      <span className="flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
        {title}
      </span>
      {children}
    </div>
  )
}

export function LeftRail(): React.JSX.Element {
  const { view, setView } = useStore()
  return (
    <div
      className="group/rail flex h-full flex-col gap-0.5 border-r py-2 transition-panel"
      style={{ width: 48, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.width = '168px'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.width = '48px'
      }}
    >
      {RAIL.map((item) => {
        const active = view === item.id
        return (
          <button
            key={item.id}
            className="relative flex h-8 items-center gap-2.5 overflow-hidden px-3.5 text-[12.5px]"
            style={{
              background: active ? 'var(--bg-hover)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-hint)'
            }}
            onClick={() => setView(item.id)}
          >
            {active && <span className="absolute left-0 h-4 w-0.5 rounded-r" style={{ background: 'var(--accent)' }} />}
            <span className="w-4 shrink-0 text-center text-[13px]">{item.icon}</span>
            <span className="whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">{item.label}</span>
          </button>
        )
      })}
      <div className="mt-auto px-3.5 pb-1">
        <button
          className="flex h-8 w-full items-center gap-2.5 overflow-hidden text-[12.5px]"
          style={{ color: 'var(--text-hint)' }}
          onClick={() => void useStore.getState().setPure(!useStore.getState().pureMode)}
        >
          <span className="w-4 shrink-0 text-center">⛶</span>
          <span className="whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">纯净模式</span>
        </button>
      </div>
    </div>
  )
}

/** thinkrail 三段式顶栏：品牌 | 当前位置面包屑 | 连接状态 */
function TopBar(): React.JSX.Element {
  const { view, streamingText, stop, rightOpen, toggleRight } = useStore()
  const project = useProject(useStore())
  const running = streamingText.length > 0
  return (
    <div className="flex h-9 shrink-0 items-center border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-header)' }}>
      {/* 品牌 */}
      <div className="flex h-full items-center gap-2 border-r px-3" style={{ borderColor: 'var(--border)' }}>
        <span className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          L
        </span>
        <span className="text-[12.5px] font-semibold tracking-tight">Lidow</span>
      </div>
      {/* 位置面包屑 */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
        <span className="truncate text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {project?.name ?? '未打开项目'}
        </span>
        <span style={{ color: 'var(--text-hint)' }}>›</span>
        <span className="truncate text-[12px]">{view === 'home' ? '工作台' : RAIL.find((r) => r.id === view)?.label}</span>
        {running && (
          <span className="ml-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: 'var(--bubble-user-bg)', color: 'var(--accent)' }}>
            <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            运行中
          </span>
        )}
      </div>
      {/* 状态与控制 */}
      <div className="flex h-full items-center gap-1.5 px-3">
        {running && (
          <button className="rounded-md px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--danger)', color: 'var(--on-accent)' }} onClick={() => void stop('all')}>
            全部停止
          </button>
        )}
        {view === 'home' && (
          <button className="rounded-md px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }} onClick={toggleRight}>
            {rightOpen ? '收起面板' : '对话面板'}
          </button>
        )}
        <span className="ml-1 flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
          就绪
        </span>
      </div>
    </div>
  )
}

export function AppShell(): React.JSX.Element {
  const { booted, view, rightOpen, pureMode, notices } = useStore()

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
    return <PureModeShell />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <div className="min-w-0 flex-1" style={{ background: 'var(--bg)' }}>
          {view === 'home' && <WebTabs />}
          {view === 'sessions' && <SessionsView />}
          {view === 'files' && <FilesView />}
          {view === 'tasks' && <TasksView />}
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

      {/* 通知浮层 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {notices.slice(-3).map((n, i) => (
          <div
            key={`${n.ts}-${i}`}
            className="anim-toast rounded-xl px-3.5 py-2 text-[12.5px]"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              boxShadow: 'var(--shadow)',
              color: n.level === 'error' ? 'var(--danger)' : n.level === 'warn' ? 'var(--warning)' : 'var(--text)'
            }}
          >
            {n.message}
          </div>
        ))}
      </div>
    </div>
  )
}
