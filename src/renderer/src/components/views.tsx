import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import type { AppSettings, TaskItem } from '@shared/types'
import { IconPlus, IconRefresh, IconTrash, IconClose, IconCheck, IconFolder, IconSearch } from './icons'

/** 统一页面骨架：标题区 + 滚动内容 */
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
    <div className="anim-view flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      <div className="shrink-0 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="mx-auto flex max-w-[860px] items-center gap-3 px-6 py-3.5">
          <div className="min-w-0">
            <div className="text-title truncate">{title}</div>
            {subtitle && (
              <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                {subtitle}
              </div>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[860px]">{children}</div>
      </div>
    </div>
  )
}

/** 空状态：左对齐，与区块标题对齐 */
function Empty({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--r-lg)] px-3.5 py-3" style={{ background: 'var(--surface-sunken)' }}>
      {icon && <span style={{ color: 'var(--text-hint)' }}>{icon}</span>}
      <span className="shrink-0 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
        {title}
      </span>
      {hint && (
        <span className="truncate text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          {hint}
        </span>
      )}
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

// ---------------------------------------------------------------- 会话

export function SessionsView(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const openSession = useStore((s) => s.openSession)
  const createSession = useStore((s) => s.createSession)
  const providers = useStore((s) => s.providers)

  return (
    <Page
      title="会话"
      subtitle={`${sessions.length} 个会话`}
      actions={
        (providers ?? []).map((p) => (
          <button key={p.id} className="btn btn-sm btn-outline" onClick={() => void createSession(p.id)}>
            <IconPlus size={12} /> {p.name}
          </button>
        )) ?? null
      }
    >
      {sessions.length === 0 ? (
        <Empty title="暂无会话" hint="到工作台选择一个平台开始，或点右上角新建" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sessions.map((s) => (
            <div key={s.id} className="card card-interactive group flex flex-col p-3.5">
              <button className="min-w-0 text-left" onClick={() => void openSession(s.id)}>
                <div className="mb-1.5 truncate text-[13px] font-medium">{s.title}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="badge badge-accent">{s.providerId}</span>
                  {s.compactedTurns > 0 && <span className="badge">已压缩 {s.compactedTurns} 轮</span>}
                  {s.parentSessionId && <span className="badge">分叉</span>}
                </div>
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                  {new Date(s.updatedAt).toLocaleString('zh-CN')}
                </div>
              </button>
              <div className="mt-3 flex items-center gap-1.5 border-t pt-2.5" style={{ borderColor: 'var(--border-soft)' }}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() =>
                    void api.exportSession(s.id).then((path) => {
                      useStore.getState().notice(`已导出：${path}`)
                    })
                  }
                >
                  导出 Markdown
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
  return (
    <>
      {nodes.map((n) => (
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
              <IconFolder size={12} />
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
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null

  useEffect(() => {
    if (project) void api.readFileTree(project.id, '', 3).then((tree) => useStore.setState({ fileTree: tree }))
  }, [project])

  return (
    <Page title="文件" subtitle={project?.root ?? '未打开项目'}>
      {!project ? (
        <Empty title="未打开项目" hint="先在纯净模式或工作台初始化一个项目目录" />
      ) : (
        <div className="flex h-[calc(100vh-140px)] gap-3">
          <div className="card w-[280px] shrink-0 overflow-y-auto p-1.5">
            {fileTree.length === 0 ? (
              <div className="px-2 py-4 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                目录为空
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
                  {selectedFile.path}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.65]" style={{ color: 'var(--text-body)' }}>
                  {selectedFile.content}
                </pre>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--text-hint)' }}>
                点击左侧文件预览内容
              </div>
            )}
          </div>
        </div>
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
  const projects = useStore((s) => s.projects)
  const hasProject = projects.length > 0
  const refresh = (): void => void api.listTodos().then((t) => useStore.setState({ todos: t }))
  useEffect(() => {
    if (hasProject) refresh()
  }, [hasProject])
  const [newTitle, setNewTitle] = useState('')

  if (!hasProject) return <Page title="任务看板"><Empty title="先打开项目" /></Page>

  const doneCount = todos.filter((t) => t.status === 'done').length

  return (
    <Page
      title="任务看板"
      subtitle={`${doneCount} / ${todos.length} 已完成 · AI 会通过 todoWrite 自动同步`}
      actions={
        <>
          <button className="btn btn-sm btn-outline" onClick={() => void api.clearDoneTodos().then(refresh)}>
            清理已完成
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      <div className="mb-4 flex gap-2">
        <input
          className="field"
          placeholder="添加待办，回车确认"
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

// ---------------------------------------------------------------- 插件

export function PluginsView(): React.JSX.Element {
  const installedPlugins = useStore((s) => s.installedPlugins)
  const marketResults = useStore((s) => s.marketResults)
  const [query, setQuery] = useState('')
  const [coverage, setCoverage] = useState<{ total: number; implemented: string[] } | null>(null)
  const refresh = (): void => {
    void api.listInstalledPlugins().then((p) => useStore.setState({ installedPlugins: p }))
    void api.dshCoverage().then(setCoverage)
  }
  useEffect(refresh, [])

  return (
    <Page
      title="插件与 DSH"
      subtitle={coverage ? `DSH 兼容 ${coverage.implemented.length} / ${coverage.total}` : undefined}
      actions={
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={13} />
          </span>
          <input
            className="field w-60 pl-8"
            placeholder="搜索市场（GitHub / Gitee）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void api.searchMarket(query).then((r) => useStore.setState({ marketResults: r }))}
          />
        </div>
      }
    >
      <SectionTitle count={installedPlugins.length}>已安装</SectionTitle>
      {installedPlugins.length === 0 ? (
        <Empty title="暂无插件" hint="从下方市场搜索并安装" />
      ) : (
        <div className="mb-7 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {installedPlugins.map((p) => (
            <div key={p.id} className="card flex flex-col p-3.5">
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                <span className="badge">v{p.version}</span>
              </div>
              <div className="mb-3 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                {p.description}
              </div>
              <div className="mt-auto flex gap-1.5">
                <button className="btn btn-sm btn-outline" onClick={() => void api.togglePlugin(p.id, false).then(refresh)}>
                  停用
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => void api.uninstallPlugin(p.id).then(refresh)}>
                  卸载
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle count={marketResults.length}>市场</SectionTitle>
      {marketResults.length === 0 ? (
        <Empty title="搜索插件市场" hint="输入关键词后回车，从 GitHub 与 Gitee 检索可用插件" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {marketResults.map((m) => (
            <div key={m.repoUrl} className="card flex flex-col p-3.5">
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
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void api.installPlugin(`${m.source}:${m.id}`).then(refresh)}
                  >
                    安装
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- 记忆

export function MemoryView(): React.JSX.Element {
  const memoryList = useStore((s) => s.memoryList)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const add = (): void => {
    if (!title || !content) return
    void api.addMemory(title, content, []).then(() => {
      setTitle('')
      setContent('')
      void api.listMemory().then((m) => useStore.setState({ memoryList: m }))
    })
  }

  return (
    <Page title="用户记忆" subtitle={`${memoryList.length} 条 · AI 也可通过 remember 工具写入`}>
      <div className="card mb-5 p-3.5">
        <div className="mb-2 text-label">新增记忆</div>
        <div className="flex gap-2">
          <input className="field w-48 shrink-0" placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
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

      {memoryList.length === 0 ? (
        <Empty title="暂无记忆" hint="让 AI 记住关键结论，它会在后续会话里自动参考" />
      ) : (
        <div className="space-y-1.5">
          {memoryList.map((m) => (
            <div key={m.id} className="card group flex items-start gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">{m.title}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {m.content}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm opacity-0 transition-opacity group-hover:opacity-100"
                title="删除"
                style={{ color: 'var(--danger)' }}
                onClick={() =>
                  void api.deleteMemory(m.id).then(() => api.listMemory().then((x) => useStore.setState({ memoryList: x })))
                }
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

  return (
    <Page
      title="本地知识库"
      subtitle={`${kbs.length} 个库 · AI 也可用 kbSearch 工具检索`}
      actions={
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
      }
    >
      {kbs.length === 0 ? (
        <Empty title="暂无知识库" hint="挂载一个本地目录，AI 就能检索其中的文档" />
      ) : (
        <>
          <div className="card mb-5 p-3.5">
            <div className="mb-2 text-label">检索</div>
            <div className="flex gap-2">
              <select className="field w-52 shrink-0 cursor-pointer" value={kbId} onChange={(e) => setKbId(e.target.value)}>
                <option value="">选择知识库…</option>
                {kbs.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}（{k.fileCount} 文档）
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="查询内容"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
              />
              <button className="btn btn-outline shrink-0" disabled={!kbId} onClick={search}>
                搜索
              </button>
            </div>
          </div>

          {hits.length === 0 ? (
            <Empty title="输入查询内容开始检索" />
          ) : (
            <div className="space-y-1.5">
              {hits.map((h) => (
                <div key={h.path} className="card px-3.5 py-3">
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
  const refresh = (): void => void api.listAudit(undefined, 200).then((a) => useStore.setState({ audits: a }))
  useEffect(refresh, [])

  return (
    <Page
      title="执行审计"
      subtitle={`${audits.length} 条记录 · 支持单步回滚`}
      actions={
        <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={refresh}>
          <IconRefresh size={13} />
        </button>
      }
    >
      {audits.length === 0 ? (
        <Empty title="暂无记录" hint="AI 执行文件改动后，这里会留下可回滚的审计条目" />
      ) : (
        <div className="space-y-1">
          {audits.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-[var(--r-md)] px-3 py-2 transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]">
              <span className="badge shrink-0">{a.kind}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.summary}</span>
              <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-hint)' }}>
                {new Date(a.ts).toLocaleTimeString('zh-CN')}
              </span>
              {a.reverted ? (
                <span className="badge shrink-0" style={{ color: 'var(--warning)' }}>
                  已回滚
                </span>
              ) : a.backupPath ? (
                <button className="btn btn-sm btn-outline shrink-0" onClick={() => void api.revertAudit(a.id).then(refresh)}>
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

// ---------------------------------------------------------------- 设置

/** 设置分组卡片 */
function SettingGroup({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="card p-4">
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

export function SettingsView(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const mcpServers = useStore((s) => s.mcpServers)
  const mcpTools = useStore((s) => s.mcpTools)
  const s = settings

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

  return (
    <Page title="设置" subtitle={`Lidow v${useStore.getState().version || '0.3.0'}`}>
      <div className="mx-auto flex max-w-[720px] flex-col gap-3.5">
        {/* 外观 */}
        <SettingGroup title="外观" desc="主题与主色。切换立即生效。">
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
        <SettingGroup title="安全" desc="危险操作拦截、网络防护与提示注入防御。">
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
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12.5px]">
              <input type="checkbox" checked={s.autoCompact} onChange={(e) => patch({ autoCompact: e.target.checked })} />
              自动压缩上下文
            </label>
          </div>
        </SettingGroup>

        {/* 平台与账号 */}
        <SettingGroup title="平台与账号" desc="多账号切换；每个账号使用独立分区，登录态互不干扰。">
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

        {/* MCP */}
        <SettingGroup title="MCP 服务器" desc="兼容 Claude Desktop 配置格式。">
          <div className="mb-2.5 flex gap-2">
            <input id="mcp-name" className="field w-32 shrink-0" placeholder="名称" />
            <input id="mcp-cmd" className="field" placeholder="command（如 npx）" />
            <input id="mcp-args" className="field w-44 shrink-0" placeholder="args，逗号分隔" />
            <button
              className="btn btn-primary shrink-0"
              onClick={() => {
                const name = (document.getElementById('mcp-name') as HTMLInputElement).value
                const command = (document.getElementById('mcp-cmd') as HTMLInputElement).value
                const args = (document.getElementById('mcp-args') as HTMLInputElement).value
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean)
                if (!name || !command) return
                void api
                  .addMcpServer({ name, command, args, enabled: true })
                  .then(() => api.listMcpTools().then((t) => useStore.setState({ mcpTools: t })))
              }}
            >
              添加
            </button>
          </div>
          {mcpServers.length === 0 ? (
            <div className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
              尚未配置 MCP 服务器
            </div>
          ) : (
            <div className="space-y-1">
              {mcpServers.map((srv) => (
                <div key={srv.name} className="flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[12px]" style={{ background: 'var(--surface-sunken)' }}>
                  <span className="font-mono font-medium">{srv.name}</span>
                  <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-hint)' }}>
                    {srv.command} {srv.args?.join(' ')}
                  </span>
                  <button
                    className="btn btn-ghost btn-icon btn-sm ml-auto"
                    title="移除"
                    onClick={() =>
                      void api.removeMcpServer(srv.name).then(() => api.listMcpServers().then((s2) => useStore.setState({ mcpServers: s2 })))
                    }
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {mcpTools.length > 0 && (
            <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
              可用工具：{mcpTools.map((t) => `${t.server}/${t.name}`).join('、')}
            </div>
          )}
        </SettingGroup>

        {/* 同步 */}
        <SettingGroup title="多端同步" desc="会话事件推送到群机器人 Webhook。">
          {(['feishu', 'wecom', 'dingtalk'] as const).map((ch) => (
            <div key={ch} className="mb-2 flex items-center gap-2.5">
              <span className="w-[68px] shrink-0 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {ch}
              </span>
              <input
                className="field"
                placeholder="webhook URL"
                defaultValue={s.sync[ch]?.webhookUrl ?? ''}
                onBlur={(e) => patch({ sync: { ...s.sync, [ch]: { webhookUrl: e.target.value, enabled: Boolean(e.target.value) } } })}
              />
            </div>
          ))}
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            会话事件将推送到已配置的群；入站方向需企业自建应用
          </div>
        </SettingGroup>

        {/* 更新 */}
        <SettingGroup title="关于与更新">
          <div className="flex items-center gap-2.5">
            <button
              className="btn btn-outline"
              onClick={() =>
                void api.checkUpdate().then((u) => alert(u.hasUpdate ? `发现新版本 ${u.version}` : '当前已是最新版本'))
              }
            >
              <IconRefresh size={13} /> 检查更新
            </button>
            <span className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
              GPL-3.0 · 零 Token 成本内嵌网页版 Agent
            </span>
          </div>
        </SettingGroup>
      </div>
    </Page>
  )
}
