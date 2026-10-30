import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStore, type ViewId } from '../store'
import {
  RAIL_ICONS,
  IconDiff,
  IconFile,
  IconList,
  IconPlus,
  IconPure,
  IconSearch,
  IconTerminal,
  IconBulb
} from './icons'

type Cmd = {
  id: string
  group: '导航' | '动作'
  label: string
  desc?: string
  icon: (props: { size?: number; className?: string }) => React.JSX.Element
  kbd?: string
  run: () => void | Promise<void>
}

const NAV_ORDER: { id: ViewId; label: string }[] = [
  { id: 'home', label: '工作台' },
  { id: 'projects', label: '工作区' },
  { id: 'sessions', label: '会话' },
  { id: 'files', label: '文件' },
  { id: 'tasks', label: '任务' },
  { id: 'skills', label: '技能' },
  { id: 'agents', label: '子代理' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: '插件' },
  { id: 'quick', label: '快捷指令' },
  { id: 'memory', label: '记忆' },
  { id: 'knowledge', label: '知识库' },
  { id: 'audit', label: '审计' },
  { id: 'settings', label: '设置' }
]

async function newTask(): Promise<void> {
  const st = useStore.getState()
  const providerId = st.activeSession?.providerId || st.providers[0]?.id
  if (!providerId) {
    st.notice('请先在「工作台」选择一个平台', 'warn')
    return
  }
  st.setView('home')
  st.setPure(true)
  st.setPureView('home')
  await st.createSession(providerId)
  const created = useStore.getState().activeSession
  if (created) await useStore.getState().openProviderTab(created.providerId, created.id, created.accountId)
}

function toggleTheme(): void {
  const st = useStore.getState()
  const next = st.settings.theme === 'dark' ? 'light' : 'dark'
  void api.updateSettings({ theme: next }).then((settings) => {
    useStore.setState({ settings })
    useStore.getState().applyTheme(settings)
  })
}

/** Ctrl/Cmd K 命令面板：页面导航与常用动作，键盘可完全操作 */
export function CommandPalette(): React.JSX.Element | null {
  const pureMode = useStore((s) => s.pureMode)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => {
          if (!v) {
            setQuery('')
            setSel(0)
          }
          return !v
        })
      }
      if (e.key === 'Escape') setOpen(false)
    }
    const onOpen = (): void => {
      setQuery('')
      setSel(0)
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('lidow:command', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('lidow:command', onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const cmds = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = NAV_ORDER.map((n) => ({
      id: `nav-${n.id}`,
      group: '导航',
      label: n.label,
      icon: RAIL_ICONS[n.id as keyof typeof RAIL_ICONS],
      run: () => {
        const st = useStore.getState()
        if (st.pureMode) st.setPureView(n.id)
        else st.setView(n.id)
      }
    }))
    const actions: Cmd[] = [
      { id: 'new', group: '动作', label: '新建任务', desc: '创建会话并开始对话', icon: IconPlus, kbd: 'Ctrl N', run: newTask },
      { id: 'files', group: '动作', label: '打开文件面板', desc: '浏览项目文件', icon: IconFile, kbd: 'Ctrl Alt E', run: () => useStore.getState().openAux('files') },
      { id: 'tasks', group: '动作', label: '打开侧边任务', desc: '查看 todoWrite 同步的任务', icon: IconList, run: () => useStore.getState().openAux('tasks') },
      { id: 'terminal', group: '动作', label: '打开终端', desc: '在右侧运行命令', icon: IconTerminal, kbd: 'Ctrl `', run: () => useStore.getState().openAux('terminal') },
      { id: 'review', group: '动作', label: '打开审阅', desc: '查看文件 Diff', icon: IconDiff, kbd: 'Ctrl Shift G', run: () => useStore.getState().openAux('review') },
      {
        id: 'pure',
        group: '动作',
        label: pureMode ? '退出纯净模式' : '进入纯净模式',
        desc: '只保留对话与工具',
        icon: IconPure,
        run: () => useStore.getState().setPure(!useStore.getState().pureMode)
      },
      { id: 'theme', group: '动作', label: '切换主题', desc: '浅色 / 深色', icon: IconBulb, run: toggleTheme }
    ]
    return [...actions, ...nav]
  }, [pureMode])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cmds
    return cmds.filter((c) => `${c.label} ${c.group} ${c.desc ?? ''}`.toLowerCase().includes(q))
  }, [cmds, query])

  useEffect(() => {
    setSel(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])

  if (!open) return null

  const groups: Cmd['group'][] = ['动作', '导航']
  let flat = 0

  const execute = (cmd: Cmd | undefined): void => {
    if (!cmd) return
    setOpen(false)
    void cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((v) => (filtered.length ? (v + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((v) => (filtered.length ? (v - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(filtered[sel])
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center px-6 pt-[14vh]"
      style={{ background: 'rgba(9,12,18,.4)', backdropFilter: 'blur(2px)' }}
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-[620px] max-w-full overflow-hidden rounded-[var(--r-2xl)]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
      >
        <div className="flex h-[50px] items-center gap-2.5 border-b px-3.5" style={{ borderColor: 'var(--border-soft)' }}>
          <span style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={16} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、动作或技能"
            className="cmd-input min-w-0 flex-1 border-0 bg-transparent text-[14px] outline-none"
            style={{ color: 'var(--text)' }}
            aria-label="搜索命令"
          />
          <span className="rounded-[var(--r-sm)] border px-1.5 py-0.5 text-[10px]" style={{ borderColor: 'var(--border)', color: 'var(--text-hint)' }}>
            Esc
          </span>
        </div>

        <div ref={listRef} className="overflow-y-auto p-1.5" style={{ maxHeight: 'min(560px, calc(100vh - 220px))' }}>
          {groups.map((g) => {
            const items = filtered.filter((c) => c.group === g)
            if (items.length === 0) return null
            return (
              <div key={g}>
                <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold" style={{ color: 'var(--text-hint)' }}>
                  {g}
                </div>
                {items.map((c) => {
                  const idx = flat++
                  const Icon = c.icon
                  const active = idx === sel
                  return (
                    <button
                      key={c.id}
                      data-idx={idx}
                      className="flex h-9 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 text-left text-[12.5px] transition-colors duration-[90ms]"
                      style={{ background: active ? 'var(--bg-hover)' : 'transparent', color: active ? 'var(--text)' : 'var(--text-body)' }}
                      onMouseEnter={() => setSel(idx)}
                      onClick={() => execute(c)}
                    >
                      <span style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}>
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.desc && (
                        <span className="shrink-0 truncate text-[10.5px]" style={{ color: 'var(--text-hint)', maxWidth: 220 }}>
                          {c.desc}
                        </span>
                      )}
                      {c.kbd && (
                        <span className="shrink-0 rounded border px-1.5 py-0.5 text-[9.5px]" style={{ borderColor: 'var(--border)', color: 'var(--text-hint)' }}>
                          {c.kbd}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
              没有匹配的命令
            </div>
          )}
        </div>

        <div
          className="flex gap-3 border-t px-3 py-2 text-[10.5px]"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-2)', color: 'var(--text-hint)' }}
        >
          <span>↑ ↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
