import { useEffect, useRef, useState } from 'react'
import { useStore, useProject, type ViewId } from '../store'
import { api } from '../api'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { PureModeShell } from './PureModeShell'
import { RightDock } from './RightDock'
import { HelpPanel } from './HelpPanel'
import { UpdatePrompt } from './UpdatePrompt'
import {
  SessionsView,
  FilesView,
  TasksView,
  PluginsView,
  MemoryView,
  KnowledgeView,
  AuditView,
  SettingsView,
  SkillsView,
  AgentsView,
  McpView,
  QuickCommandsView,
  ProjectsView
} from './views'
import {
  RAIL_ICONS,
  IconPure,
  IconChevronRight,
  IconFolder,
  IconChevronDown,
  IconCheck,
  IconPlus,
  IconDownload,
  IconHelp,
  IconTerminal,
  IconSidebarToggle,
  IconPanelRight,
  IconFolderColor,
  IconTrash
} from './icons'
import { WindowControls, DragStrip } from './TitleBar'

const RAIL: { id: ViewId; label: string }[] = [
  { id: 'home', label: '工作台' },
  { id: 'projects', label: '工作区' },
  { id: 'sessions', label: '会话' },
  { id: 'files', label: '文件' },
  { id: 'tasks', label: '任务' },
  { id: 'skills', label: '技能' },
  { id: 'agents', label: '子代理' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: '插件' },
  { id: 'quick', label: '快捷指令' },
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
  const railPinned = useStore((s) => s.railPinned)
  const [hovered, setHovered] = useState(false)
  // 固定展开（顶栏侧栏开关）优先于悬停；两者都没有时保持图标条
  const expanded = railPinned || hovered
  return (
    <div
      className="flex h-full flex-col border-r"
      style={{
        width: expanded ? 176 : 52,
        borderColor: 'var(--border)',
        background: 'var(--sidebar)',
        transition: 'width var(--dur-slow) var(--ease-emph)',
        overflow: 'hidden'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2.5">
        {RAIL.map((item) => {
          // 资源管理器用彩色文件夹，和 Qoder 的文件入口一致
          const Icon = item.id === 'files' ? IconFolderColor : RAIL_ICONS[item.id as keyof typeof RAIL_ICONS]
          const active = view === item.id
          return (
            <button
              key={item.id}
              className="nav-item shrink-0"
              data-active={active}
              style={{
                // 收起态要同时清掉右侧 padding 和 gap：.nav-item 默认 0 9px + gap 9px，
                // 只改 paddingLeft 会让 18px 图标在 36px 按钮里偏左，右侧留一截空白。
                padding: expanded ? '0 9px 0 10px' : 0,
                gap: expanded ? 9 : 0,
                justifyContent: expanded ? 'flex-start' : 'center',
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
                  opacity: expanded ? 1 : 0,
                  width: expanded ? 'auto' : 0,
                  transition: `opacity ${expanded ? '180ms' : '90ms'} ease`
                }}
              >
                {item.label}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto shrink-0 px-2 pb-2.5">
        <div className="divider-soft mb-1.5" />
        <button
          className="nav-item shrink-0"
          style={{
            padding: expanded ? '0 9px 0 10px' : 0,
            gap: expanded ? 9 : 0,
            justifyContent: expanded ? 'flex-start' : 'center',
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
              opacity: expanded ? 1 : 0,
              width: expanded ? 'auto' : 0,
              transition: `opacity ${expanded ? '180ms' : '90ms'} ease`
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

      {/* 项目切换下拉 + 面包屑 */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
        <ProjectSwitcher />
        <IconChevronRight size={11} className="shrink-0 opacity-40" />
        <span className="truncate text-[12.5px] font-medium">
          {view === 'home' ? '工作台' : RAIL.find((r) => r.id === view)?.label}
        </span>
        {running && (
          <span
            className="ml-2 flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            运行中
          </span>
        )}
      </div>

      {/* 工具区（不可拖拽） */}
      <div className="flex h-full items-center gap-0.5 pr-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {running && (
          <button className="btn btn-sm btn-danger mr-1" onClick={() => void stop('all')}>
            停止
          </button>
        )}
        <TopActions />
      </div>
      <WindowControls />
    </div>
  )
}

/** 项目切换下拉：列出已打开项目，切换即 openProject */
function ProjectSwitcher(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const openProject = useStore((s) => s.openProject)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const active = projects.find((p) => p.id === activeProjectId)

  // 点外面收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      <button
        className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-[var(--r-md)] px-2 text-[12.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-dim)' }}
        onClick={() => setOpen((v) => !v)}
        title="切换项目"
      >
        <span style={{ color: 'var(--accent)' }}>
          <IconFolder size={13} />
        </span>
        <span className="truncate">{active?.name ?? '未打开项目'}</span>
        <IconChevronDown size={12} className={`shrink-0 transition-transform duration-[150ms] ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="anim-pop absolute left-0 top-[calc(100%+6px)] z-50 w-[280px] overflow-hidden rounded-[var(--r-lg)] p-1"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="text-label px-2 py-1.5">已打开项目</div>
          {projects.length === 0 && (
            <div className="px-2 py-2 text-[12px]" style={{ color: 'var(--text-hint)' }}>
              还没有项目
            </div>
          )}
          {projects.map((p) => {
            const isActive = p.id === activeProjectId
            return (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
                style={{ background: isActive ? 'var(--bg-active)' : 'transparent', color: isActive ? 'var(--text)' : 'var(--text-dim)' }}
                onClick={() => {
                  setOpen(false)
                  if (isActive) return
                  if (useStore.getState().streamingText && !window.confirm('当前任务仍在生成，切换项目会中断它。继续？')) return
                  void openProject(p.root)
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-[10px]" style={{ color: 'var(--text-hint)' }}>
                    {p.root}
                  </span>
                </span>
                {isActive && (
                  <span style={{ color: 'var(--accent)' }}>
                    <IconCheck size={12} />
                  </span>
                )}
              </button>
            )
          })}
          <div className="divider-soft my-1" />
          <button
            className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-dim)' }}
            onClick={() => {
              setOpen(false)
              void api.pickDirectory().then((dir) => dir && void openProject(dir))
            }}
          >
            <IconPlus size={12} /> 打开其他目录…
          </button>
        </div>
      )}
    </div>
  )
}

/** 顶栏右侧功能按钮：导出 / 帮助 / 工具侧栏 / 终端 / 侧栏开关 */
function TopActions(): React.JSX.Element {
  const activeSession = useStore((s) => s.activeSession)
  const railPinned = useStore((s) => s.railPinned)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const auxPanel = useStore((s) => s.auxPanel)
  const toggleAux = useStore((s) => s.toggleAux)
  const openAux = useStore((s) => s.openAux)
  const closeAux = useStore((s) => s.closeAux)
  const [helpOpen, setHelpOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportOpen) return
    const onDown = (e: MouseEvent): void => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [exportOpen])

  const exportMd = async (): Promise<void> => {
    if (!activeSession) {
      useStore.getState().notice('当前没有会话可导出', 'warn')
      return
    }
    try {
      const file = await api.exportSession(activeSession.id)
      useStore.getState().notice(`已导出：${file}`)
      await api.revealPath(file)
    } catch (e) {
      useStore.getState().notice(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const iconCls = 'btn btn-ghost btn-icon'
  const project = useProject(useStore())

  return (
    <>
      {/* 用外部程序打开项目（对齐 ZCode 顶栏文件夹下拉） */}
      <div ref={exportRef} className="relative">
        <button className={iconCls} title="用外部程序打开项目" onClick={() => setExportOpen((v) => !v)}>
          <IconFolder size={15} />
        </button>
        {exportOpen && (
          <div
            className="anim-pop absolute right-0 top-[calc(100%+6px)] z-50 w-[200px] overflow-hidden rounded-[var(--r-lg)] p-1"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
          >
            {[
              { id: 'explorer', label: '资源管理器' },
              { id: 'vscode', label: 'VS Code' },
              { id: 'pycharm', label: 'PyCharm' },
              { id: 'terminal', label: '终端（项目目录）' }
            ].map((x) => (
              <button
                key={x.id}
                className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-dim)' }}
                disabled={!project}
                onClick={() => {
                  setExportOpen(false)
                  if (!project) return
                  void api.openInApp(x.id, project.root).then((ok) => {
                    if (!ok) useStore.getState().notice(`无法启动 ${x.label}（可能未安装或不在 PATH 中）`, 'warn')
                  })
                }}
              >
                {x.label}
              </button>
            ))}
            <div className="divider-soft my-1" />
            <button
              className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-dim)' }}
              onClick={() => {
                setExportOpen(false)
                void exportMd()
              }}
            >
              导出当前会话
            </button>
          </div>
        )}
      </div>

      {/* 导出（保留快捷入口）。原下拉已移到上方文件夹按钮 */}
      {/* 导出会话（快捷入口，下拉见上方文件夹按钮） */}
      <button className={iconCls} title="导出当前会话" onClick={() => void exportMd()}>
        <IconDownload size={15} />
      </button>

      {/* 帮助 */}
      <button className={iconCls} title="帮助" onClick={() => setHelpOpen(true)}>
        <IconHelp size={15} />
      </button>

      {/* 工具侧栏（文件 / 任务 / 审阅） */}
      <button
        className={iconCls}
        title={auxPanel === 'files' ? '收起文件面板' : '打开文件面板'}
        style={{ color: auxPanel === 'files' ? 'var(--accent)' : undefined }}
        onClick={() => (auxPanel === 'files' ? closeAux() : openAux('files'))}
      >
        <IconPanelRight size={15} />
      </button>

      {/* 终端（右侧面板） */}
      <button
        className={iconCls}
        title="终端 (Ctrl `)"
        style={{ color: auxPanel === 'terminal' ? 'var(--accent)' : undefined }}
        onClick={() => toggleAux('terminal')}
      >
        <IconTerminal size={15} />
      </button>

      {/* 侧栏开关 */}
      <button
        className={iconCls}
        title={railPinned ? '收起侧栏' : '固定展开侧栏'}
        style={{ color: railPinned ? 'var(--accent)' : undefined }}
        onClick={() => setRailPinned(!railPinned)}
      >
        <IconSidebarToggle size={15} />
      </button>

      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
    </>
  )
}

/** 初始化完成后的模式建议：是否立刻进入纯净模式（可稍后从左侧栏进入） */
function PureModeSuggestion(): React.JSX.Element | null {
  const open = useStore((s) => s.pureSuggestion)
  const dismiss = useStore((s) => s.dismissPureSuggestion)
  const setPure = useStore((s) => s.setPure)
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-6"
      style={{ background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' }}
    >
      <div
        className="anim-pop w-full max-w-[388px] overflow-hidden rounded-[18px]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: '0 24px 64px rgba(0,0,0,.28)' }}
      >
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <IconPure size={15} />
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold leading-tight">项目已初始化</div>
              <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                可以开始第一个任务了
              </div>
            </div>
          </div>

          <div className="mt-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            切换到纯净模式，只保留对话与网页，屏蔽其余界面，专注当前任务。
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
            <IconPure size={11} />
            不想现在切换？之后随时可以从左侧栏底部的「纯净模式」进入。
          </div>
        </div>
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
        >
          <button className="btn btn-sm btn-ghost" onClick={dismiss}>
            稍后再说
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              dismiss()
              setPure(true)
            }}
          >
            进入纯净模式
          </button>
        </div>
      </div>
    </div>
  )
}

/** 删除会话：选择只删本地，或同时删除网页端对话 */
function SessionDeleteDialog(): React.JSX.Element | null {
  const req = useStore((s) => s.sessionDelete)
  const cancel = useStore((s) => s.cancelSessionDelete)
  const perform = useStore((s) => s.performSessionDelete)
  const [deleteWeb, setDeleteWeb] = useState(false)
  useEffect(() => {
    setDeleteWeb(false)
  }, [req?.id])
  if (!req) return null

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center px-6"
      style={{ background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' }}
    >
      <div
        className="anim-pop w-full max-w-[388px] overflow-hidden rounded-[18px]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: '0 24px 64px rgba(0,0,0,.28)' }}
      >
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
              style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
            >
              <IconTrash size={15} />
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold leading-tight">删除会话</div>
              <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                {req.title}
              </div>
            </div>
          </div>

          {req.canDeleteWeb ? (
            <button
              role="checkbox"
              aria-checked={deleteWeb}
              className="mt-4 flex w-full items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors duration-[130ms]"
              style={{
                borderColor: deleteWeb ? 'color-mix(in srgb, var(--danger) 45%, var(--border))' : 'var(--border)',
                background: deleteWeb ? 'var(--danger-soft)' : 'var(--surface-sunken)'
              }}
              onClick={() => setDeleteWeb((v) => !v)}
            >
              <span
                className="mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[130ms]"
                style={{
                  borderColor: deleteWeb ? 'var(--danger)' : 'var(--border-strong)',
                  background: deleteWeb ? 'var(--danger)' : 'transparent',
                  color: '#fff'
                }}
              >
                {deleteWeb && <IconCheck size={10} />}
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium">同时删除 {req.providerName} 网页端对话</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                  会在网页侧边栏中定位并删除，不可恢复
                </span>
              </span>
            </button>
          ) : (
            <div className="mt-4 rounded-[12px] px-3 py-2.5 text-[11.5px] leading-relaxed" style={{ background: 'var(--surface-sunken)', color: 'var(--text-hint)' }}>
              当前平台暂不支持从 Lidow 删除网页端对话，只会移除本地记录。
            </div>
          )}

          <div className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
            删除后网页会切到新对话；本地记录不可恢复。
          </div>
        </div>
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
        >
          <button className="btn btn-sm btn-ghost" onClick={cancel}>
            取消
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void perform(deleteWeb && req.canDeleteWeb)}>
            删除
          </button>
        </div>
      </div>
    </div>
  )
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

  // 终端快捷键：Ctrl ` 开合右侧终端面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        useStore.getState().toggleAux('terminal')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

          {/* 管理视图：不用动画类。此前外层 anim-fade + Page 内 anim-view 双重入场，
              每次切页先淡入再上移，视觉上是"顿一下"；且外层 overflow-auto 与
              Page 自己的滚动区叠加成双层滚动容器，切换时还会重算两遍布局。 */}
          {showManager && (
            <div className="absolute inset-0 z-10" style={{ background: 'var(--bg)' }}>
              {activeView === 'projects' && <ProjectsView />}
              {activeView === 'sessions' && <SessionsView />}
              {activeView === 'files' && <FilesView />}
              {activeView === 'tasks' && <TasksView />}
              {activeView === 'skills' && <SkillsView />}
              {activeView === 'agents' && <AgentsView />}
              {activeView === 'mcp' && <McpView />}
              {activeView === 'plugins' && <PluginsView />}
              {activeView === 'quick' && <QuickCommandsView />}
              {activeView === 'memory' && <MemoryView />}
              {activeView === 'knowledge' && <KnowledgeView />}
              {activeView === 'audit' && <AuditView />}
              {activeView === 'settings' && <SettingsView />}
            </div>
          )}
        </div>

        {/* 右侧工具侧栏：文件 / 任务 / 终端 / 审阅 */}
        <RightDock />
      </div>

      {/* 更新提示：发现新版本 / 下载进度 / 自动安装倒计时 */}
      <UpdatePrompt />

      {/* 初始化完成 → 询问是否进入纯净模式 */}
      <PureModeSuggestion />

      {/* 删除会话 → 是否同步删除网页端对话 */}
      <SessionDeleteDialog />

      {/* 确认浮层：纯净模式下 ChatPanel 自带内联确认卡，这里不重复渲染 */}
      {confirmRequest && !(pureMode && pureView === 'home') && <ConfirmOverlay />}

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
