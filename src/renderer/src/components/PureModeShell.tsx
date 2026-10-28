import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { ChatPanel } from './ChatPanel'
import { WebTabs } from './WebTabs'

/**
 * 净模式（Pure Mode）：ZCode 级纯对话体验。
 * 左侧会话列表（搜索/新建/切换/删除/重命名）+ 会话窗口工具栏（打开文件夹/导出/压缩/停止），
 * webview 承载层隐藏但保持存活，会话驱动与普通模式完全一致。
 */
export function PureModeShell(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const providers = useStore((s) => s.providers)
  const streamingText = useStore((s) => s.streamingText)
  // 响应式解析当前项目（净模式中切换项目时标题与打开目录同步更新）
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0] ?? null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query]
  )
  const running = streamingText.length > 0

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
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* webview 承载层：隐藏但保持存活 */}
      <div className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px overflow-hidden" aria-hidden>
        <WebTabs />
      </div>

      {/* 左侧会话列表 */}
      {sidebarOpen ? (
        <div className="anim-fade flex w-[264px] shrink-0 flex-col border-r" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
          <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{project?.name ?? '未打开项目'}</span>
            <button
              title="在资源管理器中打开项目文件夹"
              className="rounded-lg px-2 py-1 text-[13px]"
              style={{ background: 'var(--bg-hover)' }}
              onClick={() => project && void api.openPathInSystem(project.root)}
            >
              📁
            </button>
            <button
              title="收起侧栏"
              className="rounded-lg px-2 py-1 text-[12px]"
              style={{ background: 'var(--bg-hover)' }}
              onClick={() => setSidebarOpen(false)}
            >
              «
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
              <button className="rounded-lg px-2.5 py-1.5 text-[12px] text-white" style={{ background: 'var(--accent)' }} onClick={() => void newSession()}>
                + 新会话
              </button>
            </div>
          )}

          <div className="px-3.5 pb-2">
            <input
              className="w-full rounded-xl px-3 py-1.5 text-[12px] outline-none"
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
                className="group flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] transition-panel"
                style={{
                  background: activeSession?.id === s.id ? 'var(--bg-hover)' : 'transparent',
                  color: activeSession?.id === s.id ? 'var(--text)' : 'var(--text-dim)'
                }}
                onClick={() => void switchSession(s.id)}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.compactedTurns > 0 ? 'var(--accent)' : 'var(--border)' }} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <button
                  title="删除会话"
                  className="hidden shrink-0 text-[11px] group-hover:block"
                  style={{ color: '#e06c6c' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteSession(s.id)
                  }}
                >
                  ✕
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
          »
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
              <button title="停止当前任务" className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: running ? '#c04c4c' : 'var(--bg-hover)', color: running ? '#fff' : 'var(--text-dim)' }} onClick={() => void useStore.getState().stop('generate')}>
                停止
              </button>
              <button title="压缩上下文" className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.compactSession(activeSession.id).then((s) => useStore.setState({ activeSession: s }))}>
                压缩
              </button>
              <button
                title="导出 Markdown"
                className="rounded-lg px-2.5 py-1 text-[11.5px]"
                style={{ background: 'var(--bg-hover)' }}
                onClick={() => void api.exportSession(activeSession.id).then((p) => useStore.getState().notice(`已导出：${p}`))}
              >
                导出
              </button>
              {project && (
                <button title="在资源管理器中打开项目文件夹" className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.openPathInSystem(project.root)}>
                  📁 文件夹
                </button>
              )}
            </>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <ChatPanel />
        </div>
      </div>
    </div>
  )
}
