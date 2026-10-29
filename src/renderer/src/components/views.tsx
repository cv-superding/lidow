import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject, useStore } from '../store'
import { api } from '../api'
import type { AgentMeta, AppSettings, InstalledPlugin, MarketPlugin, ProjectInfo, QuickCommand, SkillMeta, TaskItem } from '@shared/types'
import {
  IconPlus,
  IconRefresh,
  IconTrash,
  IconCheck,
  IconFolder,
  IconFolderOpen,
  IconFile,
  IconSearch,
  IconBulb,
  IconHand,
  IconGlobe,
  IconSpark
} from './icons'

/** 统一页面骨架：标题区 + 滚动内容
 *  只做纯淡入、不做位移：此前 anim-view（fadeUp 上移 6px）叠外层淡入，
 *  切页时整块内容先上移再落位，就是用户感到的"顿一下"。 */
function Page({
  title,
  subtitle,
  children,
  actions
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="anim-fade-quick flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      <div className="shrink-0 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="px-8 py-4">
          <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-3">
            <div className="min-w-0">
              <div className="text-title truncate">{title}</div>
              {subtitle && (
                <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                  {subtitle}
                </div>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
          </div>
        </div>
      </div>
      <div className="stable-gutter flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto w-full max-w-[1120px]">{children}</div>
      </div>
    </div>
  )
}

/** 空状态：图标 + 标题 + 说明 + 可选操作，居中虚线卡片 */
function Empty({
  icon,
  title,
  hint,
  action
}: {
  icon?: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-[var(--r-lg)] border border-dashed px-6 py-10 text-center"
      style={{ borderColor: 'var(--border-strong)', background: 'var(--surface)' }}
    >
      {icon && (
        <span
          className="mb-1 flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: 'var(--surface-sunken)', color: 'var(--text-dim)' }}
        >
          {icon}
        </span>
      )}
      <div className="text-[13px] font-medium">{title}</div>
      {hint && (
        <div className="max-w-[460px] text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
          {hint}
        </div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** 统计块（页面头部概览） */
function Stat({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-[96px] flex-col gap-0.5 rounded-[var(--r-md)] px-3 py-2" style={{ background: 'var(--surface-sunken)' }}>
      <span className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
        {label}
      </span>
      <span className="text-[15px] font-semibold tabular-nums">{value}</span>
    </div>
  )
}

/** 区块标题 */
function SectionTitle({ children, count }: { children: string; count?: number }): React.JSX.Element {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="text-label">{children}</span>
      {typeof count === 'number' && <span className="badge">{count}</span>}
    </div>
  )
}

// ---------------------------------------------------------------- 工作区

export function ProjectsView(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const openProject = useStore((s) => s.openProject)
  const [busyId, setBusyId] = useState('')
  const pick = async (): Promise<void> => {
    const dir = await api.pickDirectory()
    if (!dir) return
    try {
      await openProject(dir)
    } catch (e) {
      useStore.getState().notice(`打开项目失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }
  const removeProject = (p: ProjectInfo): void => {
    if (p.id === activeProjectId) return
    if (!window.confirm(`从列表移除「${p.name}」？只移除列表，不会删除磁盘文件。`)) return
    void api
      .removeProject(p.id)
      .then(async () => {
        const st = await api.getAppState()
        useStore.setState({ projects: st.projects, activeProjectId: st.activeProjectId })
        void useStore.getState().refreshProviders()
        useStore.getState().notice('已从列表移除项目')
      })
      .catch((e) => useStore.getState().notice(`移除失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  return (
    <Page
      title="工作区"
      subtitle={`${projects.length} 个项目 · 切换后会话与工具都按新项目路由`}
      actions={
        <button className="btn btn-primary btn-sm" onClick={() => void pick()}>
          <IconPlus size={12} /> 打开目录
        </button>
      }
    >
      {projects.length === 0 ? (
        <Empty
          icon={<IconFolderOpen size={18} />}
          title="还没有项目"
          hint="选择一个工作目录作为 AI 的操作边界；之后的文件读写、命令执行都限制在这里。"
          action={
            <button className="btn btn-primary btn-sm" onClick={() => void pick()}>
              选择目录
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {projects.map((p) => {
            const active = p.id === activeProjectId
            return (
              <div key={p.id} className="card flex items-center gap-3 px-4 py-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--r-md)]"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  <IconFolderOpen size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                    {active && <span className="badge badge-success">当前项目</span>}
                  </div>
                  <div className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                    {p.root}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button className="btn btn-sm btn-outline" onClick={() => void api.revealPath(p.root)}>
                    打开目录
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={active || busyId === p.id}
                    onClick={() => {
                      if (useStore.getState().streamingText && !window.confirm('当前任务仍在生成，切换项目会中断它。继续？')) return
                      setBusyId(p.id)
                      void openProject(p.root)
                        .catch((e) =>
                          useStore
                            .getState()
                            .notice(`切换项目失败：${e instanceof Error ? e.message : String(e)}`, 'error')
                        )
                        .finally(() => setBusyId(''))
                    }}
                  >
                    {active ? '使用中' : busyId === p.id ? '切换中…' : '切换'}
                  </button>
                  {!active && (
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ color: 'var(--danger)' }}
                      title="只从列表移除，不删除磁盘文件"
                      onClick={() => removeProject(p)}
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 会话

export function SessionsView(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const openSession = useStore((s) => s.openSession)
  const createSession = useStore((s) => s.createSession)
  const providers = useStore((s) => s.providers)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const setView = useStore((s) => s.setView)
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [newProvider, setNewProvider] = useState('')

  useEffect(() => {
    if (!providers.some((p) => p.id === newProvider)) setNewProvider(providers[0]?.id ?? '')
  }, [providers, newProvider])

  const providerName = useMemo(() => new Map(providers.map((p) => [p.id, p.name])), [providers])
  const filtered = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (!providerFilter || s.providerId === providerFilter) &&
          (!query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase()))
      ),
    [sessions, providerFilter, query]
  )
  const compacted = sessions.filter((s) => s.compactedTurns > 0).length
  const platformCount = new Set(sessions.map((s) => s.providerId)).size

  const remove = (id: string, title: string): void => {
    if (!window.confirm(`删除会话「${title}」？该操作不可撤销。`)) return
    void api.deleteSession(id).then(() => {
      // 标签页可能还挂着被删会话：清掉绑定，避免后续发送复用不存在的会话
      useStore.setState((st) => ({
        ...(st.activeSession?.id === id ? { activeSession: null, plan: null } : {}),
        tabs: st.tabs.map((t) => (t.sessionId === id ? { ...t, sessionId: '' } : t))
      }))
      useStore.getState().notice('会话已删除')
      void refreshSessions()
    })
  }
  const exportMd = (id: string): void => {
    void api
      .exportSession(id)
      .then((path) => useStore.getState().notice(`已导出：${path}`))
      .catch((e) => useStore.getState().notice(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  return (
    <Page
      title="会话"
      subtitle="按项目查看历史任务，可打开、导出或删除"
      actions={
        <>
          <select
            className="field h-8 w-[128px] cursor-pointer"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            title="新建会话使用的平台"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary btn-sm"
            disabled={!newProvider}
            onClick={() => void createSession(newProvider)}
          >
            <IconPlus size={12} /> 新建会话
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={() => void refreshSessions()}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Stat label="全部会话" value={sessions.length} />
        <Stat label="使用中的平台" value={platformCount} />
        <Stat label="已压缩" value={compacted} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-[360px]">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={13} />
          </span>
          <input
            className="field h-9 pl-8"
            placeholder="搜索会话标题…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="field h-9 w-[140px] cursor-pointer"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
        >
          <option value="">全部平台</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          {filtered.length} 个结果
        </span>
      </div>

      {sessions.length === 0 ? (
        <Empty
          title="还没有会话"
          hint="到一个 AI 平台开始第一个任务；会话会自动记录在这里，支持导出 Markdown 与回溯上下文。"
          action={
            <button className="btn btn-primary btn-sm" onClick={() => setView('home')}>
              去工作台开始
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <Empty
          title="没有匹配的会话"
          hint="换个关键词，或清除平台筛选。"
          action={
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setQuery('')
                setProviderFilter('')
              }}
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <div
            className="flex items-center gap-3 border-b px-4 py-2 text-[10.5px] uppercase tracking-wide"
            style={{ borderColor: 'var(--border)', color: 'var(--text-hint)' }}
          >
            <span className="w-[96px] shrink-0">平台</span>
            <span className="min-w-0 flex-1">标题</span>
            <span className="w-[150px] shrink-0">更新时间</span>
            <span className="w-[128px] shrink-0 text-right">操作</span>
          </div>
          {filtered.map((s) => (
            <div
              key={s.id}
              className="group flex items-center gap-3 border-b px-4 py-2.5 transition-colors duration-[130ms] last:border-b-0 hover:bg-[var(--bg-hover)]"
              style={{ borderColor: 'var(--border-soft)' }}
            >
              <span className="w-[96px] shrink-0">
                <span className="badge badge-accent">{providerName.get(s.providerId) ?? s.providerId}</span>
              </span>
              <button className="min-w-0 flex-1 text-left" onClick={() => void openSession(s.id)}>
                <div className="truncate text-[12.5px] font-medium">{s.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {s.compactedTurns > 0 && <span className="badge">已压缩 {s.compactedTurns} 轮</span>}
                  {s.parentSessionId && <span className="badge">派生会话</span>}
                  {s.compactedTurns === 0 && !s.parentSessionId && (
                    <span className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                      点击打开
                    </span>
                  )}
                </div>
              </button>
              <span className="w-[150px] shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-hint)' }}>
                {new Date(s.updatedAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
              <div className="flex w-[128px] shrink-0 justify-end gap-1">
                <button className="btn btn-sm btn-ghost" onClick={() => exportMd(s.id)}>
                  导出
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => remove(s.id, s.title)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 文件

function TreeNodes({
  nodes,
  depth,
  onOpen,
  selected
}: {
  nodes: Awaited<ReturnType<typeof api.readFileTree>>
  depth: number
  onOpen: (p: string) => void
  selected?: string
}): React.JSX.Element {
  const sorted = [...nodes].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1
  )
  return (
    <>
      {sorted.map((n) => (
        <div key={n.path}>
          <button
            className="flex w-full items-center gap-1.5 truncate rounded-[var(--r-sm)] py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
            style={{
              paddingLeft: 7 + depth * 14,
              background: selected === n.path ? 'var(--bg-active)' : 'transparent',
              color: n.type === 'dir' ? 'var(--text-body)' : selected === n.path ? 'var(--text)' : 'var(--text-dim)'
            }}
            onClick={() => n.type === 'file' && onOpen(n.path)}
          >
            <span style={{ color: n.type === 'dir' ? 'var(--accent)' : 'var(--text-hint)', opacity: 0.85 }}>
              {n.type === 'dir' ? <IconFolder size={12} /> : <IconFile size={12} />}
            </span>
            <span className="truncate">{n.name}</span>
          </button>
          {n.children && <TreeNodes nodes={n.children} depth={depth + 1} onOpen={onOpen} selected={selected} />}
        </div>
      ))}
    </>
  )
}

export function FilesView(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const fileTree = useStore((s) => s.fileTree)
  const selectedFile = useStore((s) => s.selectedFile)
  const setView = useStore((s) => s.setView)
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null

  const refresh = (): void => {
    if (project) void api.readFileTree(project.id, '', 3).then((tree) => useStore.setState({ fileTree: tree }))
  }
  const prevProjectId = useRef<string | null>(null)
  useEffect(() => {
    if (!project) return
    // 切项目后清掉上一个项目的预览，避免路径/内容对不上
    if (prevProjectId.current !== project.id) {
      prevProjectId.current = project.id
      useStore.setState({ selectedFile: null })
    }
    void api.readFileTree(project.id, '', 3).then((tree) => useStore.setState({ fileTree: tree }))
  }, [project])

  const countFiles = (nodes: typeof fileTree): number =>
    nodes.reduce((n, x) => n + (x.type === 'file' ? 1 : 0) + (x.children ? countFiles(x.children) : 0), 0)

  return (
    <Page
      title="项目文件"
      subtitle={project?.root ?? '未打开项目'}
      actions={
        project ? (
          <>
            <button className="btn btn-outline btn-sm" onClick={() => void api.revealPath(project.root)}>
              <IconFolder size={12} /> 打开目录
            </button>
            <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
              <IconRefresh size={13} />
            </button>
          </>
        ) : undefined
      }
    >
      {!project ? (
        <Empty
          title="未打开项目"
          hint="先在网页里初始化一个工作目录，或到工作台选择一个项目。"
          action={
            <button className="btn btn-primary btn-sm" onClick={() => setView('home')}>
              去工作台
            </button>
          }
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            <span className="badge">前 3 层 {countFiles(fileTree)} 个文件</span>
            <span>显示前 3 层目录，点击文件预览内容</span>
            <span className="ml-auto font-mono">{project.root}</span>
          </div>
          <div className="flex h-[calc(100vh-210px)] min-h-[360px] gap-3">
            <div className="card w-[300px] shrink-0 overflow-y-auto p-1.5">
              {fileTree.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                  目录为空
                  <div className="mt-2">
                    <button className="btn btn-sm btn-outline" onClick={refresh}>
                      刷新
                    </button>
                  </div>
                </div>
              ) : (
                <TreeNodes
                  nodes={fileTree}
                  depth={0}
                  selected={selectedFile?.path}
                  onOpen={(p) =>
                    void api
                      .readFileContent(project.id, p)
                      .then((content) => useStore.setState({ selectedFile: { path: p, content } }))
                  }
                />
              )}
            </div>
            <div className="card min-w-0 flex-1 overflow-auto p-4">
              {selectedFile ? (
                <>
                  <div
                    className="mb-3 flex items-center gap-2 border-b pb-2.5 font-mono text-[11.5px]"
                    style={{ borderColor: 'var(--border-soft)', color: 'var(--text-hint)' }}
                  >
                    <span className="min-w-0 flex-1 truncate">{selectedFile.path}</span>
                    <button
                      className="btn btn-sm btn-ghost shrink-0"
                      onClick={() => void api.revealPath(`${project.root}/${selectedFile.path}`)}
                    >
                      在系统中查看
                    </button>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.65]" style={{ color: 'var(--text-body)' }}>
                    {selectedFile.content}
                  </pre>
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px]" style={{ color: 'var(--text-hint)' }}>
                  <IconFolder size={22} />
                  从左侧选择一个文件预览
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 任务

const TODO_STATUS: { id: TaskItem['status']; label: string; cls: string }[] = [
  { id: 'pending', label: '待办', cls: '' },
  { id: 'running', label: '进行中', cls: 'badge-accent' },
  { id: 'done', label: '完成', cls: 'badge-success' },
  { id: 'failed', label: '失败', cls: 'badge-danger' },
  { id: 'skipped', label: '跳过', cls: '' }
]

/** 人机共用待办看板：AI 经 todoWrite 写入，用户在此查看/勾选 */
export function TasksView(): React.JSX.Element {
  const todos = useStore((s) => s.todos)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const hasProject = Boolean(activeProjectId)
  const refresh = (): void => {
    void api
      .listTodos()
      .then((t) => useStore.setState({ todos: t }))
      .catch(() => undefined)
  }
  useEffect(() => {
    if (hasProject) refresh()
  }, [hasProject, activeProjectId])
  const [newTitle, setNewTitle] = useState('')

  if (!hasProject) return <Page title="任务看板"><Empty title="先打开项目" /></Page>

  const doneCount = todos.filter((t) => t.status === 'done').length

  return (
    <Page
      title="任务看板"
      subtitle={`${doneCount} / ${todos.length} 已完成 · AI 会通过 todoWrite 自动同步`}
      actions={
        <>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              if (window.confirm('清理所有已完成任务？')) void api.clearDoneTodos().then(refresh)
            }}
          >
            清理已完成
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Stat label="待办" value={todos.filter((t) => t.status === 'pending').length} />
        <Stat label="进行中" value={todos.filter((t) => t.status === 'running').length} />
        <Stat label="已完成" value={doneCount} />
        <Stat label="失败" value={todos.filter((t) => t.status === 'failed').length} />
      </div>

      <div className="mb-4 flex gap-2">
        <input
          className="field"
          placeholder="添加待办，回车确认（AI 也会用 todoWrite 同步进度）"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newTitle.trim()) {
              void api.addTodo(newTitle.trim()).then((t) => {
                useStore.setState({ todos: t })
                setNewTitle('')
              })
            }
          }}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!newTitle.trim()}
          onClick={() => {
            if (!newTitle.trim()) return
            void api.addTodo(newTitle.trim()).then((t) => {
              useStore.setState({ todos: t })
              setNewTitle('')
            })
          }}
        >
          <IconPlus size={13} /> 添加
        </button>
      </div>

      {todos.length === 0 ? (
        <Empty title="看板为空" hint="让 AI 执行多步任务时，它会用 todoWrite 把进度同步到这里" />
      ) : (
        <div className="space-y-1.5">
          {todos.map((t) => {
            const st = TODO_STATUS.find((x) => x.id === t.status)
            return (
              <div key={t.id} className="card flex items-center gap-3 px-3.5 py-2.5">
                <span className={`badge ${st?.cls ?? ''}`}>{st?.label ?? t.status}</span>
                <span
                  className={`min-w-0 flex-1 truncate text-[12.5px] ${t.status === 'done' ? 'line-through opacity-50' : ''}`}
                >
                  {t.title}
                </span>
                <select
                  className="cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent text-[11px] outline-none"
                  style={{ color: 'var(--text-dim)' }}
                  value={t.status}
                  onChange={(e) => void api.setTodoStatus(t.id, e.target.value as TaskItem['status']).then(refresh)}
                >
                  {TODO_STATUS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}

/** 服务端权威 token 消耗统计（SSE accumulated_token_usage 差值，按平台累计持久化） */
function TokenStatsRow(): React.JSX.Element {
  const [stats, setStats] = useState<Record<string, number>>({})
  useEffect(() => {
    void api.getTokenStats().then(setStats).catch(() => undefined)
  }, [])
  const total = Object.values(stats).reduce((a, b) => a + b, 0)
  const detail = Object.entries(stats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v.toLocaleString()}`)
    .join(' · ')
  return (
    <div className="mb-3 ml-[44px] text-[12px]" style={{ color: 'var(--text-hint)' }}>
      累计消耗
      <span className="ml-1.5 tabular-nums" style={{ color: 'var(--text-body)' }}>
        {total > 0 ? `≈ ${Math.round(total / 1000)}k tokens` : '—'}
      </span>
      {detail && <span className="ml-2">{detail}</span>}
      <span className="ml-2">（服务端权威值，零 API 费用）</span>
    </div>
  )
}

// ---------------------------------------------------------------- 插件

export function PluginsView(): React.JSX.Element {
  const installedPlugins = useStore((s) => s.installedPlugins)
  const marketResults = useStore((s) => s.marketResults)
  const marketWarning = useStore((s) => s.marketWarning)
  const builtinPlugins = useStore((s) => s.builtinPlugins)
  const [tab, setTab] = useState<'installed' | 'builtin' | 'market'>('installed')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [coverage, setCoverage] = useState<{ total: number; implemented: string[] } | null>(null)
  const refresh = (): void => {
    void api.listInstalledPlugins().then((p) => useStore.setState({ installedPlugins: p }))
    void api.listBuiltinPlugins().then((p) => useStore.setState({ builtinPlugins: p }))
    void api.dshCoverage().then(setCoverage)
  }
  useEffect(refresh, [])

  const search = (): void => {
    if (!query.trim()) return
    setSearching(true)
    void api
      .searchMarket(query)
      .then((r) => useStore.setState({ marketResults: r.items, marketWarning: r.warning ?? '' }))
      .catch((e) => useStore.setState({ marketWarning: `市场搜索失败：${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => setSearching(false))
  }
  const installMarket = (m: MarketPlugin): void => {
    void api
      .installPlugin(`${m.source}:${m.id}`)
      .then(() => {
        useStore.getState().notice('插件已安装并加载生效')
        refresh()
      })
      .catch((e) => useStore.getState().notice(`安装失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }
  const installBuiltin = (id: string): void => {
    void api
      .installPlugin(`builtin:${id}`)
      .then(() => {
        useStore.getState().notice('插件已安装并加载生效')
        refresh()
      })
      .catch((e) => useStore.getState().notice(`安装失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }
  const toggle = (p: InstalledPlugin): void => {
    void api.togglePlugin(p.id, !p.enabled).then(refresh)
  }
  const uninstall = (p: InstalledPlugin): void => {
    if (!window.confirm(`卸载插件「${p.name}」？`)) return
    void api.uninstallPlugin(p.id).then(refresh)
  }
  const tabBtn = (id: typeof tab, label: string, count: number): React.JSX.Element => (
    <button
      key={id}
      className="rounded-[var(--r-sm)] px-3 py-1.5 text-[12px] font-medium transition-colors duration-[110ms]"
      style={{
        background: tab === id ? 'var(--surface)' : 'transparent',
        color: tab === id ? 'var(--text)' : 'var(--text-dim)',
        boxShadow: tab === id ? 'var(--shadow)' : 'none'
      }}
      onClick={() => setTab(id)}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  )

  return (
    <Page
      title="插件与扩展"
      subtitle={coverage ? `DSH 兼容 ${coverage.implemented.length} / ${coverage.total} · 安装后立即加载生效` : '技能、网页脚本与 DSH 服务'}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      <div className="mb-4 flex w-fit items-center gap-1 rounded-[var(--r-md)] p-1" style={{ background: 'var(--surface-sunken)' }}>
        {tabBtn('installed', '已安装', installedPlugins.length)}
        {tabBtn('builtin', '内置精选', builtinPlugins.length)}
        {tabBtn('market', '在线市场', marketResults.length)}
      </div>

      {tab === 'installed' &&
        (installedPlugins.length === 0 ? (
          <Empty
            title="还没有安装插件"
            hint="内置精选提供官方最小可用件，在线市场可以从 GitHub / Gitee 安装社区插件。"
            action={
              <button className="btn btn-primary btn-sm" onClick={() => setTab('builtin')}>
                去看看内置精选
              </button>
            }
          />
        ) : (
          <div className="space-y-2">
            {installedPlugins.map((p) => (
              <div key={p.id} className="card flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                    <span className="badge">v{p.version}</span>
                    <span className={`badge ${p.enabled ? 'badge-success' : ''}`}>{p.enabled ? '已启用' : '已停用'}</span>
                    {p.provides?.length ? <span className="badge">{p.provides.join(' / ')}</span> : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {p.description}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button className="btn btn-sm btn-outline" onClick={() => toggle(p)}>
                    {p.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => uninstall(p)}>
                    卸载
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === 'builtin' &&
        (builtinPlugins.length === 0 ? (
          <Empty title="内置精选均已安装" hint="可以到在线市场继续搜索社区插件。" />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {builtinPlugins.map((m) => (
              <div key={m.id} className="card flex flex-col p-4">
                <div className="mb-1 flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium">{m.name}</span>
                  <span className="badge">v{m.version}</span>
                  <span className="badge badge-accent">官方</span>
                </div>
                <div className="mb-3 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {m.description}
                </div>
                <div className="mt-auto">
                  {m.installed ? (
                    <span className="badge badge-success">已安装</span>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => installBuiltin(m.id)}>
                      一键安装
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === 'market' && (
        <>
          <div className="mb-4 flex gap-2">
            <div className="relative flex-1 md:max-w-[420px]">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
                <IconSearch size={13} />
              </span>
              <input
                className="field h-9 pl-8"
                placeholder="搜索市场（GitHub / Gitee），回车搜索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
            </div>
            <button className="btn btn-primary shrink-0" disabled={!query.trim() || searching} onClick={search}>
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          {marketWarning && (
            <div
              className="mb-4 rounded-[var(--r-lg)] px-3.5 py-2.5 text-[12px] leading-relaxed"
              style={{
                background: 'var(--danger-soft)',
                color: 'var(--danger)',
                border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)'
              }}
            >
              {marketWarning}
            </div>
          )}
          {marketResults.length === 0 ? (
            <Empty
              title={searching ? '搜索中…' : '搜索在线插件市场'}
              hint="输入关键词后回车，从 GitHub 与 Gitee 检索（走系统代理）。"
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {marketResults.map((m) => (
                <div key={m.repoUrl} className="card flex flex-col p-4">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-medium">{m.name}</span>
                    <span className="badge">
                      {m.source} · ★{m.stars ?? 0}
                    </span>
                  </div>
                  <div className="mb-3 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {m.description}
                  </div>
                  <div className="mt-auto">
                    {m.installed ? (
                      <span className="badge badge-success">已安装</span>
                    ) : (
                      <button className="btn btn-sm btn-primary" onClick={() => installMarket(m)}>
                        安装
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  )
}


// ---------------------------------------------------------------- 记忆

export function MemoryView(): React.JSX.Element {
  const memoryList = useStore((s) => s.memoryList)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [query, setQuery] = useState('')
  const refresh = (): void => void api.listMemory().then((m) => useStore.setState({ memoryList: m }))
  const add = (): void => {
    if (!title || !content) return
    void api.addMemory(title, content, []).then(() => {
      setTitle('')
      setContent('')
      refresh()
    })
  }
  const filtered = memoryList.filter(
    (m) => !query.trim() || `${m.title} ${m.content}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const sourceLabel: Record<string, string> = { ai: 'AI 保存', manual: '手动', marker: '正文标记' }

  return (
    <Page
      title="用户记忆"
      subtitle={`${memoryList.length} 条 · 跨会话生效，AI 通过 remember 工具写入`}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      <div className="card mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-semibold">新增记忆</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            标题用于检索；内容会注入系统提示词，建议写清偏好与约定
          </span>
        </div>
        <div className="flex flex-col gap-2 md:flex-row">
          <input
            className="field md:w-56"
            placeholder="标题（如：提交信息用中文）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="field"
            placeholder="内容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn btn-primary shrink-0" disabled={!title || !content} onClick={add}>
            <IconPlus size={13} /> 新增
          </button>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative max-w-[360px] flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={13} />
          </span>
          <input
            className="field h-9 pl-8"
            placeholder="搜索记忆…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          {filtered.length} 条
        </span>
      </div>

      {filtered.length === 0 ? (
        <Empty
          title={memoryList.length === 0 ? '还没有记忆' : '没有匹配的记忆'}
          hint={
            memoryList.length === 0
              ? '在对话里让 AI「记住」关键结论，或用上方表单手动添加；后续会话会自动参考。'
              : '换个关键词试试。'
          }
        />
      ) : (
        <div className="space-y-1.5">
          {filtered.map((m) => (
            <div key={m.id} className="card group flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] font-medium">{m.title}</span>
                  {m.tags.map((t) => (
                    <span key={t} className="badge">
                      {t}
                    </span>
                  ))}
                  <span className="badge">{sourceLabel[m.source] ?? m.source}</span>
                </div>
                <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {m.content}
                </div>
                <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                  {new Date(m.updatedAt).toLocaleString('zh-CN')}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm shrink-0"
                title="删除"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  if (!window.confirm(`删除记忆「${m.title}」？`)) return
                  void api.deleteMemory(m.id).then(refresh)
                }}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 知识库

export function KnowledgeView(): React.JSX.Element {
  const kbs = useStore((s) => s.kbs)
  const [query, setQuery] = useState('')
  const [kbId, setKbId] = useState('')
  const [hits, setHits] = useState<{ path: string; score: number; snippet: string }[]>([])
  const refresh = (): void => void api.listKnowledgeBases().then((k) => useStore.setState({ kbs: k }))
  useEffect(refresh, [])

  const search = (): void => {
    if (kbId) void api.searchKnowledge(kbId, query).then(setHits)
  }
  const removeKb = (id: string, name: string): void => {
    if (!window.confirm(`移除知识库「${name}」？不会删除磁盘上的文件。`)) return
    void api.removeKnowledgeBase(id).then(() => {
      if (kbId === id) {
        setKbId('')
        setHits([])
      }
      refresh()
    })
  }

  return (
    <Page
      title="本地知识库"
      subtitle={`${kbs.length} 个库 · 挂载目录后 AI 可用 kbSearch 工具检索`}
      actions={
        <>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              void api.pickDirectory().then((dir) => {
                if (!dir) return
                const name = dir.split(/[\\/]/).pop() ?? '知识库'
                void api.addKnowledgeBase(name, dir).then(refresh)
              })
            }}
          >
            <IconPlus size={12} /> 挂载目录
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      <SectionTitle count={kbs.length}>已挂载</SectionTitle>
      {kbs.length === 0 ? (
        <Empty
          title="还没有挂载知识库"
          hint="挂载一个本地文档目录（md / txt / json / html 等），AI 就能按关键词检索其中的内容。"
          action={
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                void api.pickDirectory().then((dir) => {
                  if (!dir) return
                  const name = dir.split(/[\\/]/).pop() ?? '知识库'
                  void api.addKnowledgeBase(name, dir).then(refresh)
                })
              }}
            >
              <IconPlus size={12} /> 挂载目录
            </button>
          }
        />
      ) : (
        <div className="mb-6 space-y-1.5">
          {kbs.map((k) => (
            <div key={k.id} className="card group flex items-center gap-3 px-4 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-sm)]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <IconFolder size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium">{k.name}</span>
                  <span className="badge">{k.fileCount} 文档</span>
                </div>
                <div className="truncate text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                  {k.root}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm shrink-0"
                title="移除知识库"
                style={{ color: 'var(--danger)' }}
                onClick={() => removeKb(k.id, k.name)}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {kbs.length > 0 && (
        <>
          <SectionTitle>检索</SectionTitle>
          <div className="card mb-4 p-4">
            <div className="flex flex-col gap-2 md:flex-row">
              <select
                className="field md:w-56 cursor-pointer"
                value={kbId}
                onChange={(e) => {
                  setKbId(e.target.value)
                  setHits([])
                }}
              >
                <option value="">选择知识库…</option>
                {kbs.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}（{k.fileCount} 文档）
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="查询内容，回车检索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
              <button className="btn btn-primary shrink-0" disabled={!kbId || !query.trim()} onClick={search}>
                搜索
              </button>
            </div>
          </div>

          {hits.length === 0 ? (
            <Empty title="输入查询内容开始检索" hint="检索结果会附带文件路径与相关度，方便定位原文。" />
          ) : (
            <div className="space-y-1.5">
              {hits.map((h) => (
                <div key={h.path} className="card px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-hint)' }}>
                      {h.path}
                    </span>
                    <span className="badge badge-accent ml-auto shrink-0">相关度 {h.score}</span>
                  </div>
                  <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-body)' }}>
                    {h.snippet}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 审计

export function AuditView(): React.JSX.Element {
  const audits = useStore((s) => s.audits)
  const [kind, setKind] = useState('all')
  const refresh = (): void => void api.listAudit(undefined, 200).then((a) => useStore.setState({ audits: a }))
  useEffect(refresh, [])
  const KIND_LABELS: Record<string, string> = {
    'file-write': '文件写入',
    'file-delete': '删除',
    command: '命令',
    tool: '工具'
  }
  const filtered = kind === 'all' ? audits : audits.filter((a) => a.kind === kind)

  return (
    <Page
      title="执行审计"
      subtitle={`${audits.length} 条记录 · 文件改动可单步回滚`}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {['all', 'file-write', 'file-delete', 'command', 'tool'].map((k) => (
          <button
            key={k}
            className="rounded-[var(--r-sm)] px-2.5 py-1 text-[11.5px] transition-colors duration-[110ms]"
            style={{
              background: kind === k ? 'var(--accent-soft)' : 'var(--surface-sunken)',
              color: kind === k ? 'var(--accent)' : 'var(--text-dim)'
            }}
            onClick={() => setKind(k)}
          >
            {k === 'all' ? '全部' : KIND_LABELS[k] ?? k}
          </button>
        ))}
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          {filtered.length} 条
        </span>
      </div>

      {filtered.length === 0 ? (
        <Empty
          title={audits.length === 0 ? '暂无审计记录' : '该类型暂无记录'}
          hint="AI 执行文件写入、删除和命令后会在这里留痕，带备份的文件操作可以回滚。"
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-[var(--r-md)] px-3 py-2 transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
            >
              <span className="badge shrink-0">{KIND_LABELS[a.kind] ?? a.kind}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.summary}</span>
              <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-hint)' }}>
                {new Date(a.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
              {a.reverted ? (
                <span className="badge shrink-0" style={{ color: 'var(--warning)' }}>
                  已回滚
                </span>
              ) : a.backupPath ? (
                <button
                  className="btn btn-sm btn-outline shrink-0"
                  onClick={() => {
                    if (window.confirm('用备份覆盖当前文件？当前未保存的改动会丢失。')) void api.revertAudit(a.id).then(refresh)
                  }}
                >
                  回滚
                </button>
              ) : (
                <span className="w-[46px] shrink-0" />
              )}
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 技能 / 子代理 / MCP / 快捷指令

export function SkillsView(): React.JSX.Element {
  const project = useStore((s) => useProject(s))
  const projectId = project?.id
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const refresh = (): void => void api.listSkills().then(setSkills)
  useEffect(() => {
    void api.listSkills().then(setSkills)
  }, [projectId])
  const dir = project ? `${project.root}/.lidow/skills` : ''

  return (
    <Page
      title="技能"
      subtitle={`${skills.length} 个 · 放在项目 .lidow/skills 或用户 ~/.lidow/skills`}
      actions={
        <>
          {dir && (
            <button className="btn btn-outline btn-sm" onClick={() => void api.revealPath(dir)}>
              <IconFolder size={12} /> 打开目录
            </button>
          )}
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      {skills.length === 0 ? (
        <Empty
          icon={<IconBulb size={18} />}
          title="还没有技能"
          hint="在项目的 .lidow/skills 或用户目录的 ~/.lidow/skills 放一个 SKILL.md（name + description + 正文），AI 会在需要时用 readSkill 读取。"
          action={
            dir ? (
              <button className="btn btn-primary btn-sm" onClick={() => void api.revealPath(dir)}>
                打开技能目录
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-1.5">
          {skills.map((s) => (
            <div key={s.path} className="card flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <IconBulb size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] font-medium">{s.name}</span>
                  <span className="badge">{s.scope === 'project' ? '项目' : '用户'}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {s.description || '（无描述）'}
                </div>
                <div className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                  {s.path}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

export function AgentsView(): React.JSX.Element {
  const project = useStore((s) => useProject(s))
  const projectId = project?.id
  const [agents, setAgents] = useState<AgentMeta[]>([])
  const refresh = (): void => void api.listAgents().then(setAgents)
  useEffect(() => {
    void api.listAgents().then(setAgents)
  }, [projectId])
  const dir = project ? `${project.root}/.lidow/agents` : ''

  return (
    <Page
      title="子代理"
      subtitle={`${agents.length} 个 · 放在项目 .lidow/agents 或用户 ~/.lidow/agents`}
      actions={
        <>
          {dir && (
            <button className="btn btn-outline btn-sm" onClick={() => void api.revealPath(dir)}>
              <IconFolder size={12} /> 打开目录
            </button>
          )}
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      {agents.length === 0 ? (
        <Empty
          icon={<IconHand size={18} />}
          title="还没有子代理"
          hint="在 .lidow/agents 或 ~/.lidow/agents 放一个 Markdown（name + description + 人设正文），AI 就能用 runAgent 派它独立完成子任务。"
          action={
            dir ? (
              <button className="btn btn-primary btn-sm" onClick={() => void api.revealPath(dir)}>
                打开代理目录
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-1.5">
          {agents.map((a) => (
            <div key={a.path} className="card flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <IconHand size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] font-medium">{a.name}</span>
                  <span className="badge">{a.scope === 'project' ? '项目' : '用户'}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {a.description || '（无描述）'}
                </div>
                <div className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                  {a.path}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

export function McpView(): React.JSX.Element {
  const servers = useStore((s) => s.mcpServers)
  const tools = useStore((s) => s.mcpTools)
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    void api.listMcpServers().then((s) => useStore.setState({ mcpServers: s }))
    void api.listMcpTools().then((t) => useStore.setState({ mcpTools: t }))
  }
  useEffect(refresh, [])

  const valid = Boolean(name.trim()) && (transport === 'stdio' ? Boolean(command.trim()) : Boolean(url.trim()))
  const add = (): void => {
    if (!valid || busy) return
    const cfg = {
      name: name.trim(),
      command: transport === 'stdio' ? command.trim() : '',
      args:
        transport === 'stdio'
          ? args
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
          : [],
      url: transport === 'http' ? url.trim() : undefined,
      enabled: true
    }
    setBusy(true)
    void api
      .addMcpServer(cfg)
      .then(async () => {
        const list = await api.listMcpTools()
        useStore.setState({ mcpTools: list })
        const count = list.filter((t) => t.server === cfg.name).length
        useStore
          .getState()
          .notice(
            count > 0 ? `MCP 服务 ${cfg.name} 已连接（${count} 个工具）` : `MCP 服务 ${cfg.name} 已保存，但未获取到工具（请检查命令或 URL）`,
            count > 0 ? 'info' : 'warn'
          )
        setName('')
        setCommand('')
        setArgs('')
        setUrl('')
        refresh()
      })
      .catch((e) => useStore.getState().notice(`MCP 添加失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
      .finally(() => setBusy(false))
  }
  const remove = (n: string): void => {
    if (!window.confirm(`移除 MCP 服务「${n}」？`)) return
    void api.removeMcpServer(n).then(refresh)
  }

  return (
    <Page
      title="MCP 连接器"
      subtitle={`${servers.length} 个服务 · ${tools.length} 个可用工具`}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      <div className="card mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-semibold">添加 MCP 服务器</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            支持 stdio（command + args）与 HTTP（Streamable HTTP URL）
          </span>
        </div>
        <div className="flex flex-col gap-2 md:flex-row">
          <select
            className="field md:w-28 cursor-pointer"
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
          >
            <option value="stdio">stdio</option>
            <option value="http">HTTP</option>
          </select>
          <input className="field md:w-40" placeholder="名称（如 filesystem）" value={name} onChange={(e) => setName(e.target.value)} />
          {transport === 'stdio' ? (
            <>
              <input className="field" placeholder="command（如 npx）" value={command} onChange={(e) => setCommand(e.target.value)} />
              <input className="field md:w-56" placeholder="args，逗号分隔" value={args} onChange={(e) => setArgs(e.target.value)} />
            </>
          ) : (
            <input
              className="field flex-1"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
          <button className="btn btn-primary shrink-0" disabled={!valid || busy} onClick={add}>
            {busy ? '连接中…' : '添加并连接'}
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <Empty
          icon={<IconGlobe size={18} />}
          title="还没有 MCP 服务器"
          hint="MCP 能把外部工具（文件系统、数据库、浏览器等）接入 AI。添加后这里会显示连接状态与可用工具。"
        />
      ) : (
        <div className="space-y-2">
          {servers.map((s) => {
            const count = tools.filter((t) => t.server === s.name).length
            return (
              <div key={s.name} className="card flex items-center gap-3 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-sm)]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <IconGlobe size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12.5px] font-medium">{s.name}</span>
                    <span className={`badge ${s.enabled ? 'badge-success' : ''}`}>{s.enabled ? '已启用' : '已停用'}</span>
                    <span className="badge">{count} 个工具</span>
                  </div>
                  <div className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                    {s.url ? s.url : `${s.command} ${s.args?.join(' ') ?? ''}`}
                  </div>
                </div>
                <button className="btn btn-sm btn-danger shrink-0" onClick={() => remove(s.name)}>
                  移除
                </button>
              </div>
            )
          })}
        </div>
      )}

      {tools.length > 0 && (
        <div className="mt-5">
          <SectionTitle count={tools.length}>可用工具</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <span key={`${t.server}/${t.name}`} className="badge" title={t.description}>
                {t.server}/{t.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </Page>
  )
}

export function QuickCommandsView(): React.JSX.Element {
  const quickCmds = useStore((s) => s.quickCmds)
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('')
  const [template, setTemplate] = useState('')
  const refresh = (): void => void api.listQuickCommands().then((c) => useStore.setState({ quickCmds: c }))
  useEffect(refresh, [])
  const reset = (): void => {
    setEditingId('')
    setName('')
    setTrigger('')
    setTemplate('')
  }
  const startEdit = (q: QuickCommand): void => {
    setEditingId(q.id)
    setName(q.name)
    setTrigger(q.trigger)
    setTemplate(q.template)
    document.getElementById('quick-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const save = (): void => {
    const t = trigger.trim().replace(/^\//, '').replace(/\s+/g, '-')
    if (!name.trim() || !t || !template.trim()) return
    void api
      .saveQuickCommand({
        id: editingId,
        name: name.trim(),
        trigger: t,
        template,
        enabled: true
      })
      .then((list) => {
        useStore.setState({ quickCmds: list })
        reset()
        useStore.getState().notice(editingId ? '快捷指令已更新' : '快捷指令已保存')
      })
  }
  const remove = (id: string, n: string): void => {
    if (!window.confirm(`删除快捷指令「${n}」？`)) return
    void api.deleteQuickCommand(id).then((list) => {
      useStore.setState({ quickCmds: list })
      if (editingId === id) reset()
    })
  }

  return (
    <Page
      title="快捷指令"
      subtitle={`${quickCmds.length} 条 · 在对话框输入 /触发词 使用`}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      <div id="quick-form" className="card mb-5 scroll-mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-semibold">{editingId ? '编辑指令' : '新增指令'}</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            模板可用 {'{{input}}'} 作为占位，发送前替换成具体内容
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <input className="field" placeholder="名称（如：写单元测试）" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="field"
            placeholder="触发词（不含 /，如 test）"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
          <textarea
            className="field min-h-[76px] md:col-span-2"
            placeholder="提示词模板"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </div>
        <div className="mt-2 flex justify-end gap-2">
          {editingId && (
            <button className="btn btn-outline" onClick={reset}>
              取消编辑
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={!name.trim() || !trigger.trim() || !template.trim()}
            onClick={save}
          >
            <IconPlus size={13} /> {editingId ? '保存修改' : '保存指令'}
          </button>
        </div>
      </div>

      {quickCmds.length === 0 ? (
        <Empty
          icon={<IconSpark size={18} />}
          title="还没有快捷指令"
          hint="把常用提示词存成指令：输入 /触发词 就能快速填入输入框，适合重复性的任务模板。"
        />
      ) : (
        <div className="space-y-1.5">
          {quickCmds.map((q) => (
            <div key={q.id} className="card flex items-start gap-3 px-4 py-3">
              <span className="badge badge-accent shrink-0 font-mono">/{q.trigger}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">{q.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {q.template}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button className="btn btn-sm btn-ghost" onClick={() => startEdit(q)}>
                  编辑
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title="删除"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => remove(q.id, q.name)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 设置

/** 设置分组卡片 */
function SettingGroup({
  id,
  title,
  desc,
  children
}: {
  id?: string
  title: string
  desc?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div id={id} className="card scroll-mt-4 p-4">
      <div className="mb-0.5 text-[13px] font-semibold">{title}</div>
      {desc && (
        <div className="mb-3.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
          {desc}
        </div>
      )}
      <div className={desc ? '' : 'mt-3'}>{children}</div>
    </div>
  )
}

/** 开关行 */
function ToggleRow({
  label,
  desc,
  checked,
  onChange
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="relative mt-[1px] h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-[150ms]"
        style={{ background: checked ? 'var(--accent)' : 'var(--border-strong)' }}
        onClick={() => onChange(!checked)}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform duration-[150ms]"
          style={{ left: 2, transform: checked ? 'translateX(14px)' : 'none', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[12.5px]">{label}</span>
        {desc && (
          <span className="mt-0.5 block text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
            {desc}
          </span>
        )}
      </span>
    </label>
  )
}

const THEMES: { id: AppSettings['theme']; label: string; bg: string; panel: string; accent: string }[] = [
  { id: 'graphite', label: '石墨', bg: '#eceef2', panel: '#ffffff', accent: '#4f6bed' },
  { id: 'light', label: '浅色', bg: '#f7f8fa', panel: '#ffffff', accent: '#4f6bed' },
  { id: 'dark', label: '深色', bg: '#0f1115', panel: '#16191f', accent: '#4f6bed' },
  { id: 'midnight', label: '深空', bg: '#0b0f1a', panel: '#121828', accent: '#5b9cf8' }
]

const SETTINGS_SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'security', label: '安全' },
  { id: 'resilience', label: '对话韧性' },
  { id: 'platforms', label: '平台与账号' },
  { id: 'mcp', label: 'MCP 服务器' },
  { id: 'sync', label: '多端同步' },
  { id: 'about', label: '关于与更新' }
]

const SYNC_CHANNELS = [
  { id: 'feishu', label: '飞书', placeholder: '飞书群机器人 webhook URL' },
  { id: 'wecom', label: '企业微信', placeholder: '企业微信群机器人 webhook URL' },
  { id: 'dingtalk', label: '钉钉', placeholder: '钉钉群机器人 webhook URL' }
] as const

export function SettingsView(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const mcpServers = useStore((s) => s.mcpServers)
  const mcpTools = useStore((s) => s.mcpTools)
  const s = settings
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')

  const patch = (p: Parameters<typeof api.updateSettings>[0]): void => {
    void api.updateSettings(p).then((next) => {
      useStore.setState({ settings: next })
      useStore.getState().applyTheme(next)
    })
  }
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null
  const refreshProviders = (): void => {
    if (project) void api.listProviders(project.id).then((p) => useStore.setState({ providers: p }))
  }
  const [activeSection, setActiveSection] = useState('appearance')
  const jump = (id: string): void => {
    setActiveSection(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // 滚动时同步左侧导航高亮：滚到哪个分组就点亮哪个
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActiveSection(visible.target.id.replace('settings-', ''))
      },
      { rootMargin: '-12% 0px -70% 0px', threshold: 0 }
    )
    for (const sec of SETTINGS_SECTIONS) {
      const el = document.getElementById(`settings-${sec.id}`)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])
  const version = useStore.getState().version || '0.3.0'

  return (
    <Page title="设置" subtitle={`Lidow v${version} · 所有设置保存在本机`}>
      <div className="mx-auto flex w-full max-w-[980px] items-start gap-6">
        <nav
          className="sticky top-0 w-[150px] shrink-0 rounded-[var(--r-lg)] p-1.5"
          style={{ background: 'var(--surface-sunken)' }}
        >
          {SETTINGS_SECTIONS.map((sec) => {
            const active = activeSection === sec.id
            return (
              <button
                key={sec.id}
                className="flex w-full items-center rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[12px] transition-colors duration-[110ms] hover:bg-[var(--surface)]"
                style={{
                  background: active ? 'var(--surface)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                  fontWeight: active ? 500 : 400
                }}
                onClick={() => jump(sec.id)}
              >
                {sec.label}
              </button>
            )
          })}
          <div
            className="mt-2 border-t px-2 py-2 text-[10.5px]"
            style={{ borderColor: 'var(--border-soft)', color: 'var(--text-hint)' }}
          >
            零 Token 成本 · GPL-3.0
          </div>
        </nav>
        <div className="flex min-w-0 max-w-[780px] flex-1 flex-col gap-3.5">
        {/* 外观 */}
        <SettingGroup id="settings-appearance" title="外观" desc="主题与主色。切换立即生效。">
          <div className="mb-4 flex flex-wrap gap-2.5">
            {THEMES.map((t) => {
              const active = s.theme === t.id
              return (
                <button
                  key={t.id}
                  className="group overflow-hidden rounded-[var(--r-lg)] p-1.5 text-left transition-all duration-[130ms]"
                  style={{
                    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: 'var(--surface)'
                  }}
                  onClick={() => patch({ theme: t.id })}
                >
                  <div className="flex h-11 w-[74px] flex-col gap-[3px] rounded-[var(--r-sm)] p-1.5" style={{ background: t.bg }}>
                    <div className="h-[3px] w-6 rounded-full" style={{ background: t.accent }} />
                    <div className="flex flex-1 gap-[3px]">
                      <div className="w-[14px] rounded-[2px]" style={{ background: t.panel, opacity: 0.9 }} />
                      <div className="flex-1 rounded-[2px]" style={{ background: t.panel, opacity: 0.55 }} />
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1 px-0.5">
                    <span className="text-[11px]" style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {t.label}
                    </span>
                    {active && (
                      <span style={{ color: 'var(--accent)' }}>
                        <IconCheck size={11} />
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            <button
              className="flex flex-col items-center justify-center gap-1 rounded-[var(--r-lg)] px-3 text-[11px] transition-colors duration-[130ms]"
              style={{
                border: `1.5px solid ${s.theme === 'system' ? 'var(--accent)' : 'var(--border)'}`,
                color: s.theme === 'system' ? 'var(--accent)' : 'var(--text-dim)'
              }}
              onClick={() => patch({ theme: 'system' })}
            >
              跟随系统
            </button>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[12.5px]">主色</span>
            <input
              type="color"
              value={s.accent}
              onChange={(e) => patch({ accent: e.target.value })}
              className="h-7 w-11 cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent p-0"
            />
            <span className="font-mono text-[11px]" style={{ color: 'var(--text-hint)' }}>
              {s.accent}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => patch({ accent: '#4f6bed' })}>
              恢复默认
            </button>
          </div>
        </SettingGroup>

        {/* 安全 */}
        <SettingGroup id="settings-security" title="安全" desc="危险操作拦截、网络防护与提示注入防御。">
          <ToggleRow label="危险命令需确认" desc="删除文件、强推分支等操作执行前弹窗确认" checked={s.dangerConfirm} onChange={(v) => patch({ dangerConfirm: v })} />
          <ToggleRow label="SSRF 防护" desc="阻止工具访问内网地址与云元数据端点" checked={s.ssrfProtection} onChange={(v) => patch({ ssrfProtection: v })} />
          <ToggleRow label="安全 MOD" desc="识别并改写 AI 的拒绝回复" checked={s.securityMod.enabled} onChange={(v) => patch({ securityMod: { ...s.securityMod, enabled: v } })} />
          <ToggleRow label="CTF / 安全研究模式" desc="在系统提示词中附加授权测试上下文" checked={s.securityMod.ctfInject} onChange={(v) => patch({ securityMod: { ...s.securityMod, ctfInject: v } })} />

          <div className="mt-3">
            <div className="mb-1.5 text-[12.5px]">AI 回复拦截</div>
            <div className="mb-2 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
              每行一条正则，命中即阻止工具执行
            </div>
            <textarea
              className="field min-h-[72px] font-mono text-[11.5px]"
              placeholder={'例如：\n请提供.*支付凭证'}
              defaultValue={(s.securityMod.customPatterns ?? []).join('\n')}
              onBlur={(e) =>
                patch({
                  securityMod: {
                    ...s.securityMod,
                    customPatterns: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
                  }
                })
              }
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2.5">
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12.5px]">
              命令超时
              <input
                className="field w-16 text-center tabular-nums"
                type="number"
                value={s.commandTimeoutMs / 1000}
                onChange={(e) => patch({ commandTimeoutMs: Number(e.target.value) * 1000 })}
              />
              <span style={{ color: 'var(--text-hint)' }}>秒</span>
            </label>
          </div>
        </SettingGroup>

        {/* 对话韧性：看门狗 / 自动重试 / 上下文压缩 / 自动继续 */}
        <SettingGroup
          id="settings-resilience"
          title="对话韧性"
          desc="AI 卡住或出错时自动恢复：催继续、重试、压缩上下文、跨会话续接。"
        >
          <ToggleRow
            label="看门狗（自动催继续）"
            desc="SSE 流长时间无数据说明 AI 卡住，自动发提示词让它接着写"
            checked={s.watchdog.enabled}
            onChange={(v) => patch({ watchdog: { ...s.watchdog, enabled: v } })}
          />
          {s.watchdog.enabled && (
            <div className="mb-3 ml-[44px] flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
              <label className="flex items-center gap-1.5">
                静默超过
                <input
                  className="field w-16 text-center tabular-nums"
                  type="number"
                  value={Math.round(s.watchdog.idleMs / 1000)}
                  onChange={(e) => patch({ watchdog: { ...s.watchdog, idleMs: Number(e.target.value) * 1000 } })}
                />
                秒
              </label>
              <label className="flex items-center gap-1.5">
                最多催
                <input
                  className="field w-14 text-center tabular-nums"
                  type="number"
                  value={s.watchdog.maxRetries}
                  onChange={(e) => patch({ watchdog: { ...s.watchdog, maxRetries: Number(e.target.value) } })}
                />
                次
              </label>
              <label className="flex flex-1 items-center gap-1.5">
                提示词
                <input
                  className="field flex-1"
                  value={s.watchdog.prompt}
                  onChange={(e) => patch({ watchdog: { ...s.watchdog, prompt: e.target.value } })}
                />
              </label>
            </div>
          )}

          <ToggleRow
            label="失败自动重试"
            desc="回复中断或平台限流时按退避策略自动重发；429 用更长的等待"
            checked={s.retry.enabled}
            onChange={(v) => patch({ retry: { ...s.retry, enabled: v } })}
          />
          {s.retry.enabled && (
            <div className="mb-3 ml-[44px] flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
              <label className="flex items-center gap-1.5">
                首次延迟
                <input
                  className="field w-16 text-center tabular-nums"
                  type="number"
                  value={Math.round(s.retry.delayMinMs / 1000)}
                  onChange={(e) => patch({ retry: { ...s.retry, delayMinMs: Number(e.target.value) * 1000 } })}
                />
                秒
              </label>
              <label className="flex items-center gap-1.5">
                最多重试
                <input
                  className="field w-14 text-center tabular-nums"
                  type="number"
                  value={s.retry.maxRetries}
                  onChange={(e) => patch({ retry: { ...s.retry, maxRetries: Number(e.target.value) } })}
                />
                次
              </label>
              <label className="flex items-center gap-1.5">
                429 等待
                <input
                  className="field w-16 text-center tabular-nums"
                  type="number"
                  value={Math.round(s.retry.delay429Ms / 1000)}
                  onChange={(e) => patch({ retry: { ...s.retry, delay429Ms: Number(e.target.value) * 1000 } })}
                />
                秒
              </label>
            </div>
          )}

          <ToggleRow
            label="自动压缩上下文"
            desc="会话变长时让 AI 生成可交接的摘要，替换掉早期原文"
            checked={s.autoCompact}
            onChange={(v) => patch({ autoCompact: v })}
          />

          <TokenStatsRow />
          {s.autoCompact && (
            <div className="mb-3 ml-[44px] flex items-center gap-1.5 text-[12px]">
              <label className="flex items-center gap-1.5">
                触发阈值
                <input
                  className="field w-20 text-center tabular-nums"
                  type="number"
                  value={s.compactThreshold}
                  onChange={(e) => patch({ compactThreshold: Number(e.target.value) })}
                />
                字符
              </label>
            </div>
          )}

          <ToggleRow
            label="上下文耗尽自动继续"
            desc="平台提示上下文用完时，压缩当前会话并自动开新会话携带摘要继续"
            checked={s.autoContinue.enabled}
            onChange={(v) => patch({ autoContinue: { ...s.autoContinue, enabled: v } })}
          />
        </SettingGroup>

        {/* 平台与账号 */}
        <SettingGroup id="settings-platforms" title="平台与账号" desc="多账号切换；每个账号使用独立分区，登录态互不干扰。">
          {project ? (
            <div className="space-y-2">
              {providers.map((p) => (
                <div key={p.id} className="rounded-[var(--r-md)] p-3" style={{ background: 'var(--surface-sunken)' }}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[12.5px] font-medium">{p.name}</span>
                    <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                      {p.home}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.accounts.map((a) => {
                      const active = p.activeAccountId === a.id
                      return (
                        <button
                          key={a.id}
                          className="rounded-[var(--r-sm)] px-2 py-1 text-[11.5px] transition-colors duration-[130ms]"
                          style={{
                            background: active ? 'var(--accent)' : 'var(--surface)',
                            color: active ? 'var(--on-accent)' : 'var(--text-body)',
                            border: `1px solid ${active ? 'transparent' : 'var(--border)'}`
                          }}
                          onClick={() => void api.switchAccount(project.id, p.id, a.id).then(refreshProviders)}
                        >
                          {a.label || '默认账号'}
                        </button>
                      )
                    })}
                    <button
                      className="rounded-[var(--r-sm)] px-2 py-1 text-[11.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
                      style={{ border: '1px dashed var(--border-strong)', color: 'var(--text-dim)' }}
                      onClick={() => void api.addAccount(project.id, p.id, '').then(refreshProviders)}
                    >
                      <IconPlus size={11} className="inline" /> 添加账号
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--text-hint)' }}>
              先打开项目
            </div>
          )}
        </SettingGroup>

        {/* MCP：完整管理在独立页面，设置里只做概览入口 */}
        <SettingGroup
          id="settings-mcp"
          title="MCP 服务器"
          desc="把外部工具（文件系统、数据库、浏览器等）接入 AI。"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              已配置 <span className="font-medium">{mcpServers.length}</span> 个服务，
              <span className="font-medium"> {mcpTools.length} </span>个可用工具
            </div>
            <button
              className="btn btn-sm btn-outline ml-auto"
              onClick={() => useStore.getState().setView('mcp')}
            >
              打开 MCP 管理页
            </button>
          </div>
        </SettingGroup>

        {/* 同步 */}
        <SettingGroup id="settings-sync" title="多端同步" desc="把任务事件推送到群机器人；每个渠道独立开关。">
          {SYNC_CHANNELS.map((ch) => {
            const cfg = s.sync[ch.id]
            const enabled = Boolean(cfg?.enabled)
            return (
              <div key={ch.id} className="mb-2 rounded-[var(--r-md)] p-3" style={{ background: 'var(--surface-sunken)' }}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[12.5px] font-medium">{ch.label}</span>
                  <span className={`badge ${enabled ? 'badge-success' : ''}`}>{enabled ? '已启用' : '未启用'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    className="relative ml-auto h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-[150ms]"
                    style={{ background: enabled ? 'var(--accent)' : 'var(--border-strong)' }}
                    onClick={() =>
                      patch({
                        sync: {
                          ...s.sync,
                          [ch.id]: { webhookUrl: cfg?.webhookUrl ?? '', enabled: !enabled }
                        }
                      })
                    }
                  >
                    <span
                      className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform duration-[150ms]"
                      style={{ left: 2, transform: enabled ? 'translateX(14px)' : 'none', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }}
                    />
                  </button>
                </div>
                <input
                  className="field"
                  placeholder={ch.placeholder}
                  defaultValue={cfg?.webhookUrl ?? ''}
                  onBlur={(e) =>
                    patch({
                      sync: {
                        ...s.sync,
                        [ch.id]: { webhookUrl: e.target.value, enabled: cfg?.enabled ?? false }
                      }
                    })
                  }
                />
              </div>
            )
          })}
          <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
            入站方向（手机端回消息/中止任务）需要企业自建应用，当前仅提供出站推送。
          </div>
        </SettingGroup>

        {/* 更新 */}
        <SettingGroup id="settings-about" title="关于与更新">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <button
                className="btn btn-outline"
                disabled={updateBusy}
                onClick={() => {
                  setUpdateBusy(true)
                  setUpdateMsg('')
                  void api
                    .checkUpdate()
                    .then((u) =>
                      setUpdateMsg(
                        u.hasUpdate ? `发现新版本 v${u.version}，可下载安装` : '当前已是最新版本'
                      )
                    )
                    .catch((e) => setUpdateMsg(`检查失败：${e instanceof Error ? e.message : String(e)}`))
                    .finally(() => setUpdateBusy(false))
                }}
              >
                <IconRefresh size={13} /> 检查更新
              </button>
              <button
                className="btn btn-outline"
                disabled={updateBusy || !updateMsg.includes('发现新版本')}
                onClick={() => {
                  setUpdateBusy(true)
                  void api
                    .downloadUpdate()
                    .then((r) => setUpdateMsg(r.message))
                    .catch((e) => setUpdateMsg(`下载失败：${e instanceof Error ? e.message : String(e)}`))
                    .finally(() => setUpdateBusy(false))
                }}
              >
                下载并安装
              </button>
              <span className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                GPL-3.0 · 零 Token 成本内嵌网页版 Agent
              </span>
            </div>
            {updateMsg && (
              <div className="text-[12px]" style={{ color: 'var(--text-body)' }}>
                {updateMsg}
              </div>
            )}
          </div>
        </SettingGroup>
        </div>
      </div>
    </Page>
  )
}
