import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { WEB_MODE, useStore, type AuxPanel } from '../store'
import {
  IconMinimize,
  IconMaximize,
  IconRestore,
  IconClose,
  IconChevronDown,
  IconDiff,
  IconFile,
  IconFolderColor,
  IconList,
  IconPanelRight,
  IconSpark,
  IconTerminal
} from './icons'

/**
 * 自绘窗口控制（Windows/Linux 关闭原生 frame 后必需）。
 * 按钮区域必须 no-drag，否则会被标题栏拖拽区吞掉点击。
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized)
  }, [])
  const cls =
    'group flex h-full w-[46px] items-center justify-center transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'
  const iconColor = { color: 'var(--text-hint)' } as const
  return (
    <div className="flex h-full items-stretch" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button className={cls} style={iconColor} title="最小化" onClick={() => api.windowMinimize()}>
        <IconMinimize />
      </button>
      <button
        className={cls}
        style={iconColor}
        title={maximized ? '向下还原' : '最大化'}
        onClick={() => void api.windowToggleMaximize().then(setMaximized)}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        className="flex h-full w-[46px] items-center justify-center transition-colors duration-[130ms] hover:bg-[var(--danger)] hover:text-white"
        style={iconColor}
        title="关闭"
        onClick={() => api.windowClose()}
      >
        <IconClose />
      </button>
    </div>
  )
}

type ToolPanelId = AuxPanel

const TOOL_MENU: {
  id: ToolPanelId
  label: string
  shortcut: string
  icon: (props: { size?: number; className?: string }) => React.JSX.Element
}[] = [
  { id: 'files', label: '文件面板', shortcut: 'Ctrl Alt E', icon: IconFile },
  { id: 'tasks', label: '任务', shortcut: '', icon: IconList },
  { id: 'terminal', label: '终端', shortcut: 'Ctrl Shift J', icon: IconTerminal },
  { id: 'review', label: '审阅', shortcut: 'Ctrl Shift G', icon: IconDiff }
]

/** 纯模式会话头右侧工具条：文件夹菜单 / 快捷操作 / 任务 / 侧栏（对齐 Qoder） */
export function PureToolbar(): React.JSX.Element {
  const auxPanel = useStore((s) => s.auxPanel)
  const openAux = useStore((s) => s.openAux)
  const closeAux = useStore((s) => s.closeAux)
  const [menuOpen, setMenuOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const quickRef = useRef<HTMLDivElement>(null)
  /** 侧栏开关打开时默认显示上次用过的工具面板（Qoder 同款） */
  const lastPanelRef = useRef<ToolPanelId>('files')
  const btn = 'flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'
  const idle = { color: 'var(--text-dim)' } as const
  const active = { color: 'var(--accent)', background: 'var(--accent-soft)' } as const

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  useEffect(() => {
    if (!quickOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!quickRef.current?.contains(e.target as Node)) setQuickOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [quickOpen])

  // 快捷键/其他入口切换面板时，顺便收起两个浮层
  useEffect(() => {
    setMenuOpen(false)
    setQuickOpen(false)
    if (auxPanel) lastPanelRef.current = auxPanel
  }, [auxPanel])

  const openPanel = (id: ToolPanelId): void => {
    setMenuOpen(false)
    setQuickOpen(false)
    openAux(id)
  }

  const openProjectFolder = (): void => {
    const st = useStore.getState()
    const project = st.projects.find((p) => p.id === st.activeProjectId) ?? st.projects[0]
    if (!project) {
      st.notice('请先初始化项目', 'warn')
      return
    }
    if (project.missing) {
      st.notice('项目目录不存在，请到「工作区」重新选择目录', 'warn')
      st.setView('projects')
      return
    }
    setMenuOpen(false)
    setQuickOpen(false)
    // Web 版没有本机文件管理器，退回到右侧文件面板
    if (WEB_MODE) {
      openAux('files')
      return
    }
    void api.openPathInSystem(project.root).catch((e) => {
      st.notice(`打开项目目录失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
      st.setView('projects')
    })
  }

  return (
    <div
      className="flex items-center gap-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div
        ref={menuRef}
        className="relative flex h-7 items-center overflow-visible rounded-full"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <button
          className="flex h-7 items-center justify-center rounded-l-full pl-2.5 pr-1.5 transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
          style={idle}
          title="打开项目文件夹"
          onClick={openProjectFolder}
        >
          <IconFolderColor size={15} />
        </button>
        <span className="h-3.5 w-px shrink-0" style={{ background: 'var(--border)' }} />
        <button
          className="flex h-7 w-7 items-center justify-center rounded-r-full transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
          style={menuOpen ? active : idle}
          title="文件与工具"
          onClick={() => {
            setQuickOpen(false)
            setMenuOpen((v) => !v)
          }}
        >
          <IconChevronDown size={10} />
        </button>
        {menuOpen && (
          <div
            className="anim-pop absolute right-0 top-full z-[70] mt-1.5 w-[218px] rounded-[var(--r-lg)] p-1"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
          >
            <button
              className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[11.5px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
              onClick={openProjectFolder}
            >
              <span className="flex w-4 shrink-0 justify-center" style={{ color: 'var(--text-dim)' }}>
                <IconFolderColor size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate">文件资源管理器</span>
            </button>
            {TOOL_MENU.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[11.5px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
                  onClick={() => openPanel(item.id)}
                >
                  <span className="flex w-4 shrink-0 justify-center" style={{ color: 'var(--text-dim)' }}>
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-hint)' }}>
                      {item.shortcut}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div ref={quickRef} className="relative">
        <button
          className={btn}
          style={quickOpen ? active : idle}
          title="快捷操作"
          onClick={() => {
            setMenuOpen(false)
            setQuickOpen((v) => !v)
          }}
        >
          <IconSpark size={14} />
        </button>
        {quickOpen && (
          <div
            className="anim-pop absolute right-0 top-full z-[70] mt-1.5 w-[218px] rounded-[var(--r-lg)] p-1"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium" style={{ color: 'var(--text-hint)' }}>
              快捷操作
            </div>
            <button
              className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[11.5px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
              onClick={openProjectFolder}
            >
              <span className="flex w-4 shrink-0 justify-center" style={{ color: 'var(--text-dim)' }}>
                <IconFolderColor size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate">文件资源管理器</span>
            </button>
            {TOOL_MENU.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[11.5px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
                  onClick={() => openPanel(item.id)}
                >
                  <span className="flex w-4 shrink-0 justify-center" style={{ color: 'var(--text-dim)' }}>
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-hint)' }}>
                      {item.shortcut}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <button
        className={btn}
        style={auxPanel === 'tasks' ? active : idle}
        title="侧边任务"
        onClick={() => openPanel('tasks')}
      >
        <IconList size={14} />
      </button>
      <button
        className={btn}
        style={auxPanel ? active : idle}
        title={auxPanel ? '收起侧栏' : '打开侧栏'}
        onClick={() => (auxPanel ? closeAux() : openAux(lastPanelRef.current))}
      >
        <IconPanelRight size={14} />
      </button>
    </div>
  )
}

/** 纯模式顶部拖拽条：左侧留白可拖拽，右侧只保留窗口控件 */
export function DragStrip(): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-end border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--sidebar)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <WindowControls />
    </div>
  )
}
