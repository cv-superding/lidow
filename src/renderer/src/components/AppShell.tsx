import { useEffect, useState } from 'react'
import { useStore, useProject, type ViewId } from '../store'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { PureModeShell, PreviewPanel } from './PureModeShell'
import {
  SessionsView,
  FilesView,
  TasksView,
  PluginsView,
  MemoryView,
  KnowledgeView,
  AuditView,
  SettingsView
} from './views'
import { RAIL_ICONS, IconPure, IconChevronRight, IconFolder } from './icons'
import { WindowControls, DragStrip } from './TitleBar'

const RAIL: { id: ViewId; label: string }[] = [
  { id: 'home', label: '工作台' },
  { id: 'sessions', label: '会话' },
  { id: 'files', label: '文件' },
  { id: 'tasks', label: '任务' },
  { id: 'plugins', label: '插件' },
  { id: 'memory', label: '记忆' },
  { id: 'knowledge', label: '知识库' },
  { id: 'audit', label: '审计' },
  { id: 'settings', label: '设置' }
]

/** 面板头：小字号大写字距标题 + 右侧操作 */
export function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <span className="text-label flex-1 truncate">{title}</span>
      {children}
    </div>
  )
}

export function LeftRail(): React.JSX.Element {
  const { view, setView, pureMode, setPure } = useStore()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="flex h-full flex-col border-r"
      style={{
        width: hovered ? 176 : 52,
        borderColor: 'var(--border)',
        background: 'var(--sidebar)',
        transition: 'width var(--dur-slow) var(--ease-emph)',
        overflow: 'hidden'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex flex-col gap-1 px-2 py-2.5">
        {RAIL.map((item) => {
          const Icon = RAIL_ICONS[item.id as keyof typeof RAIL_ICONS]
          const active = view === item.id
          return (
            <button
              key={item.id}
              className="nav-item shrink-0"
              data-active={active}
              style={{
                paddingLeft: hovered ? 10 : 0,
                justifyContent: hovered ? 'flex-start' : 'center',
                height: 34
              }}
              onClick={() => setView(item.id)}
              title={item.label}
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                <Icon size={18} />
              </span>
              <span
                className="whitespace-nowrap"
                style={{
                  opacity: hovered ? 1 : 0,
                  width: hovered ? 'auto' : 0,
                  transition: `opacity ${hovered ? '180ms' : '90ms'} ease`
                }}
              >
                {item.label}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto px-2 pb-2.5">
        <div className="divider-soft mb-1.5" />
        <button
          className="nav-item shrink-0"
          style={{
            paddingLeft: hovered ? 10 : 0,
            justifyContent: hovered ? 'flex-start' : 'center',
            height: 34,
            color: pureMode ? 'var(--accent)' : undefined
          }}
          title="纯净模式"
          onClick={() => setPure(!pureMode)}
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
            <IconPure size={18} />
          </span>
          <span
            className="whitespace-nowrap"
            style={{
              opacity: hovered ? 1 : 0,
              width: hovered ? 'auto' : 0,
              transition: `opacity ${hovered ? '180ms' : '90ms'} ease`
            }}
          >
            纯净模式
          </span>
        </button>
      </div>
    </div>
  )
}

/** 顶栏：品牌 | 项目面包屑 | 运行态 + 窗口控制。整条可拖拽窗口 */
function TopBar(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const streamingText = useStore((s) => s.streamingText)
  const stop = useStore((s) => s.stop)
  const project = useProject(useStore())
  const running = streamingText.length > 0
  return (
    <div
      className="flex h-11 shrink-0 items-center border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 品牌 */}
      <div className="flex h-full items-center gap-2.5 border-r px-3.5" style={{ borderColor: 'var(--border)' }}>
        <span
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[7px] text-[12px] font-bold"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          L
        </span>
        <span className="text-[13px] font-semibold tracking-tight">Lidow</span>
      </div>

      {/* 面包屑 */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3.5">
        <span style={{ color: 'var(--text-hint)' }}>
          <IconFolder size={13} />
        </span>
        <span className="truncate text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
          {project?.name ?? '未打开项目'}
        </span>
        <IconChevronRight size={11} className="shrink-0 opacity-50" />
        <span className="truncate text-[12.5px] font-medium">
          {view === 'home' ? '工作台' : RAIL.find((r) => r.id === view)?.label}
        </span>
      </div>

      {/* 控制区（不可拖拽） */}
      <div className="flex h-full items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {running && (
          <>
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              运行中
            </span>
            <button className="btn btn-sm btn-danger" onClick={() => void stop('all')}>
              停止
            </button>
          </>
        )}
      </div>
      <WindowControls />
    </div>
  )
}

/** 纯净模式右侧文件预览（无项目时不渲染） */
function PurePreview(): React.JSX.Element | null {
  const project = useProject(useStore())
  return project ? <PreviewPanel projectId={project.id} /> : null
}

/** 危险操作确认浮层 */
function ConfirmOverlay(): React.JSX.Element {
  const { confirmRequest, answerConfirm } = useStore()
  if (!confirmRequest) return <></>
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div
        className="anim-pop pointer-events-auto w-full max-w-[520px] rounded-[var(--r-xl)] p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className="flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold"
            style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
          >
            !
          </span>
          <span className="text-[13px] font-semibold">危险操作需要确认</span>
        </div>
        <div className="mb-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {confirmRequest.reason}
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-sm btn-outline" onClick={() => void answerConfirm(false)}>
            拒绝
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void answerConfirm(true)}>
            允许执行
          </button>
        </div>
      </div>
    </div>
  )
}

export function AppShell(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const view = useStore((s) => s.view)
  const pureMode = useStore((s) => s.pureMode)
  const pureView = useStore((s) => s.pureView)
  const notices = useStore((s) => s.notices)
  const confirmRequest = useStore((s) => s.confirmRequest)

  useEffect(() => {
    void useStore.getState().boot()
  }, [])

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="flex flex-col items-center gap-3">
          <span
            className="anim-breathe flex h-9 w-9 items-center justify-center rounded-[10px] text-[15px] font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            L
          </span>
          <span className="text-[12px]" style={{ color: 'var(--text-hint)' }}>
            正在启动…
          </span>
        </div>
      </div>
    )
  }

  // WebTabs 在 DOM 中位置固定（顶层），用 CSS 决定可见性 / 占位。
  // 切换模式或视图不改变它的树位置 → webview 永不卸载 → 登录态与对话进度保留。
  const showManager = pureMode ? pureView !== 'home' : view !== 'home'
  const activeView = pureMode ? pureView : view

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      {pureMode ? <DragStrip /> : <TopBar />}

      <div className="flex min-h-0 flex-1">
        {pureMode ? <PureModeShell /> : <LeftRail />}

        {/* 主区容器：WebTabs 与各管理视图共存，靠 z-index 切换 */}
        <div className="relative min-w-0 flex-1" style={{ background: 'var(--bg)' }}>
          {/* webview 必须保持在视口内：离屏定位会触发 document.hidden=true，
              Chromium 节流隐藏页面 → React 不响应输入/点击（实测消息发不出去）。 */}
          <div className="h-full" style={{ position: 'relative', zIndex: 0 }}>
            <WebTabs />
          </div>

          {/* 纯净模式对话主区：不透明原生层，盖住底层 webview */}
          {pureMode && pureView === 'home' && (
            <div className="absolute inset-0 z-10" style={{ background: 'var(--bg)' }}>
              <ChatPanel mode="pure" />
            </div>
          )}

          {/* 管理视图 */}
          {showManager && (
            <div className="anim-fade absolute inset-0 z-10 overflow-auto" style={{ background: 'var(--bg)' }}>
              {activeView === 'sessions' && <SessionsView />}
              {activeView === 'files' && <FilesView />}
              {activeView === 'tasks' && <TasksView />}
              {activeView === 'plugins' && <PluginsView />}
              {activeView === 'memory' && <MemoryView />}
              {activeView === 'knowledge' && <KnowledgeView />}
              {activeView === 'audit' && <AuditView />}
              {activeView === 'settings' && <SettingsView />}
            </div>
          )}
        </div>

        {/* 纯净模式文件预览（仅对话主区） */}
        {pureMode && pureView === 'home' && <PurePreview />}
      </div>

      {confirmRequest && <ConfirmOverlay />}

      {/* 通知浮层 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {notices.slice(-3).map((n, i) => (
          <div
            key={`${n.ts}-${i}`}
            className="anim-toast flex items-center gap-2 rounded-[var(--r-lg)] px-3.5 py-2.5 text-[12.5px]"
            style={{
              background: 'var(--surface-raised)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-lg)',
              color: n.level === 'error' ? 'var(--danger)' : n.level === 'warn' ? 'var(--warning)' : 'var(--text)'
            }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background:
                  n.level === 'error' ? 'var(--danger)' : n.level === 'warn' ? 'var(--warning)' : 'var(--success)'
              }}
            />
            {n.message}
          </div>
        ))}
      </div>
    </div>
  )
}
