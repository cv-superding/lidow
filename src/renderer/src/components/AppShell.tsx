import { useEffect, useState } from 'react'
import { useStore, useProject, type ViewId } from '../store'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { PureModeShell, PreviewPanel } from './PureModeShell'
import { SessionsView, FilesView, TasksView, PluginsView, MemoryView, KnowledgeView, AuditView, SettingsView } from './views'
import { RAIL_ICONS, IconPure, IconChevronRight, IconChat } from './icons'
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

/** thinkrail 式面板头：大写小字号标题 + 右侧控制钮 */
export function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-header)' }}>
      <span className="flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
        {title}
      </span>
      {children}
    </div>
  )
}

export function LeftRail(): React.JSX.Element {
  const { view, setView, pureMode, setPure } = useStore()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="flex h-full flex-col border-r transition-[width] duration-200"
      style={{
        width: hovered ? 176 : 46,
        borderColor: 'var(--border)',
        background: 'var(--bg-panel)',
        transitionTimingFunction: 'cubic-bezier(0.2,0,0,1)'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex flex-col gap-0.5 py-1.5">
        {RAIL.map((item) => {
          const Icon = RAIL_ICONS[item.id as keyof typeof RAIL_ICONS]
          const active = view === item.id
          return (
            <button
              key={item.id}
              className="relative flex h-8 items-center gap-2.5 overflow-hidden px-3 text-[12.5px] transition-colors"
              style={{
                background: active ? 'var(--bg-hover)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-hint)'
              }}
              onClick={() => setView(item.id)}
            >
              {active && <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r" style={{ background: 'var(--accent)' }} />}
              <span className="flex w-4 shrink-0 items-center justify-center">
                <Icon size={17} />
              </span>
              <span className={`whitespace-nowrap transition-opacity ${hovered ? 'opacity-100' : 'opacity-0'}`}>{item.label}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-auto border-t px-0 py-1.5" style={{ borderColor: 'var(--border)' }}>
        <button
          className="flex h-8 w-full items-center gap-2.5 overflow-hidden px-3 text-[12.5px] transition-colors"
          style={{ color: pureMode ? 'var(--accent)' : 'var(--text-hint)' }}
          title="纯净模式：只保留对话"
          onClick={() => setPure(!pureMode)}
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <IconPure size={17} />
          </span>
          <span className={`whitespace-nowrap transition-opacity ${hovered ? 'opacity-100' : 'opacity-0'}`}>纯净模式</span>
        </button>
      </div>
    </div>
  )
}

/** thinkrail 三段式顶栏：品牌 | 面包屑 | 状态 + 窗口控制。整条可拖拽窗口 */
function TopBar(): React.JSX.Element {
  const { view, streamingText, stop, rightOpen, toggleRight } = useStore()
  const project = useProject(useStore())
  const running = streamingText.length > 0
  return (
    <div
      className="flex h-10 shrink-0 items-center border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-header)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 品牌 */}
      <div className="flex h-full items-center gap-2 border-r px-3" style={{ borderColor: 'var(--border)' }}>
        <span className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          L
        </span>
        <span className="text-[12.5px] font-semibold tracking-tight">Lidow</span>
      </div>
      {/* 面包屑 */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3">
        <span className="truncate text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {project?.name ?? '未打开项目'}
        </span>
        <IconChevronRight size={11} className="shrink-0" />
        <span className="truncate text-[12px] font-medium">{view === 'home' ? '工作台' : RAIL.find((r) => r.id === view)?.label}</span>
        {running && (
          <span className="ml-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: 'var(--bubble-user-bg)', color: 'var(--accent)' }}>
            <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            运行中
          </span>
        )}
      </div>
      {/* 控制区（不可拖拽） */}
      <div className="flex h-full items-center gap-1.5 pl-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {running && (
          <button className="rounded-md px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--danger)', color: 'var(--on-accent)' }} onClick={() => void stop('all')}>
            全部停止
          </button>
        )}
        {view === 'home' && (
          <button
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px]"
            style={{ background: rightOpen ? 'var(--bg-hover)' : 'transparent', color: rightOpen ? 'var(--text)' : 'var(--text-hint)' }}
            title="显示/隐藏对话面板"
            onClick={toggleRight}
          >
            <IconChat size={13} />
            对话面板
          </button>
        )}
        <span className="flex items-center gap-1.5 pl-1 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
          就绪
        </span>
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

/** 纯净模式下的危险操作确认浮层（网页对话为主体时仍需可见的审批入口） */
function ConfirmOverlay(): React.JSX.Element {
  const { confirmRequest, answerConfirm } = useStore()
  if (!confirmRequest) return <></>
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div
        className="anim-pop pointer-events-auto max-w-[560px] rounded-xl p-3.5"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--danger)', boxShadow: 'var(--shadow)' }}
      >
        <div className="mb-1.5 text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
          危险操作需要确认
        </div>
        <div className="mb-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {confirmRequest.reason}
        </div>
        <div className="flex gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12px]"
            style={{ background: 'var(--danger)', color: 'var(--on-accent)' }}
            onClick={() => void answerConfirm(true)}
          >
            允许执行
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-[12px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={() => void answerConfirm(false)}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  )
}

export function AppShell(): React.JSX.Element {
  const { booted, view, rightOpen, pureMode, pureView, notices, toggleRight, confirmRequest } = useStore()

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

  // WebTabs 在 DOM 中位置固定（顶层、纯模式侧栏之后），用 CSS 决定它是否可见 / 占据哪块区域。
  // 切换模式或视图不改变它的树位置 → webview 永不卸载 → 登录态与对话进度保留。
  const showManager = pureMode ? pureView !== 'home' : view !== 'home'
  const activeView = pureMode ? pureView : view

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      {pureMode ? <DragStrip /> : <TopBar />}

      <div className="flex min-h-0 flex-1">
        {pureMode ? <PureModeShell /> : <LeftRail />}

        {/* 主区容器：WebTabs 与各管理视图共存于同一容器，靠 display 切换 */}
        <div className="relative min-w-0 flex-1" style={{ background: 'var(--bg)' }}>
          {/* WebTabs 单点挂载：只在工作台 home 视图可见；
              纯净模式下仅作为隐藏的对话承载器（AI 网页在后台跑，前端渲染原生对话） */}
          {/* 用离屏定位而非 display:none —— display:none 会让 webview 停止布局甚至丢状态 */}
          <div
            className="h-full"
            style={
              !pureMode && view === 'home'
                ? undefined
                : { position: 'fixed', left: -99999, top: 0, width: 1280, height: 800, pointerEvents: 'none' }
            }
            aria-hidden={pureMode || view !== 'home'}
          >
            <WebTabs />
          </div>

          {/* 纯净模式对话主区：原生渲染 Lidow 会话记录 + 原生输入框（不显示网页） */}
          {pureMode && pureView === 'home' && (
            <div className="h-full">
              <ChatPanel mode="pure" />
            </div>
          )}

          {/* 管理视图：同一容器内切换 */}
          {showManager && (
            <div className="absolute inset-0 overflow-auto" style={{ background: 'var(--bg)' }}>
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

        {/* Agent 活动面板（仅工作台 home 视图） */}
        {!pureMode && view === 'home' && rightOpen && (
          <div
            className="transition-panel flex shrink-0 flex-col border-l"
            style={{ width: 420, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
          >
            <PanelHeader title="Agent 活动">
              <button
                className="rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-hint)' }}
                title="收起面板"
                onClick={toggleRight}
              >
                <IconChevronRight size={13} className="rotate-180" />
              </button>
            </PanelHeader>
            <div className="min-h-0 flex-1">
              <ChatPanel mode="workbench" />
            </div>
          </div>
        )}

        {/* 纯净模式文件预览（仅对话主区） */}
        {pureMode && pureView === 'home' && <PurePreview />}
      </div>

      {confirmRequest && <ConfirmOverlay />}

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
