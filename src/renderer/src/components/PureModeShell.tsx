import { useEffect, useMemo, useState } from 'react'
import { useStore, useProject } from '../store'
import { api } from '../api'
import { ResizeHandle } from './ResizeHandle'
import {
  IconPlus,
  IconSearch,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconSettings,
  IconPlugin,
  IconHistory,
  IconFile
} from './icons'


/** 相对时间：刚刚 / N 分 / N 小时 / 昨天 / N 天 / 日期 */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d}天`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 纯净模式侧栏：
 * ① 项目头（项目名 + 切换）
 * ② 主操作（新建任务）
 * ③ 快捷入口（初始化项目 / 自动化 / 插件市场）
 * ④ 会话列表（搜索 + 平台过滤）
 * ⑤ 底部用户区
 * 主区由 AppShell 常驻挂载的 WebTabs 提供——切换模式不重建 webview，登录态与对话进度保留。
 */
export function PureModeShell({
  web = false,
  onLogin
}: {
  web?: boolean
  onLogin?: () => void
} = {}): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const providers = useStore((s) => s.providers)
  const project = useProject(useStore())
  const setPureView = useStore((s) => s.setPureView)
  const setPure = useStore((s) => s.setPure)
  const pureView = useStore((s) => s.pureView)
  const auxPanel = useStore((s) => s.auxPanel)
  const toggleAux = useStore((s) => s.toggleAux)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const requestSessionDelete = useStore((s) => s.requestSessionDelete)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState('')
  const [, setTick] = useState(0)

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query]
  )

  // 每分钟刷新相对时间
  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 60000)
    return () => window.clearInterval(t)
  }, [])

  const switchSession = async (id: string): Promise<void> => {
    await useStore.getState().openSession(id)
    const session = useStore.getState().activeSession
    if (session) await useStore.getState().openProviderTab(session.providerId, session.id, session.accountId)
  }

  const newSession = async (): Promise<void> => {
    const pid = providerId || activeSession?.providerId || providers[0]?.id
    if (!pid) {
      useStore.getState().notice('请先在「工作台」选择一个平台', 'warn')
      return
    }
    setPureView('home')
    await useStore.getState().createSession(pid)
    const created = useStore.getState().activeSession
    if (created) await useStore.getState().openProviderTab(created.providerId, created.id, created.accountId)
  }

  if (!sidebarOpen) {
    return (
      <button
        title="展开侧栏"
        className="flex w-9 shrink-0 items-center justify-center border-r transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        style={{ borderColor: 'var(--border)', background: 'var(--sidebar)', color: 'var(--text-hint)' }}
        onClick={() => setSidebarOpen(true)}
      >
        <IconChevronRight size={14} />
      </button>
    )
  }

  const navBtn =
    'flex h-8 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-[12.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'

  return (
    <div
      className="anim-fade relative flex shrink-0 flex-col border-r"
      style={{ width: sidebarWidth, borderColor: 'var(--border)', background: 'var(--sidebar)' }}
    >
      <ResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
      {/* ① 项目头 */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-bold"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          L
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{project?.name ?? '未打开项目'}</div>
        </div>
        <button
          title="收起侧栏"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => setSidebarOpen(false)}
        >
          <IconChevronLeft size={14} />
        </button>
      </div>

      <div className="px-2 pb-1">
        {pureView !== 'home' && (
          <button
            className={`${navBtn} mb-0.5`}
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={() => setPureView('home')}
          >
            <IconChevronLeft size={14} />
            <span className="flex-1 text-left">返回对话</span>
          </button>
        )}
        <button
          className="btn btn-primary mb-1.5 h-8 w-full justify-start gap-2 px-2.5 text-[12.5px]"
          onClick={() => void newSession()}
        >
          <IconPlus size={15} />
          <span className="flex-1 text-left">新建任务</span>
          <span className="text-[10.5px] font-normal opacity-60">Ctrl N</span>
        </button>
        {!web && (
          <>
            <button
              className={`${navBtn} ${pureView === 'tasks' ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'}`}
              style={{ color: pureView === 'tasks' ? 'var(--text)' : 'var(--text-dim)' }}
              onClick={() => setPureView('tasks')}
            >
              <span className="flex w-4 justify-center">
                <IconHistory size={15} />
              </span>
              <span className="flex-1 truncate text-left">自动化</span>
            </button>
            <button
              className={`${navBtn} ${pureView === 'plugins' ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'}`}
              style={{ color: pureView === 'plugins' ? 'var(--text)' : 'var(--text-dim)' }}
              onClick={() => setPureView('plugins')}
            >
              <span className="flex w-4 justify-center">
                <IconPlugin size={15} />
              </span>
              <span className="flex-1 truncate text-left">插件市场</span>
            </button>
          </>
        )}
      </div>

      <div className="divider mx-3 my-1.5" />

      {/* ④ 会话列表 */}
      <div className="flex items-center justify-between px-3 pb-1.5">
        <span className="text-label">任务列表</span>
        <div className="flex items-center gap-0.5">
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="清理空会话（新建后未发送的）"
            onClick={() => {
              if (!project) return
              void api
                .cleanupEmptySessions(project.id, activeSession?.id)
                .then((n) => {
                  void useStore.getState().refreshSessions()
                  if (n > 0) useStore.getState().notice(`已清理 ${n} 个空会话`)
                })
            }}
          >
            <IconClose size={12} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="搜索会话"
            onClick={() => document.getElementById('pure-search')?.focus()}
          >
            <IconSearch size={12} />
          </button>
          <select
            className="max-w-[80px] cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent text-[10.5px] outline-none"
            style={{ color: 'var(--text-hint)' }}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            title="新建会话使用的平台"
          >
            <option value="">默认平台</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="px-1.5 pb-1.5">
        <input
          id="pure-search"
          className="field h-[30px] text-[12px]"
          style={{ background: 'var(--surface)' }}
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="stable-gutter min-h-0 flex-1 overflow-y-auto py-0.5 pl-1.5 pr-1.5">
        {filtered.map((s) => {
          const active = activeSession?.id === s.id
          return (
            <div
              key={s.id}
              className="group flex h-[30px] cursor-pointer items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] transition-colors duration-[130ms]"
              style={{
                background: active ? 'var(--bg-active)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-dim)',
                fontWeight: active ? 500 : 400
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'var(--bg-hover)'
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent'
              }}
              onClick={() => void switchSession(s.id)}
            >
              {/* 平台首字徽标：扫读时一眼分辨会话归属（设计惯例：列表行 = 标识 + 标题 + 时间） */}
              <span
                className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] text-[8.5px] font-bold"
                style={{
                  background: active ? 'var(--accent)' : 'var(--accent-soft)',
                  color: active ? 'var(--on-accent)' : 'var(--accent)'
                }}
              >
                {(providers.find((x) => x.id === s.providerId)?.name ?? '?').slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {/* 时间与删除按钮占同一格：用透明度切换而不是 display 切换，
                  否则 hover 时右侧宽度变化会让标题重新截断（视觉上"整行跳一下"） */}
              <span className="relative flex h-4 w-[34px] shrink-0 items-center justify-end">
                <span
                  className="absolute right-0 text-[10px] tabular-nums transition-opacity duration-[130ms] group-hover:opacity-0"
                  style={{ color: 'var(--text-hint)' }}
                >
                  {relTime(s.updatedAt)}
                </span>
                <button
                  title="删除会话"
                  className="absolute right-0 flex items-center justify-center rounded p-0.5 opacity-0 transition-opacity duration-[130ms] hover:bg-[var(--bg-active)] group-hover:opacity-100"
                  style={{ color: 'var(--danger)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestSessionDelete(s)
                  }}
                >
                  <IconClose size={11} />
                </button>
              </span>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-2.5 py-5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
            {project ? '暂无会话，点上方「新建任务」' : '先在文件视图中打开项目'}
          </div>
        )}
      </div>

      {/* ⑤ 底部用户区 */}
      <div className="flex items-center gap-1.5 border-t px-2 py-2" style={{ borderColor: 'var(--border)' }}>
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          L
        </span>
        {web ? (
          <>
            <span className="min-w-0 flex-1 truncate px-1.5 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
              Lidow Web
            </span>
            <button className="btn btn-sm btn-outline" onClick={onLogin}>
              登录平台
            </button>
          </>
        ) : (
          <>
            <button
              className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[11.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-dim)' }}
              title="退出纯净模式，回到完整工作台"
              onClick={() => void setPure(false)}
            >
              退出纯净模式
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="设置" onClick={() => setPureView('settings')}>
              <IconSettings size={14} />
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={auxPanel === 'files' ? '收起文件面板' : '打开文件面板'}
              style={{ color: auxPanel === 'files' ? 'var(--accent)' : undefined }}
              onClick={() => toggleAux('files')}
            >
              <IconFile size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
