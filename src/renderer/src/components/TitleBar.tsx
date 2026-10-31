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
    'group flex h-full w-10 items-center justify-center transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]'
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
        className="flex h-full w-10 items-center justify-center transition-colors duration-[110ms] hover:bg-[var(--danger)] hover:text-white"
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

type PureMenuItem = {
  label: string
  shortcut?: string
  action?: () => void
  separator?: boolean
}

/** 纯模式顶部菜单栏：Qoder 风格 文件 / 编辑 / 视图 / 帮助 */
export function PureMenuBar(): React.JSX.Element {

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 点击空白处关闭菜单
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const newTask = (): void => {
    const s = useStore.getState()
    const pid = s.activeSession?.providerId ?? s.providers[0]?.id
    if (!pid) {
      s.notice('请先选择一个平台', 'warn')
      return
    }
    s.setPureView('home')
    void (async () => {
      await s.createSession(pid)
      const created = useStore.getState().activeSession
      if (created) await s.openProviderTab(created.providerId, created.id, created.accountId)
    })()
  }

  const menus: Record<string, PureMenuItem[]> = {
    文件: [
      { label: '新建任务', shortcut: 'Ctrl N', action: newTask },
      {
        label: '切换项目…',
        action: () => {
          void api.pickDirectory().then((dir) => dir && void useStore.getState().openProject(dir))
        }
      },
      { label: '', separator: true },
      { label: '设置', action: () => useStore.getState().setPureView('settings') },
      { label: '', separator: true },
      { label: '退出 Lidow', action: () => void api.quit() }
    ],
    编辑: [
      { label: '撤销', shortcut: 'Ctrl Z', action: () => void api.editAction('undo') },
      { label: '重做', shortcut: 'Ctrl Y', action: () => void api.editAction('redo') },
      { label: '', separator: true },
      { label: '剪切', shortcut: 'Ctrl X', action: () => void api.editAction('cut') },
      { label: '复制', shortcut: 'Ctrl C', action: () => void api.editAction('copy') },
      { label: '粘贴', shortcut: 'Ctrl V', action: () => void api.editAction('paste') },
      { label: '全选', shortcut: 'Ctrl A', action: () => void api.editAction('selectAll') }
    ],
    视图: [
      { label: '返回工作台', action: () => useStore.getState().setPure(false) },
      {
        label: '命令面板',
        shortcut: 'Ctrl K',
        action: () => window.dispatchEvent(new CustomEvent('lidow:command'))
      }
    ],
    帮助: [
      { label: '检查更新', action: () => void useStore.getState().checkUpdate(true) },
      {
        label: 'GitHub 仓库',
        action: () => void api.openExternal('https://github.com/cv-superding/lidow')
      },
      {
        label: '关于 Lidow',
        action: () => {
          const s = useStore.getState()
          s.notice(`Lidow ${s.version}`, 'info')
        }
      }
    ]
  }

  return (
    <div
      ref={barRef}
      className="flex h-10 shrink-0 items-center border-b"
      style={
        {
          borderColor: 'var(--border)',
          background: 'var(--surface-2)',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties
      }
    >
      <div
        className="flex h-full items-center gap-0.5 pl-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span
          className="mr-1.5 flex h-5 w-5 items-center justify-center rounded-[6px] text-[11px] font-bold"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          L
        </span>
        {Object.keys(menus).map((title) => (
          <div key={title} className="relative flex h-full items-center">
            <button
              className="flex h-7 items-center rounded-[var(--r-sm)] px-2 text-[12px] transition-colors duration-[110ms]"
              style={{
                color: openMenu === title ? 'var(--text)' : 'var(--text-dim)',
                background: openMenu === title ? 'var(--bg-hover)' : 'transparent'
              }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                if (openMenu && openMenu !== title) setOpenMenu(title)
              }}
              onClick={() => setOpenMenu((v) => (v === title ? null : title))}
            >
              {title}
            </button>
            {openMenu === title && (
              <div
                className="absolute left-0 top-full z-[90] w-[210px] overflow-hidden rounded-[var(--r-md)] p-1"
                style={{
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--border)',
                  boxShadow: 'var(--shadow-menu)'
                }}
              >
                {menus[title]!.map((item, i) =>
                  item.separator ? (
                    <div
                      key={`sep-${i}`}
                      className="my-1 h-px"
                      style={{ background: 'var(--border-soft)' }}
                    />
                  ) : (
                    <button
                      key={item.label}
                      className="flex w-full items-center gap-4 rounded-[var(--r-sm)] px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setOpenMenu(null)
                        item.action?.()
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.shortcut && (
                        <span
                          className="shrink-0 text-[10px]"
                          style={{ color: 'var(--text-hint)' }}
                        >
                          {item.shortcut}
                        </span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="h-full flex-1" />
      <WindowControls />
    </div>
  )
}
