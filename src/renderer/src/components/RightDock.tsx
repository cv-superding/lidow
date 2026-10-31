import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useActiveProject, useStore, type AuxPanel } from '../store'
import { ResizeHandle } from './ResizeHandle'
import { TerminalPanel } from './TerminalPanel'
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconDiff,
  IconFile,
  IconFolder,
  IconFolderColor,
  IconList,
  IconRefresh,
  IconTerminal
} from './icons'
import type { TaskItem } from '@shared/types'

const PANEL_TITLES: Record<AuxPanel, string> = {
  files: '文件资源管理器',
  tasks: '侧边任务',
  terminal: '终端',
  review: '审阅'
}

/** 右侧工具侧栏：Qoder 同款标题栏 + 快捷操作 / 文件 / 任务 / 终端 / 审阅 */
export function RightDock(): React.JSX.Element | null {
  const panel = useStore((s) => s.auxPanel)
  const width = useStore((s) => s.auxWidth)
  const setWidth = useStore((s) => s.setAuxWidth)
  const closeAux = useStore((s) => s.closeAux)
  const openAux = useStore((s) => s.openAux)
  const todos = useStore((s) => s.todos)
  const reviewFiles = useStore((s) => s.reviewFiles)
  if (!panel) return null
  const tabs = [
    { id: 'files' as const, label: '文件', icon: IconFile, count: 0 },
    { id: 'tasks' as const, label: '任务', icon: IconList, count: todos.filter((t) => t.status !== 'done' && t.status !== 'skipped').length },
    { id: 'terminal' as const, label: '终端', icon: IconTerminal, count: 0 },
    { id: 'review' as const, label: '审阅', icon: IconDiff, count: reviewFiles.length }
  ]

  return (
    <div
      className="right-dock relative flex h-full shrink-0 flex-col border-l"
      style={{ width, borderColor: 'var(--border)', background: 'var(--surface)', zIndex: 40 }}
    >
      <ResizeHandle
        side="left"
        width={width}
        onResize={setWidth}
        min={280}
        max={620}
        title="拖动调整右侧面板宽度（双击复位）"
      />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5" style={{ borderColor: 'var(--border)' }}>
        <div className="flex min-w-0 flex-1 items-center gap-[2px] rounded-[var(--r-md)] p-[3px]" style={{ background: 'var(--surface-sunken)' }}>
          {tabs.map((tab) => {
            const Icon = tab.icon
            const active = panel === tab.id
            return (
              <button
                key={tab.id}
                className="flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-[11.5px] transition-colors duration-[110ms]"
                style={{
                  background: active ? 'var(--surface)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                  boxShadow: active ? 'var(--shadow-sm)' : 'none',
                  fontWeight: active ? 500 : 400
                }}
                onClick={() => openAux(tab.id)}
                title={PANEL_TITLES[tab.id]}
              >
                <Icon size={12} />
                <span className="truncate">{tab.label}</span>
                {tab.count > 0 && (
                  <span className="text-[9.5px] tabular-nums" style={{ color: 'var(--text-hint)' }}>
                    {tab.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-hint)' }}
          title="收起侧栏"
          onClick={closeAux}
        >
          <IconClose size={11} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {panel === 'files' && <FilesPanel />}
        {panel === 'tasks' && <TasksPanel />}
        {/* 终端常驻挂载：切到文件/任务面板时不能丢执行中的输出与历史 */}
        <div className={panel === 'terminal' ? 'h-full' : 'hidden'}>
          <TerminalPanel embedded active={panel === 'terminal'} onClose={closeAux} />
        </div>
        {panel === 'review' && <ReviewPanel />}
      </div>
    </div>
  )
}

function EmptyHint({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
      <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
        {title}
      </div>
      {hint && (
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function FilesPanel(): React.JSX.Element {
  const project = useActiveProject()
  const fileTree = useStore((s) => s.fileTree)
  const selectedFile = useStore((s) => s.selectedFile)
  const [loading, setLoading] = useState(false)
  const pid = project?.id ?? ''
  const root = project?.root ?? ''

  useEffect(() => {
    if (!pid) {
      useStore.setState({ fileTree: [], selectedFile: null })
      return
    }
    let alive = true
    // 切项目立即清空旧树/旧预览，避免新请求返回前还能点到上一个项目的文件
    useStore.setState({ fileTree: [], selectedFile: null })
    setLoading(true)
    void api
      .readFileTree(pid, '', 3)
      .then((tree) => {
        if (alive) useStore.setState({ fileTree: tree, selectedFile: null })
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [pid])

  const refresh = (): void => {
    if (!pid) return
    setLoading(true)
    void api
      .readFileTree(pid, '', 3)
      .then((tree) => {
        if (useStore.getState().activeProjectId === pid) useStore.setState({ fileTree: tree })
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }

  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  useEffect(() => {
    setCollapsedDirs(new Set())
  }, [pid])
  const toggleDir = (path: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openSeq = useRef(0)
  const openFile = (path: string): void => {
    if (!pid) return
    const seq = ++openSeq.current
    void api
      .readFileContent(pid, path)
      .then((content) => {
        // 快速连点两个文件时，旧响应不能覆盖新预览
        if (seq !== openSeq.current) return
        if (useStore.getState().activeProjectId !== pid) return
        useStore.setState({ selectedFile: { path, content } })
      })
      .catch((e) => useStore.getState().notice(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  const renderNodes = (items: typeof fileTree, depth: number): React.JSX.Element[] =>
    items.map((n) => {
      const isDir = n.type === 'dir'
      const collapsed = collapsedDirs.has(n.path)
      return (
        <div key={n.path}>
          <button
            className={`flex w-full items-center gap-1 truncate rounded-[var(--r-sm)] py-[4px] pr-2 text-left text-[11.5px] transition-colors duration-[110ms] ${
              selectedFile?.path === n.path
                ? 'bg-[var(--bg-active)]'
                : 'hover:bg-[var(--bg-hover)]'
            }`}
            style={{
              paddingLeft: 6 + depth * 12,
              color:
                selectedFile?.path === n.path
                  ? 'var(--text)'
                  : isDir
                    ? 'var(--text-body)'
                    : 'var(--text-dim)'
            }}
            aria-expanded={isDir ? !collapsed : undefined}
            onClick={() => (isDir ? toggleDir(n.path) : openFile(n.path))}
          >
            <span className="flex w-3 shrink-0 justify-center">
              {isDir && (
                <IconChevronRight
                  size={10}
                  className={`transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
                />
              )}
            </span>
            <span className="shrink-0">
              {isDir ? <IconFolderColor size={13} /> : <IconFile size={12} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
          </button>
          {isDir && !collapsed && n.children && renderNodes(n.children, depth + 1)}
        </div>
      )
    })

  if (!project) {
    return <EmptyHint title="先打开一个项目" hint="项目打开后可在这里浏览工作区文件" />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: 'var(--border-soft)' }}>
        <IconFolderColor size={14} />
        <span className="truncate text-[11.5px] font-medium">{project.name}</span>
        {loading && (
          <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
        )}
        <span className="flex-1" />
        <button className="btn btn-sm btn-ghost btn-icon" title="在资源管理器中打开" onClick={() => void api.revealPath(root)}>
          <IconFolder size={12} />
        </button>
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新文件树" onClick={refresh}>
          <IconRefresh size={12} />
        </button>
      </div>
      <div className="max-h-[45%] min-h-[90px] overflow-y-auto px-1 py-1">
        {fileTree.length === 0 ? (
          <div className="px-2 py-3 text-[11px]" style={{ color: 'var(--text-hint)' }}>
            {loading ? '正在读取…' : '目录为空'}
          </div>
        ) : (
          renderNodes(fileTree, 0)
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t px-3 py-2" style={{ borderColor: 'var(--border-soft)' }}>
        {selectedFile ? (
          <>
            <div className="mb-1.5 flex items-center gap-1.5">
              <IconFile size={12} />
              <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                {selectedFile.path}
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.65]" style={{ color: 'var(--text-body)' }}>
              {selectedFile.content}
            </pre>
          </>
        ) : (
          <EmptyHint title="选择文件预览" hint="上方文件树点击任意文件" />
        )}
      </div>
    </div>
  )
}

const TODO_STATUS: { id: TaskItem['status']; label: string; color: string }[] = [
  { id: 'pending', label: '待办', color: 'var(--text-hint)' },
  { id: 'running', label: '进行中', color: 'var(--accent)' },
  { id: 'done', label: '完成', color: 'var(--success)' },
  { id: 'failed', label: '失败', color: 'var(--danger)' },
  { id: 'skipped', label: '跳过', color: 'var(--text-hint)' }
]

function TasksPanel(): React.JSX.Element {
  const todos = useStore((s) => s.todos)
  const projectId = useStore((s) => s.activeProjectId)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!projectId) {
      useStore.setState({ todos: [] })
      return
    }
    let alive = true
    void api
      .listTodos()
      .then((t) => {
        // 切项目后旧项目的任务列表可能晚到
        if (alive && useStore.getState().activeProjectId === projectId)
          useStore.setState({ todos: t })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  const add = (): void => {
    const text = title.trim()
    if (!text) return
    void api
      .addTodo(text)
      .then((t) => {
        useStore.setState({ todos: t })
        setTitle('')
      })
      .catch((e) => {
        useStore
          .getState()
          .notice(`添加任务失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
      })
  }
  const setStatus = (t: TaskItem, status: TaskItem['status']): void => {
    void api
      .setTodoStatus(t.id, status)
      .then((list) => useStore.setState({ todos: list }))
      .catch((e) => {
        useStore
          .getState()
          .notice(`更新任务失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
      })
  }
  const done = todos.filter((t) => t.status === 'done').length

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2.5" style={{ borderColor: 'var(--border-soft)' }}>
        <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
          已完成 {done} / {todos.length}
        </span>
        <span className="flex-1" />
        <button
          className="btn btn-sm btn-ghost"
          title="刷新任务"
          onClick={() =>
            void api.listTodos().then((t) => useStore.setState({ todos: t })).catch(() => undefined)
          }
        >
          <IconRefresh size={12} />
        </button>
        <button
          className="btn btn-sm btn-ghost"
          disabled={done === 0}
          onClick={() =>
            void api
              .clearDoneTodos()
              .then((t) => useStore.setState({ todos: t }))
              .catch(() => undefined)
          }
        >
          清理已完成
        </button>
      </div>
      <div className="flex shrink-0 gap-1.5 border-b p-2" style={{ borderColor: 'var(--border-soft)' }}>
        <input
          className="field h-7 min-w-0 flex-1 text-[11.5px]"
          placeholder="添加待办，回车确认"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') add()
          }}
        />
        <button className="btn btn-sm btn-primary shrink-0" disabled={!title.trim()} onClick={add}>
          添加
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {todos.length === 0 ? (
          <EmptyHint title="暂无任务" hint="AI 执行多步任务时，会用 todoWrite 把进度同步到这里" />
        ) : (
          todos.map((t) => {
            const st = TODO_STATUS.find((x) => x.id === t.status)
            const isDone = t.status === 'done'
            return (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
              >
                <button
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                  style={{
                    borderColor: isDone ? 'var(--success)' : 'var(--border-strong)',
                    background: isDone ? 'var(--success)' : 'transparent',
                    color: isDone ? '#fff' : st?.color
                  }}
                  title={isDone ? '标记为待办' : '标记完成'}
                  onClick={() => setStatus(t, isDone ? 'pending' : 'done')}
                >
                  {isDone && <IconCheck size={10} />}
                </button>
                <span
                  className={`min-w-0 flex-1 truncate text-[11.5px] ${isDone ? 'line-through opacity-50' : ''}`}
                  title={t.title}
                >
                  {t.title}
                </span>
                <select
                  className="shrink-0 cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent text-[10px] outline-none"
                  style={{ color: st?.color ?? 'var(--text-hint)' }}
                  value={t.status}
                  onChange={(e) => setStatus(t, e.target.value as TaskItem['status'])}
                >
                  {TODO_STATUS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function ReviewPanel(): React.JSX.Element {
  const files = useStore((s) => s.reviewFiles)
  const activePath = useStore((s) => s.reviewActivePath)
  const setReviewFile = useStore((s) => s.setReviewFile)
  if (files.length === 0) {
    return <EmptyHint title="暂无文件变更" hint="对话里点击「N 个文件已修改」，差异会在这里展开" />
  }
  const active = files.find((f) => f.path === activePath) ?? files[0]!
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2.5" style={{ borderColor: 'var(--border-soft)' }}>
        <span className="text-[11.5px] font-medium">{files.length} 个文件</span>
        <span className="text-[10.5px]" style={{ color: 'var(--success)' }}>
          +{add}
        </span>
        <span className="text-[10.5px]" style={{ color: 'var(--danger)' }}>
          −{del}
        </span>
      </div>
      <div className="max-h-[38%] min-h-[80px] overflow-y-auto border-b p-1" style={{ borderColor: 'var(--border-soft)' }}>
        {files.map((f) => {
          const isActive = f.path === active.path
          return (
            <button
              key={f.path}
              className={`flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-left text-[11.5px] transition-colors duration-[110ms] ${
                isActive ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
              style={{ color: isActive ? 'var(--text)' : 'var(--text-dim)' }}
              onClick={() => setReviewFile(f.path)}
              title={f.path}
            >
              <IconFile size={11} />
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">{f.path}</span>
              {f.add > 0 && <span style={{ color: 'var(--success)' }}>+{f.add}</span>}
              {f.del > 0 && <span style={{ color: 'var(--danger)' }}>−{f.del}</span>}
            </button>
          )
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[10.5px] leading-[1.6]">
        {active.patch.split('\n').map((line, i) => {
          const addLine = line.startsWith('+') && !line.startsWith('+++')
          const delLine = line.startsWith('-') && !line.startsWith('---')
          return (
            <div
              key={i}
              className="flex min-w-0 px-2"
              style={{
                background: addLine ? 'rgba(34,197,94,.10)' : delLine ? 'rgba(239,68,68,.10)' : undefined,
                color: addLine ? 'var(--success)' : delLine ? 'var(--danger)' : 'var(--text-body)'
              }}
            >
              <span className="w-7 shrink-0 select-none pr-2 text-right" style={{ color: 'var(--text-hint)', opacity: 0.55 }}>
                {i + 1}
              </span>
              <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
