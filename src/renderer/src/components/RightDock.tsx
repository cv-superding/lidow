import { useEffect, useState } from 'react'
import { api } from '../api'
import { useProject, useStore, type AuxPanel } from '../store'
import { ResizeHandle } from './ResizeHandle'
import { TerminalPanel } from './TerminalPanel'
import {
  IconCheck,
  IconClose,
  IconDiff,
  IconFile,
  IconFolder,
  IconFolderColor,
  IconRefresh,
  IconTerminal
} from './icons'
import type { TaskItem } from '@shared/types'

const TABS: { id: AuxPanel; label: string }[] = [
  { id: 'files', label: '文件' },
  { id: 'tasks', label: '任务' },
  { id: 'terminal', label: '终端' },
  { id: 'review', label: '审阅' }
]

function TabIcon({ id, size = 13 }: { id: AuxPanel; size?: number }): React.JSX.Element {
  if (id === 'files') return <IconFolderColor size={size + 1} />
  if (id === 'tasks') return <IconCheck size={size} />
  if (id === 'terminal') return <IconTerminal size={size} />
  return <IconDiff size={size} />
}

/** 右侧工具侧栏：文件 / 任务 / 终端 / 审阅（对齐 Qoder 的右侧面板） */
export function RightDock(): React.JSX.Element | null {
  const panel = useStore((s) => s.auxPanel)
  const width = useStore((s) => s.auxWidth)
  const setWidth = useStore((s) => s.setAuxWidth)
  const openAux = useStore((s) => s.openAux)
  const closeAux = useStore((s) => s.closeAux)
  if (!panel) return null

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-l"
      style={{ width, borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <ResizeHandle
        side="left"
        width={width}
        onResize={setWidth}
        min={280}
        max={620}
        title="拖动调整右侧面板宽度（双击复位）"
      />
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5" style={{ borderColor: 'var(--border)' }}>
        {TABS.map((t) => {
          const active = panel === t.id
          return (
            <button
              key={t.id}
              className="flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[11.5px] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
              style={{
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-dim)'
              }}
              onClick={() => openAux(t.id)}
              title={t.label}
            >
              <TabIcon id={t.id} />
              <span>{t.label}</span>
            </button>
          )
        })}
        <span className="flex-1" />
        <button
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-sm)] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
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
        {panel === 'terminal' && <TerminalPanel embedded onClose={closeAux} />}
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
  const project = useProject(useStore())
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
      .then((tree) => useStore.setState({ fileTree: tree }))
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }

  const openFile = (path: string): void => {
    if (!pid) return
    void api
      .readFileContent(pid, path)
      .then((content) => useStore.setState({ selectedFile: { path, content } }))
      .catch((e) => useStore.getState().notice(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  const renderNodes = (items: typeof fileTree, depth: number): React.JSX.Element[] =>
    items.map((n) => (
      <div key={n.path}>
        <button
          className="flex w-full items-center gap-1.5 truncate rounded-[var(--r-sm)] py-[4px] pr-2 text-left text-[11.5px] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
          style={{
            paddingLeft: 6 + depth * 12,
            color: selectedFile?.path === n.path ? 'var(--text)' : n.type === 'dir' ? 'var(--text-body)' : 'var(--text-dim)',
            background: selectedFile?.path === n.path ? 'var(--bg-active)' : 'transparent'
          }}
          onClick={() => n.type === 'file' && openFile(n.path)}
        >
          <span className="shrink-0">{n.type === 'dir' ? <IconFolderColor size={13} /> : <IconFile size={12} />}</span>
          <span className="truncate">{n.name}</span>
        </button>
        {n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

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
    void api
      .listTodos()
      .then((t) => useStore.setState({ todos: t }))
      .catch(() => undefined)
  }, [projectId])

  const add = (): void => {
    const text = title.trim()
    if (!text) return
    void api.addTodo(text).then((t) => {
      useStore.setState({ todos: t })
      setTitle('')
    })
  }
  const setStatus = (t: TaskItem, status: TaskItem['status']): void => {
    void api.setTodoStatus(t.id, status).then((list) => useStore.setState({ todos: list }))
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
          disabled={done === 0}
          onClick={() => void api.clearDoneTodos().then((t) => useStore.setState({ todos: t }))}
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
              className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-left text-[11.5px] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
              style={{ background: isActive ? 'var(--bg-active)' : 'transparent', color: isActive ? 'var(--text)' : 'var(--text-dim)' }}
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
