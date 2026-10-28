import { useEffect, useMemo, useState } from 'react'
import { useStore, useProject } from '../store'
import { api } from '../api'
import {
  IconPlus,
  IconSearch,
  IconFolder,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconSettings,
  IconPlugin,
  IconHistory,
  IconFile
} from './icons'


/** 初始化项目弹窗：选目录 + 输入第一句话（cuckoo init-prompt 同款） */
function InitProjectModal({ onClose, onSend }: { onClose: () => void; onSend: (text: string) => void }): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async (): Promise<void> => {
    const d = await api.pickDirectory()
    if (d) setDir(d)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }}>
      <div
        className="anim-pop w-[560px] max-w-[92vw] rounded-2xl p-5"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow)' }}
      >
        <div className="mb-4 text-[15px] font-semibold">初始化项目</div>
        <div className="mb-1.5 text-[12px]" style={{ color: 'var(--text-hint)' }}>项目目录</div>
        <div className="mb-4 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[12.5px] outline-none"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
            placeholder="请先选择项目目录"
            readOnly
            value={dir}
          />
          <button
            className="shrink-0 rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={() => void pick()}
          >
            选择目录
          </button>
        </div>
        <div className="mb-1.5 text-[12px]" style={{ color: 'var(--text-hint)' }}>
          你要对 AI 说的第一句话（发送时自动附加项目上下文与系统提示词）
        </div>
        <textarea
          className="mb-4 min-h-[110px] w-full resize-none rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)' }}
          placeholder="例如：帮我看看这个项目的入口文件在哪里…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button
            className="rounded-lg px-4 py-2 text-[12.5px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded-lg px-4 py-2 text-[12.5px] disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
            disabled={!dir || !text.trim() || busy}
            onClick={() => {
              setBusy(true)
              if (dir) void api.openProject(dir).then(() => onSend(text.trim()))
            }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

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

/** 右侧文件预览面板：文件树 + 内容预览（可折叠） */
export function PreviewPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const fileTree = useStore((s) => s.fileTree)
  const selectedFile = useStore((s) => s.selectedFile)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void api.readFileTree(projectId, '', 3).then((tree) => useStore.setState({ fileTree: tree }))
  }, [projectId])

  const load = (p: string): void => {
    void api.readFileContent(projectId, p).then((content) => useStore.setState({ selectedFile: { path: p, content } }))
  }

  const renderNodes = (items: typeof fileTree, depth: number): React.JSX.Element[] =>
    items.map((n) => (
      <div key={n.path}>
        <button
          className="sl flex w-full items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left text-[12px]"
          style={{
            paddingLeft: 8 + depth * 12,
            color: n.type === 'dir' ? 'var(--text)' : 'var(--text-dim)',
            background: selectedFile?.path === n.path ? 'var(--bg-hover)' : 'transparent'
          }}
          onClick={() => n.type === 'file' && load(n.path)}
        >
          <span className="shrink-0" style={{ color: n.type === 'dir' ? 'var(--accent)' : 'var(--text-hint)' }}>
            {n.type === 'dir' ? <IconFolder size={12} /> : <IconFile size={12} />}
          </span>
          <span className="truncate">{n.name}</span>
        </button>
        {n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

  return (
    <div
      className="flex shrink-0 flex-col border-l transition-[width] duration-200"
      style={{ width: open ? 300 : 40, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
    >
      <button
        title={open ? '收起文件面板' : '展开文件面板'}
        className="flex h-9 shrink-0 items-center justify-center border-b transition-colors hover:bg-[var(--bg-hover)]"
        style={{ borderColor: 'var(--border)', color: 'var(--text-hint)' }}
        onClick={() => setOpen(!open)}
      >
        {open ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}
      </button>
      {open && (
        <>
          <div className="max-h-[40%] min-h-0 overflow-y-auto px-2 py-2">{renderNodes(fileTree, 0)}</div>
          <div className="min-h-0 flex-1 overflow-auto border-t px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
            {selectedFile ? (
              <>
                <div className="mb-1.5 truncate font-mono text-[11px]" style={{ color: 'var(--text-hint)' }}>{selectedFile.path}</div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">{selectedFile.content}</pre>
              </>
            ) : (
              <div className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>点击上方文件预览</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 侧栏分组标题 */
function GroupLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="px-2 pb-1 pt-3">
      <span className="truncate text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
        {children}
      </span>
    </div>
  )
}

/**
 * 纯净模式侧栏（ZCode 式布局）：
 * ① 顶部动作区（新建任务 / 自动化 / 插件市场）
 * ② 任务列表（搜索 + 平台选择 + 会话行）
 * ③ 底部用户区
 * 主区由 AppShell 常驻挂载的 WebTabs 提供——切换模式不重建 webview，登录态与对话进度保留。
 */
export function PureModeShell(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const providers = useStore((s) => s.providers)
  const project = useProject(useStore())
  const setPureView = useStore((s) => s.setPureView)
  const setPure = useStore((s) => s.setPure)
  const pureView = useStore((s) => s.pureView)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState('')
  const [initOpen, setInitOpen] = useState(false)
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
    if (session) await useStore.getState().openProviderTab(session.providerId, session.id)
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
    if (created) await useStore.getState().openProviderTab(created.providerId, created.id)
  }

  const deleteSession = async (id: string): Promise<void> => {
    await api.deleteSession(id)
    if (activeSession?.id === id) useStore.setState({ activeSession: null })
    await useStore.getState().refreshSessions()
    useStore.getState().notice('会话已删除')
  }

  if (!sidebarOpen) {
    return (
      <button
        title="展开侧栏"
        className="flex w-9 shrink-0 items-center justify-center border-r transition-colors hover:bg-[var(--bg-hover)]"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text-hint)' }}
        onClick={() => setSidebarOpen(true)}
      >
        <IconChevronRight size={14} />
      </button>
    )
  }

  return (
    <div
      className="anim-fade flex w-[272px] shrink-0 flex-col border-r"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
    >
      {/* ① 顶部动作区 */}
      <div className="flex flex-col gap-0.5 px-2 pb-1 pt-2">
        {pureView !== 'home' && (
          <button
            className="sl mb-1 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={() => setPureView('home')}
          >
            <IconChevronLeft size={13} />
            <span className="flex-1 text-left">返回对话</span>
          </button>
        )}
        <button
          className="sl flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] font-medium"
          style={{ color: 'var(--text)' }}
          onClick={() => void newSession()}
        >
          <span className="shrink-0" style={{ color: 'var(--accent)' }}>
            <IconPlus size={15} />
          </span>
          <span className="flex-1 truncate text-left">新建任务</span>
          <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-hint)' }}>Ctrl+N</span>
        </button>
        <button
          className="sl flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]"
          style={{ color: 'var(--text-dim)' }}
          onClick={() => setInitOpen(true)}
        >
          <span className="shrink-0"><IconFolder size={15} /></span>
          <span className="flex-1 truncate text-left">初始化项目</span>
        </button>
        <button
          className="sl flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]"
          style={{ color: pureView === 'tasks' ? 'var(--text)' : 'var(--text-dim)', background: pureView === 'tasks' ? 'var(--bg-hover)' : 'transparent' }}
          onClick={() => setPureView('tasks')}
        >
          <span className="shrink-0"><IconHistory size={15} /></span>
          <span className="flex-1 truncate text-left">自动化</span>
        </button>
        <button
          className="sl flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]"
          style={{ color: 'var(--text-dim)' }}
          onClick={() => setPureView('plugins')}
        >
          <span className="shrink-0"><IconPlugin size={15} /></span>
          <span className="flex-1 truncate text-left">插件市场</span>
        </button>
      </div>

      <div className="mx-2 border-t" style={{ borderColor: 'var(--border)' }} />

      {/* ② 任务列表头 */}
      <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
          任务列表
        </span>
        <div className="flex items-center gap-0.5">
          <button
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-hint)' }}
            title="搜索会话"
            onClick={() => document.getElementById('pure-search')?.focus()}
          >
            <IconSearch size={12} />
          </button>
          <select
            className="max-w-[76px] rounded border-0 bg-transparent text-[10.5px] outline-none"
            style={{ color: 'var(--text-hint)' }}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            title="新建会话使用的平台"
          >
            <option value="">默认平台</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="px-2 pb-1">
        <input
          id="pure-search"
          className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid transparent', color: 'var(--text)' }}
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* ② 会话列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {project && <GroupLabel>{project.name ?? '当前项目'}</GroupLabel>}
        {filtered.map((s) => {
          const active = activeSession?.id === s.id
          return (
            <div
              key={s.id}
              className="sl group flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] transition-colors"
              style={{
                background: active ? 'var(--bg-hover)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-dim)'
              }}
              onClick={() => void switchSession(s.id)}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: s.compactedTurns > 0 ? 'var(--accent)' : 'var(--border-strong)' }}
              />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-hint)' }}>{relTime(s.updatedAt)}</span>
              <button
                title="删除会话"
                className="hidden shrink-0 rounded p-0.5 group-hover:block hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--danger)' }}
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteSession(s.id)
                }}
              >
                <IconClose size={11} />
              </button>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-2 py-4 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            {project ? '暂无会话，点上方「新建任务」' : '先在文件视图中打开项目'}
          </div>
        )}
      </div>

      {/* 初始化项目弹窗（cuckoo 同款：选目录 + 第一句话，发送时附加系统提示词） */}
      {initOpen && (
        <InitProjectModal
          onClose={() => setInitOpen(false)}
          onSend={async (text) => {
            setInitOpen(false)
            // 建会话并发送（sendPrompt 会注入完整系统提示词）
            const pid = providerId || activeSession?.providerId || providers[0]?.id
            if (!pid) {
              useStore.getState().notice('请先选择一个 AI 平台', 'warn')
              return
            }
            if (!activeSession) await useStore.getState().createSession(pid)
            setPureView('home')
            await useStore.getState().sendPrompt(text)
          }}
        />
      )}

      {/* ③ 底部用户区 */}
      <div className="flex items-center gap-2 border-t px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          L
        </span>
        <button
          className="sl min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[11.5px] transition-colors"
          style={{ color: 'var(--text-dim)' }}
          title="退出纯净模式，回到完整工作台"
          onClick={() => void setPure(false)}
        >
          退出纯净模式
        </button>
        <button
          title="设置"
          className="rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-hint)' }}
          onClick={() => setPureView('settings')}
        >
          <IconSettings size={13} />
        </button>
        <button
          title="收起侧栏"
          className="rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-hint)' }}
          onClick={() => setSidebarOpen(false)}
        >
          <IconChevronLeft size={13} />
        </button>
      </div>
    </div>
  )
}
