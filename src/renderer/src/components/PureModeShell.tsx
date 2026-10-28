import { useEffect, useMemo, useState } from 'react'
import { useStore, useProject } from '../store'
import { api } from '../api'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'
import { DragStrip } from './TitleBar'
import { IconFolderOpen, IconChevronLeft, IconChevronRight, IconClose, IconSearch, IconPlus, IconStop, IconDownload, IconCompress, IconFile } from './icons'

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

/** 右侧文件预览面板：文件树 + 内容预览（可折叠，ZCode 式） */
function PreviewPanel({ projectId }: { projectId: string }): React.JSX.Element {
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
          className="sl w-full truncate rounded-lg py-1.5 pr-2 text-left text-[12px]"
          style={{
            paddingLeft: 8 + depth * 14,
            color: n.type === 'dir' ? 'var(--text)' : 'var(--text-dim)',
            background: selectedFile?.path === n.path ? 'var(--bg-hover)' : 'transparent'
          }}
          onClick={() => n.type === 'file' && load(n.path)}
        >
          <span className="mr-1 inline-flex align-middle" style={{ color: n.type === 'dir' ? 'var(--accent)' : 'var(--text-hint)' }}>
            {n.type === 'dir' ? <IconFolderOpen size={11} /> : <IconFile size={11} />}
          </span>
          {n.name}
        </button>
        {n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

  return (
    <div
      className="flex shrink-0 flex-col border-l transition-panel"
      style={{ width: open ? 300 : 44, borderColor: 'var(--border)', background: 'var(--bg-panel)' }}
    >
      <button
        title={open ? '收起预览面板' : '展开文件预览'}
        className="flex h-11 items-center justify-center border-b text-[13px]"
        style={{ borderColor: 'var(--border)' }}
        onClick={() => setOpen(!open)}
      >
        {open ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
      </button>
      {open && (
        <div className="anim-fade flex min-h-0 flex-1 flex-col">
          <div className="max-h-[38%] min-h-0 overflow-y-auto px-2 py-2">
            {renderNodes(fileTree, 0)}
          </div>
          <div className="min-h-0 flex-1 overflow-auto border-t px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
            {selectedFile ? (
              <>
                <div className="mb-1.5 truncate font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{selectedFile.path}</div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">{selectedFile.content}</pre>
              </>
            ) : (
              <div className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>点击上方文件预览</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 净模式（Pure Mode）：ZCode 级纯对话体验。
 * 左侧会话列表（搜索/新建/切换/删除/重命名/相对时间）+ 中间会话窗口
 * （工具栏：打开文件夹/导出/压缩/停止）+ 右侧文件预览面板（可折叠）。
 * webview 承载层隐藏但保持存活，会话驱动与普通模式完全一致。
 */
export function PureModeShell(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const providers = useStore((s) => s.providers)
  const streamingText = useStore((s) => s.streamingText)
  const project = useProject(useStore())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [, setTick] = useState(0)

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query]
  )
  const running = streamingText.length > 0

  // 每分钟刷新一次，让「N 分前」等相对时间保持新鲜
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
    if (!pid) return
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

  const commitRename = async (): Promise<void> => {
    setRenaming(false)
    if (activeSession && renameText.trim()) {
      await api.renameSession(activeSession.id, renameText.trim())
      useStore.setState({ activeSession: { ...activeSession, title: renameText.trim() } })
      await useStore.getState().refreshSessions()
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      <DragStrip />
      <div className="flex min-h-0 flex-1">
      {/* webview 承载层：隐藏但保持存活 */}
      <div className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px overflow-hidden" aria-hidden>
        <WebTabs />
      </div>

      {/* 左侧会话列表 */}
      {sidebarOpen ? (
        <div className="anim-fade flex w-[272px] shrink-0 flex-col border-r" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
          <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
              {project?.name ?? project?.root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '未打开项目'}
            </span>
            <button
              title="在资源管理器中打开项目文件夹"
              className="rounded-lg px-2 py-1 text-[13px]"
              style={{ background: 'var(--bg-hover)' }}
              onClick={() => project && void api.openPathInSystem(project.root)}
            >
              <IconFolderOpen size={14} />
            </button>
            <button
              title="收起侧栏"
              className="rounded-lg px-2 py-1 text-[12px]"
              style={{ background: 'var(--bg-hover)' }}
              onClick={() => setSidebarOpen(false)}
            >
              <IconChevronLeft size={14} />
            </button>
          </div>

          {project && (
            <div className="flex items-center gap-1.5 px-3.5 pb-2">
              <select
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[11.5px]"
                style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">上次平台</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] font-medium"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                onClick={() => void newSession()}
              >
                <IconPlus size={12} />
                新会话
              </button>
            </div>
          )}

          <div className="relative px-3.5 pb-2">
            <span className="pointer-events-none absolute left-5.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
              <IconSearch size={12} />
            </span>
            <input
              className="w-full rounded-lg py-1.5 pl-7 pr-3 text-[12px] outline-none"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
              placeholder="搜索会话…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {filtered.map((s) => (
              <div
                key={s.id}
                className="sl group flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] transition-panel"
                style={{
                  background: activeSession?.id === s.id ? 'var(--bg-hover)' : 'transparent',
                  color: activeSession?.id === s.id ? 'var(--text)' : 'var(--text-dim)'
                }}
                onClick={() => void switchSession(s.id)}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.compactedTurns > 0 ? 'var(--accent)' : 'var(--border)' }} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>{relTime(s.updatedAt)}</span>
                <button
                  title="删除会话"
                  className="hidden shrink-0 text-[11px] group-hover:block"
                  style={{ color: 'var(--danger)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteSession(s.id)
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-4 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                {project ? '暂无会话' : '先打开项目'}
              </div>
            )}
          </div>

          <div className="border-t px-3.5 py-2.5" style={{ borderColor: 'var(--border)' }}>
            <button className="text-[11.5px]" style={{ color: 'var(--text-dim)' }} onClick={() => void useStore.getState().setPure(false)}>
              ← 退出净模式
            </button>
          </div>
        </div>
      ) : (
        <button
          title="展开侧栏"
          className="w-8 shrink-0 border-r text-[13px]"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)', color: 'var(--text-dim)' }}
          onClick={() => setSidebarOpen(true)}
        >
          <IconChevronRight size={14} />
        </button>
      )}

      {/* 会话窗口 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center gap-2 border-b px-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
          {renaming && activeSession ? (
            <input
              autoFocus
              className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[13px] outline-none"
              style={{ background: 'var(--bg-hover)' }}
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => e.key === 'Enter' && void commitRename()}
            />
          ) : (
            <span
              className="min-w-0 flex-1 cursor-text truncate text-[13px] font-medium"
              title="双击重命名"
              onDoubleClick={() => {
                if (activeSession) {
                  setRenameText(activeSession.title)
                  setRenaming(true)
                }
              }}
            >
              {activeSession?.title ?? '净模式 — 选择或新建会话'}
            </span>
          )}
          {running && (
            <span className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]" style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}>
              <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              运行中
            </span>
          )}
          {activeSession && (
            <>
              <button title="停止当前任务" className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: running ? 'var(--danger)' : 'var(--bg-hover)', color: running ? 'var(--on-accent)' : 'var(--text-dim)' }} onClick={() => void useStore.getState().stop('generate')}>
<IconStop size={12} /> 停止
              </button>
              <button title="压缩上下文" className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.compactSession(activeSession.id).then((s) => useStore.setState({ activeSession: s }))}>
<IconCompress size={12} /> 压缩
              </button>
              <button
                title="导出 Markdown"
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11.5px]"
                style={{ background: 'var(--bg-hover)' }}
                onClick={() => void api.exportSession(activeSession.id).then((p) => useStore.getState().notice(`已导出：${p}`))}
              >
<IconDownload size={12} /> 导出
              </button>
              {project && (
                <button title="在资源管理器中打开项目文件夹" className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.openPathInSystem(project.root)}>
<IconFolderOpen size={12} /> 文件夹
                </button>
              )}
            </>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <ChatPanel />
        </div>
      </div>

      {/* 右侧文件预览面板 */}
      {project && <PreviewPanel projectId={project.id} />}
      </div>
    </div>
  )
}
