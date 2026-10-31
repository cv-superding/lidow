import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_ACCOUNT_ID, useStore, useActiveProject } from '../store'
import { filterSessionList } from '../sessionFilter'
import { api } from '../api'
import { ResizeHandle } from './ResizeHandle'
import {
  IconPlus,
  IconSearch,
  IconChevronLeft,
  IconClose,
  IconSettings,
  IconPlugin,
  IconHistory,
  IconFile,
  IconChevronDown,
  IconFolder,
  IconEdit,
  IconTrash
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

/** 纯净模式项目下拉：切换已打开项目 / 打开其他目录（不再跳转到管理页） */
function ProjectMenu(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const openProject = useStore((s) => s.openProject)
  const active = projects.find((x) => x.id === activeProjectId) ?? projects[0] ?? null
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pickOther = (): void => {
    setOpen(false)
    void api.pickDirectory().then((dir) => dir && void openProject(dir))
  }

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <button
        className="flex h-[34px] w-full min-w-0 items-center gap-2 rounded-[var(--r-md)] px-1.5 text-left transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
        onClick={() => setOpen((v) => !v)}
        title="切换项目"
      >
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-bold"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          {(active?.name ?? 'L').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold leading-[1.25]">
            {active?.name ?? '未打开项目'}
          </span>
          <span
            className="block truncate text-[10.5px] leading-[1.2]"
            style={{ color: 'var(--text-hint)' }}
          >
            {active?.root ?? '选择一个工作目录'}
          </span>
        </span>
        <span style={{ color: 'var(--text-hint)' }}>
          <IconChevronDown size={12} />
        </span>
      </button>

      {open && (
        <div
          className="anim-pop absolute left-0 top-full z-[70] mt-1 w-[268px] overflow-hidden rounded-[var(--r-lg)] p-1"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-menu)'
          }}
        >
          <div className="text-label px-2 py-1.5">已打开项目</div>
          {projects.length === 0 && (
            <div className="px-2 py-2 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
              还没有项目
            </div>
          )}
          {projects.map((p) => {
            const isActive = p.id === (active?.id ?? '')
            return (
              <button
                key={p.id}
                className={`flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors duration-[100ms] ${
                  isActive ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]'
                }`}
                onClick={() => {
                  setOpen(false)
                  if (isActive) return
                  void openProject(p.root)
                }}
              >
                <span className="shrink-0" style={{ color: 'var(--text-hint)' }}>
                  <IconFolder size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{p.name}</span>
                  <span
                    className="block truncate font-mono text-[10px]"
                    style={{ color: 'var(--text-hint)' }}
                  >
                    {p.root}
                  </span>
                </span>
                {isActive && <span style={{ color: 'var(--accent)' }}>使用中</span>}
              </button>
            )
          })}
          <div className="divider-soft my-1" />
          <button
            className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms] hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-dim)' }}
            onClick={pickOther}
          >
            <IconPlus size={12} /> 打开其他目录…
          </button>
        </div>
      )}
    </div>
  )
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
  const project = useActiveProject()
  const setPureView = useStore((s) => s.setPureView)
  const setPure = useStore((s) => s.setPure)
  const pureView = useStore((s) => s.pureView)
  const auxPanel = useStore((s) => s.auxPanel)
  const toggleAux = useStore((s) => s.toggleAux)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const requestSessionDelete = useStore((s) => s.requestSessionDelete)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameCancelled = useRef(false)
  const beginRename = (s: { id: string; title: string }): void => {
    renameCancelled.current = false
    setRenamingId(s.id)
    setRenameText(s.title)
  }
  const commitRename = async (s: { id: string; title: string }): Promise<void> => {
    if (renameCancelled.current) {
      setRenamingId(null)
      return
    }
    const title = renameText.trim()
    setRenamingId(null)
    if (!title || title === s.title) return
    try {
      await api.renameSession(s.id, title)
      await useStore.getState().refreshSessions()
      const active = useStore.getState().activeSession
      if (active?.id === s.id) {
        useStore.setState({ activeSession: { ...active, title, titleLocked: true } })
      }
    } catch (e) {
      useStore
        .getState()
        .notice(`重命名失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState(() => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.providerId ?? s.activeSession?.providerId ?? s.sessions[0]?.providerId ?? ''
  })
  const [, setTick] = useState(0)

  // 纯净模式按当前网页平台/账号隔离会话：切到 DeepSeek 只看 DeepSeek，
  // 切到 Claude 只看 Claude；多账号也不互相混。
  const currentProvider = activeTab?.providerId ?? activeSession?.providerId ?? ''
  const currentAccount = activeTab?.accountId ?? activeSession?.accountId ?? ''
  // 只在网页标签/当前会话变化时同步过滤平台；用户手动在下拉里选平台时
  // 不能立刻被这里拉回去（此前会导致下拉框永远跳回 DeepSeek，切不了平台）。
  useEffect(() => {
    if (currentProvider) setProviderId(currentProvider)
  }, [currentProvider])
  useEffect(() => {
    if (!providerId && sessions[0]) setProviderId(sessions[0].providerId)
  }, [providerId, sessions])

  const filtered = useMemo(
    () => filterSessionList(sessions, { query, providerId, currentProvider, currentAccount }),
    [sessions, query, providerId, currentProvider, currentAccount]
  )

  // 每分钟刷新相对时间
  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 60000)
    return () => window.clearInterval(t)
  }, [])

  const switchSession = async (id: string): Promise<void> => {
    try {
      await useStore.getState().openSession(id)
      const session = useStore.getState().activeSession
      if (session)
        await useStore
          .getState()
          .openProviderTab(session.providerId, session.id, session.accountId ?? DEFAULT_ACCOUNT_ID)
    } catch (e) {
      useStore
        .getState()
        .notice(`切换会话失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
    }
  }

  const newSession = async (): Promise<void> => {
    const pid = providerId || activeSession?.providerId || providers[0]?.id
    if (!pid) {
      useStore.getState().notice('请先在「工作台」选择一个平台', 'warn')
      return
    }
    setPureView('home')
    try {
      const created = await useStore.getState().createSession(pid)
      if (!created) return
      await useStore
        .getState()
        .openProviderTab(created.providerId, created.id, created.accountId ?? DEFAULT_ACCOUNT_ID)
    } catch (e) {
      useStore
        .getState()
        .notice(`新建任务失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
    }
  }

  /**
   * 纯净模式平台选择：切到该平台最近一条会话；没有会话就新建。
   * 只改过滤状态不切 activeSession 的话，输入框仍会把消息发进上一个平台，
   * 用户看到的“每个平台对话框独立”就会被打破。
   */
  const switchProvider = async (pid: string): Promise<void> => {
    if (!pid || pid === currentProvider) return
    setProviderId(pid)
    const norm = (a?: string): string => a || '__default__'
    const all = useStore.getState().sessions.filter((s) => s.providerId === pid)
    const sameAccount = all.filter((s) => norm(s.accountId) === norm(currentAccount))
    const candidate = (sameAccount.length > 0 ? sameAccount : all).sort(
      (a, b) => b.updatedAt - a.updatedAt
    )[0]
    if (candidate) {
      await switchSession(candidate.id)
      return
    }
    setPureView('home')
    try {
      const created = await useStore.getState().createSession(pid)
      if (!created) return
      await useStore
        .getState()
        .openProviderTab(created.providerId, created.id, created.accountId ?? DEFAULT_ACCOUNT_ID)
    } catch (e) {
      useStore
        .getState()
        .notice(`切换平台失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
    }
  }

  const navBtn =
    'flex h-8 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-[12.5px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'

  return (
    <div
      className="anim-fade relative flex shrink-0 flex-col border-r"
      style={{
        width: sidebarWidth,
        borderColor: 'var(--border)',
        background: 'var(--sidebar)',
        zIndex: 40
      }}
    >
      <ResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
      {/* ① 项目头（侧栏固定展开，不再提供折叠/展开按钮） */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <ProjectMenu />
      </div>

      <div className="px-2 pb-1">
        {pureView !== 'home' ? (
          <button
            className="btn btn-primary mb-1.5 h-[34px] w-full justify-start gap-2 rounded-[var(--r-md)] px-2.5 text-[12.5px]"
            style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.16), var(--shadow-sm)' }}
            onClick={() => setPureView('home')}
          >
            <IconChevronLeft size={14} />
            <span className="flex-1 text-left">返回对话</span>
          </button>
        ) : (
          <button
            className="btn btn-primary mb-1.5 h-[34px] w-full justify-start gap-2 rounded-[var(--r-md)] px-2.5 text-[12.5px]"
            style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.16), var(--shadow-sm)' }}
            onClick={() => void newSession()}
          >
            <IconPlus size={15} />
            <span className="flex-1 text-left">新建任务</span>
            <span className="text-[10.5px] font-normal opacity-70">Ctrl N</span>
          </button>
        )}
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
              <span className="flex-1 truncate text-left">任务看板</span>
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
          <select
            className="max-w-[86px] cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent text-[10.5px] outline-none"
            style={{ color: 'var(--text-hint)' }}
            value={providerId}
            onChange={(e) => void switchProvider(e.target.value)}
            title="切换平台（各平台会话独立）"
          >
            <option value="" disabled>
              选择平台
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="清理空会话（新建后未发送的）"
            onClick={() => {
              if (!project) {
                useStore.getState().notice('请先初始化项目，再清理空会话', 'warn')
                return
              }
              void api
                .cleanupEmptySessions(project.id, activeSession?.id)
                .then((n) => {
                  void useStore.getState().refreshSessions().catch(() => undefined)
                  useStore.getState().notice(n > 0 ? `已清理 ${n} 个空会话` : '没有需要清理的空会话')
                })
                .catch((e) => {
                  useStore
                    .getState()
                    .notice(`清理失败：${e instanceof Error ? e.message : String(e)}`, 'warn')
                })
            }}
          >
            <IconTrash size={12} />
          </button>
        </div>
      </div>

      <div className="px-2.5 pb-2">
        <label
          className="flex h-[30px] items-center gap-1.5 rounded-[var(--r-md)] border px-2 transition-colors focus-within:border-[var(--accent-ring)]"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <span style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={13} />
          </span>
          <input
            id="pure-search"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--text)' }}
            placeholder="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="stable-gutter min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <div className="px-2.5 py-4 text-[11px]" style={{ color: 'var(--text-hint)' }}>
            {query.trim() ? '没有匹配的会话' : '当前平台暂无会话'}
          </div>
        )}
        {(['今天', '更早'] as const).map((groupLabel) => {
          const rows = filtered.filter((x) =>
            groupLabel === '今天'
              ? new Date(x.updatedAt).toDateString() === new Date().toDateString()
              : new Date(x.updatedAt).toDateString() !== new Date().toDateString()
          )
          if (rows.length === 0) return null
          return (
            <div key={groupLabel}>
              <div className="flex items-center justify-between px-1 pb-1 pt-2.5">
                <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-hint)' }}>
                  {groupLabel}
                </span>
                <span className="text-[10px]" style={{ color: 'var(--text-hint)' }}>
                  {rows.length}
                </span>
              </div>
              {rows.map((s) => {
                const active = activeSession?.id === s.id
                return (
                  <div
                    key={s.id}
                    className="group flex h-[32px] cursor-pointer items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] transition-colors duration-[110ms]"
                    style={{
                      background: active ? 'var(--surface)' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-dim)',
                      fontWeight: active ? 500 : 400,
                      boxShadow: active ? 'inset 0 0 0 1px var(--border), var(--shadow-sm)' : 'none'
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = 'var(--bg-hover)'
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => void switchSession(s.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      beginRename(s)
                    }}
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
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.nativeEvent.isComposing) return
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename(s)
                          } else if (e.key === 'Escape') {
                            renameCancelled.current = true
                            setRenamingId(null)
                          }
                        }}
                        onBlur={() => void commitRename(s)}
                        className="min-w-0 flex-1 rounded-[var(--r-sm)] bg-transparent px-1 text-[12px] outline-none"
                        style={{ border: '1px solid var(--accent-ring)', color: 'var(--text)' }}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    )}
                    {/* 时间与删除按钮占同一格：用透明度切换而不是 display 切换，
                  否则 hover 时右侧宽度变化会让标题重新截断（视觉上"整行跳一下"） */}
                    <span className="relative flex h-4 w-[52px] shrink-0 items-center justify-end">
                      <span
                        className="absolute right-0 text-[10px] tabular-nums transition-opacity duration-[130ms] group-hover:opacity-0"
                        style={{ color: 'var(--text-hint)' }}
                      >
                        {relTime(s.updatedAt)}
                      </span>
                      <button
                        title="重命名会话"
                        className="absolute right-[18px] flex items-center justify-center rounded p-0.5 opacity-0 transition-opacity duration-[130ms] hover:bg-[var(--bg-active)] group-hover:opacity-100"
                        style={{ color: 'var(--text-hint)' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          beginRename(s)
                        }}
                      >
                        <IconEdit size={11} />
                      </button>
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
            </div>
          )
        })}
      </div>

      {/* ⑤ 底部用户区 */}
      <div
        className="flex items-center gap-1.5 border-t px-2 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          L
        </span>
        {web ? (
          <>
            <span
              className="min-w-0 flex-1 truncate px-1.5 text-[11.5px]"
              style={{ color: 'var(--text-dim)' }}
            >
              Lidow Web
            </span>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                // 桌面纯模式没有 onLogin 回调：之前按钮是死的。
                // 退到工作台平台选择页，用户可以在那里登录/选账号。
                if (onLogin) onLogin()
                else void setPure(false)
              }}
            >
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
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title="设置"
              onClick={() => setPureView('settings')}
            >
              <IconSettings size={14} />
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={auxPanel === 'files' ? '收起文件面板' : '打开文件面板'}
              style={{ color: auxPanel === 'files' ? 'var(--accent)' : undefined }}
              onClick={() => {
                // 管理页不挂载右侧面板：先回到对话页再开关
                setPureView('home')
                toggleAux('files')
              }}
            >
              <IconFile size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
