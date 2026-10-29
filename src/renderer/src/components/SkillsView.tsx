import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ExternalSkillImportResult,
  ExternalSkillMeta,
  GitHubSkillInstallResult,
  SkillDraft,
  SkillMeta,
  SkillTrashItem
} from '@shared/types'
import { useProject, useStore } from '../store'
import { api } from '../api'
import { Empty, Page } from './views'
import {
  IconBulb,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconEdit,
  IconEye,
  IconFolder,
  IconGlobe,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash
} from './icons'

type TabId = 'project' | 'user' | 'trash'

interface EditorState {
  mode: 'create' | 'edit'
  scope: 'project' | 'user'
  path?: string
  category: string
  name: string
  description: string
  body: string
}

interface InstallState {
  url: string
  scope: 'project' | 'user'
  category: string
  result?: GitHubSkillInstallResult
  error?: string
  busy: boolean
}

interface ImportState {
  skills: ExternalSkillMeta[]
  selected: Set<string>
  scope: 'project' | 'user'
  category: string
  result?: ExternalSkillImportResult
  error?: string
  busy: boolean
  loading: boolean
}

function splitSkillContent(raw: string, meta: SkillMeta): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { name: meta.name, description: meta.description, body: raw.trim() }
  let name = meta.name
  let description = meta.description
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/i.exec(line.trim())
    if (kv) {
      const value = kv[2]!.replace(/^['"]|['"]$/g, '').trim()
      if (/^[>|]([+-]?\d*)$/.test(value)) continue
      if (kv[1]!.toLowerCase() === 'name') name = value || name
      else description = value
    }
  }
  return { name, description, body: raw.slice(m[0].length).trim() }
}

function scopeLabel(scope: 'project' | 'user'): string {
  return scope === 'project' ? '项目' : '用户'
}

function relativeTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function Modal({
  children,
  wide = false,
  onClose
}: {
  children: React.ReactNode
  wide?: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[76] flex items-center justify-center px-6"
      style={{ background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`anim-pop flex max-h-[88vh] w-full flex-col overflow-hidden rounded-[18px] ${wide ? 'max-w-[860px]' : 'max-w-[600px]'}`}
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', boxShadow: '0 24px 64px rgba(0,0,0,.28)' }}
      >
        {children}
      </div>
    </div>
  )
}

export function SkillsView(): React.JSX.Element {
  const project = useProject(useStore())
  const projectId = project?.id ?? ''
  const [tab, setTab] = useState<TabId>('project')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [trash, setTrash] = useState<SkillTrashItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<{ skill: SkillMeta; content: string } | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [install, setInstall] = useState<InstallState | null>(null)
  const [importing, setImporting] = useState<ImportState | null>(null)
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set())

  const refresh = useCallback((): void => {
    setLoading(true)
    Promise.all([api.listSkills(), api.listSkillTrash()])
      .then(([nextSkills, nextTrash]) => {
        setSkills(nextSkills)
        setTrash(nextTrash)
      })
      .catch((e) => useStore.getState().notice(`加载技能失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, projectId])

  useEffect(() => {
    if (!project && tab === 'project') setTab('user')
  }, [project, tab])

  const projectSkills = useMemo(() => skills.filter((s) => s.scope === 'project'), [skills])
  const userSkills = useMemo(() => skills.filter((s) => s.scope === 'user'), [skills])
  const sourceSkills = tab === 'project' ? projectSkills : tab === 'user' ? userSkills : []
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sourceSkills
    return sourceSkills.filter((s) =>
      [s.name, s.description, s.category ?? '', s.path].join(' ').toLowerCase().includes(q)
    )
  }, [sourceSkills, query])
  const filteredTrash = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return trash
    return trash.filter((s) => [s.name, s.description, s.category ?? '', s.path].join(' ').toLowerCase().includes(q))
  }, [trash, query])

  const groups = useMemo(() => {
    const map = new Map<string, SkillMeta[]>()
    for (const s of filteredSkills) {
      const category = s.category?.trim() || '未分类'
      const list = map.get(category) ?? []
      list.push(s)
      map.set(category, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filteredSkills])

  const enabledCount = sourceSkills.filter((s) => s.enabled !== false).length

  const externalGroups = useMemo(() => {
    const map = new Map<string, ExternalSkillMeta[]>()
    for (const s of importing?.skills ?? []) {
      const list = map.get(s.source) ?? []
      list.push(s)
      map.set(s.source, list)
    }
    return [...map.entries()]
  }, [importing?.skills])

  const openDir = (): void => {
    const scope = tab === 'project' ? 'project' : 'user'
    void api
      .getSkillDir(scope)
      .then((dir) => api.revealPath(dir))
      .catch((e) => useStore.getState().notice(`打开目录失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  const openDetail = (skill: SkillMeta): void => {
    void api
      .readSkill(skill.path)
      .then((content) => setDetail({ skill, content }))
      .catch((e) => useStore.getState().notice(`读取技能失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  const startEdit = (skill: SkillMeta): void => {
    void api
      .readSkill(skill.path)
      .then((content) => {
        const parsed = splitSkillContent(content, skill)
        setDetail(null)
        setEditor({ mode: 'edit', scope: skill.scope, path: skill.path, category: skill.category ?? '', ...parsed })
      })
      .catch((e) => useStore.getState().notice(`读取技能失败：${e instanceof Error ? e.message : String(e)}`, 'error'))
  }

  const startCreate = (): void => {
    setEditor({
      mode: 'create',
      scope: tab === 'project' && project ? 'project' : 'user',
      category: '',
      name: '',
      description: '',
      body: '# 使用说明\n\n'
    })
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor || editorBusy) return
    if (!editor.name.trim()) {
      useStore.getState().notice('技能名称不能为空', 'warn')
      return
    }
    setEditorBusy(true)
    const draft: SkillDraft = {
      name: editor.name.trim(),
      description: editor.description.trim(),
      body: editor.body,
      scope: editor.scope,
      category: editor.category.trim() || undefined
    }
    try {
      if (editor.mode === 'create') await api.createSkill(draft)
      else if (editor.path) await api.updateSkill(editor.path, draft)
      setEditor(null)
      await refresh()
      useStore.getState().notice(editor.mode === 'create' ? '技能已创建' : '技能已保存')
    } catch (e) {
      useStore.getState().notice(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setEditorBusy(false)
    }
  }

  const toggleSkill = async (skill: SkillMeta): Promise<void> => {
    try {
      const next = await api.setSkillEnabled(skill.path, skill.enabled === false)
      setSkills(next)
      useStore.getState().notice(skill.enabled === false ? '技能已启用' : '技能已禁用')
    } catch (e) {
      useStore.getState().notice(`切换失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const moveToTrash = async (skill: SkillMeta): Promise<void> => {
    if (!window.confirm(`将技能「${skill.name}」移入回收站？`)) return
    try {
      await api.trashSkill(skill.path)
      setDetail(null)
      await refresh()
      useStore.getState().notice('已移入回收站')
    } catch (e) {
      useStore.getState().notice(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const restoreFromTrash = async (item: SkillTrashItem): Promise<void> => {
    try {
      await api.restoreSkillTrash(item.id)
      await refresh()
      useStore.getState().notice('技能已恢复')
    } catch (e) {
      useStore.getState().notice(`恢复失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const purgeFromTrash = async (item: SkillTrashItem): Promise<void> => {
    if (!window.confirm(`永久删除「${item.name}」？此操作不可恢复。`)) return
    try {
      await api.purgeSkillTrash(item.id)
      await refresh()
      useStore.getState().notice('已从回收站永久删除')
    } catch (e) {
      useStore.getState().notice(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const openInstall = (): void => {
    setInstall({ url: '', scope: project ? 'project' : 'user', category: '', busy: false })
  }

  const openImport = (): void => {
    setExpandedSources(new Set())
    setImporting({
      skills: [],
      selected: new Set(),
      scope: project ? 'project' : 'user',
      category: '',
      busy: false,
      loading: true
    })
    void api
      .listExternalSkills()
      .then((skills) =>
        setImporting((cur) => (cur ? { ...cur, skills, loading: false } : cur))
      )
      .catch((e) =>
        setImporting((cur) =>
          cur ? { ...cur, loading: false, error: e instanceof Error ? e.message : String(e) } : cur
        )
      )
  }

  const toggleImport = (path: string): void => {
    setImporting((cur) => {
      if (!cur) return cur
      const selected = new Set(cur.selected)
      if (selected.has(path)) selected.delete(path)
      else selected.add(path)
      return { ...cur, selected }
    })
  }

  const toggleSource = (source: string): void => {
    setExpandedSources((cur) => {
      const next = new Set(cur)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

  const toggleSourceSelection = (list: ExternalSkillMeta[]): void => {
    setImporting((cur) => {
      if (!cur) return cur
      const selected = new Set(cur.selected)
      const all = list.every((s) => selected.has(s.path))
      for (const s of list) {
        if (all) selected.delete(s.path)
        else selected.add(s.path)
      }
      return { ...cur, selected }
    })
  }

  const runImport = async (): Promise<void> => {
    if (!importing || importing.busy || importing.selected.size === 0) return
    setImporting({ ...importing, busy: true, error: undefined, result: undefined })
    try {
      const result = await api.importExternalSkills(
        [...importing.selected],
        importing.scope,
        importing.category.trim() || undefined
      )
      setImporting((cur) => (cur ? { ...cur, busy: false, result, selected: new Set() } : cur))
      await refresh()
      useStore.getState().notice(
        result.imported.length > 0 ? `已导入 ${result.imported.length} 个技能` : '没有导入新技能',
        result.imported.length > 0 ? 'info' : 'warn'
      )
    } catch (e) {
      setImporting((cur) =>
        cur ? { ...cur, busy: false, error: e instanceof Error ? e.message : String(e) } : cur
      )
    }
  }

  const runInstall = async (): Promise<void> => {
    if (!install || install.busy) return
    if (!install.url.trim()) {
      setInstall({ ...install, error: '请输入 GitHub 仓库地址' })
      return
    }
    setInstall({ ...install, busy: true, error: undefined, result: undefined })
    try {
      const result = await api.installSkillsFromGitHub(
        install.url.trim(),
        install.scope,
        install.category.trim() || undefined
      )
      setInstall((cur) => (cur ? { ...cur, busy: false, result } : cur))
      await refresh()
      useStore.getState().notice(
        result.installed.length > 0 ? `已安装 ${result.installed.length} 个技能` : '没有安装新技能',
        result.installed.length > 0 ? 'info' : 'warn'
      )
    } catch (e) {
      setInstall((cur) =>
        cur ? { ...cur, busy: false, error: e instanceof Error ? e.message : String(e) } : cur
      )
    }
  }

  const tabButton = (id: TabId, label: string, count: number): React.JSX.Element => (
    <button
      key={id}
      className="rounded-[var(--r-sm)] px-3 py-1.5 text-[12px] font-medium transition-colors duration-[110ms]"
      style={{
        background: tab === id ? 'var(--surface)' : 'transparent',
        color: tab === id ? 'var(--text)' : 'var(--text-dim)',
        boxShadow: tab === id ? 'var(--shadow-sm)' : 'none'
      }}
      onClick={() => setTab(id)}
    >
      {label} <span className="tabular-nums" style={{ color: tab === id ? 'var(--accent)' : 'var(--text-hint)' }}>{count}</span>
    </button>
  )

  return (
    <Page
      title="技能"
      subtitle={`项目 ${projectSkills.length} · 用户 ${userSkills.length} · 回收站 ${trash.length}${project ? ` · ${project.name}` : ''}`}
      actions={
        <>
          <button className="btn btn-sm btn-outline" onClick={startCreate}>
            <IconPlus size={12} /> 新建技能
          </button>
          <button className="btn btn-sm btn-primary" onClick={openInstall}>
            <IconGlobe size={12} /> 从 GitHub 安装
          </button>
          <button className="btn btn-sm btn-outline" onClick={openImport}>
            <IconDownload size={12} /> 导入现有技能
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="打开技能目录" onClick={openDir}>
            <IconFolder size={13} />
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" title="刷新" onClick={() => void refresh()}>
            <IconRefresh size={13} />
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="flex w-fit items-center gap-1 rounded-[var(--r-md)] p-1" style={{ background: 'var(--surface-sunken)' }}>
          {tabButton('project', '项目技能', projectSkills.length)}
          {tabButton('user', '用户技能', userSkills.length)}
          {tabButton('trash', '回收站', trash.length)}
        </div>
        <div className="relative min-w-[200px] max-w-[360px] flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-hint)' }}>
            <IconSearch size={13} />
          </span>
          <input
            className="field h-9 pl-8 text-[12px]"
            placeholder={tab === 'trash' ? '搜索回收站…' : '搜索名称、描述、分类或路径…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {tab !== 'trash' && (
          <span className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
            {enabledCount} / {sourceSkills.length} 已启用 · 关闭后不进入 AI 摘要和斜杠菜单
          </span>
        )}
        {loading && <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />}
      </div>

      {tab === 'project' && !project ? (
        <Empty icon={<IconFolder size={18} />} title="先打开项目" hint="项目技能放在 <项目>/.lidow/skills 下；也可以管理用户级技能。" />
      ) : tab === 'trash' ? (
        filteredTrash.length === 0 ? (
          <Empty icon={<IconTrash size={18} />} title="回收站为空" hint="删除的技能会先移到回收站，确认后再永久清理。" />
        ) : (
          <div className="space-y-1.5">
            {filteredTrash.map((item) => (
              <div key={item.id} className="card flex flex-wrap items-start gap-3 px-4 py-3">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--text-dim)' }}
                >
                  <IconTrash size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] font-medium">{item.name}</span>
                    <span className="badge">{scopeLabel(item.scope)}</span>
                    {item.category && <span className="badge">{item.category}</span>}
                    <span className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                      删除于 {relativeTime(item.deletedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                    {item.description || '（无描述）'}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                    {item.path}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button className="btn btn-sm btn-outline" onClick={() => void restoreFromTrash(item)}>
                    恢复
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => void purgeFromTrash(item)}
                  >
                    永久删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : filteredSkills.length === 0 ? (
        <Empty
          icon={<IconBulb size={18} />}
          title={sourceSkills.length === 0 ? '还没有技能' : '没有匹配的技能'}
          hint={
            sourceSkills.length === 0
              ? '技能是带 name + description + 正文的 SKILL.md。可以新建，或从 GitHub 仓库一键安装。'
              : '换个关键词试试。'
          }
          action={
            sourceSkills.length === 0 ? (
              <button className="btn btn-sm btn-primary" onClick={startCreate}>
                <IconPlus size={12} /> 创建第一个技能
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {groups.map(([category, list]) => (
            <section key={category}>
              <div className="mb-1.5 flex items-center gap-2 px-0.5">
                <IconFolder size={12} className="opacity-40" />
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-dim)' }}>{category}</span>
                <span className="badge">{list.length}</span>
              </div>
              <div className="space-y-1.5">
                {list.map((skill) => {
                  const enabled = skill.enabled !== false
                  return (
                    <div
                      key={skill.path}
                      className="card flex items-start gap-3 px-4 py-3 transition-colors duration-[120ms]"
                      style={{ opacity: enabled ? 1 : 0.62 }}
                    >
                      <span
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)]"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        <IconBulb size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            className="truncate text-left text-[12.5px] font-medium hover:underline"
                            onClick={() => openDetail(skill)}
                          >
                            {skill.name}
                          </button>
                          <span className="badge">{scopeLabel(skill.scope)}</span>
                          {skill.category && <span className="badge">{skill.category}</span>}
                          {!enabled && <span className="badge">已禁用</span>}
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                          {skill.description || '（无描述）'}
                        </div>
                        <div className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                          {skill.path}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          role="switch"
                          aria-checked={enabled}
                          aria-label={enabled ? '禁用技能' : '启用技能'}
                          className="relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-[130ms]"
                          style={{ background: enabled ? 'var(--accent)' : 'var(--border-strong)' }}
                          onClick={() => void toggleSkill(skill)}
                          title={enabled ? '禁用（不进入 AI 摘要）' : '启用'}
                        >
                          <span
                            className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-[130ms]"
                            style={{ left: enabled ? 16 : 2 }}
                          />
                        </button>
                        <button className="btn btn-sm btn-ghost btn-icon" title="查看详情" onClick={() => openDetail(skill)}>
                          <IconEye size={13} />
                        </button>
                        <button className="btn btn-sm btn-ghost btn-icon" title="编辑" onClick={() => startEdit(skill)}>
                          <IconEdit size={13} />
                        </button>
                        <button
                          className="btn btn-sm btn-ghost btn-icon"
                          title="移入回收站"
                          style={{ color: 'var(--text-hint)' }}
                          onClick={() => void moveToTrash(skill)}
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {detail && (
        <Modal wide onClose={() => setDetail(null)}>
          <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <IconBulb size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[14px] font-semibold">{detail.skill.name}</span>
                <span className="badge">{scopeLabel(detail.skill.scope)}</span>
                {detail.skill.category && <span className="badge">{detail.skill.category}</span>}
              </div>
              <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                {detail.skill.description || '（无描述）'}
              </div>
              <div className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                {detail.skill.path}
              </div>
            </div>
            <button className="btn btn-sm btn-ghost btn-icon" title="关闭" onClick={() => setDetail(null)}>
              <IconClose size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4" style={{ background: 'var(--surface-sunken)' }}>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.7]" style={{ color: 'var(--text-body)' }}>
              {detail.content}
            </pre>
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(detail.content).then(
                  () => useStore.getState().notice('技能正文已复制'),
                  () => useStore.getState().notice('复制失败', 'warn')
                )
              }}
            >
              <IconCopy size={12} /> 复制正文
            </button>
            <button className="btn btn-sm btn-outline" onClick={() => startEdit(detail.skill)}>
              <IconEdit size={12} /> 编辑
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => void moveToTrash(detail.skill)}>
              <IconTrash size={12} /> 回收
            </button>
          </div>
        </Modal>
      )}

      {editor && (
        <Modal onClose={() => !editorBusy && setEditor(null)}>
          <div className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <IconEdit size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{editor.mode === 'create' ? '新建技能' : '编辑技能'}</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                {editor.mode === 'create' ? '保存到项目或用户 .lidow/skills' : editor.path}
              </div>
            </div>
            <button className="btn btn-sm btn-ghost btn-icon" title="关闭" disabled={editorBusy} onClick={() => setEditor(null)}>
              <IconClose size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>名称</span>
                <input
                  className="field h-9"
                  placeholder="例如 api-review"
                  value={editor.name}
                  autoFocus
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>分类（可选）</span>
                <input
                  className="field h-9 disabled:opacity-60"
                  placeholder="例如 写作 / engineering"
                  value={editor.category}
                  disabled={editor.mode === 'edit'}
                  onChange={(e) => setEditor({ ...editor, category: e.target.value })}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>保存位置</span>
                <select
                  className="field h-9"
                  value={editor.scope}
                  disabled={editor.mode === 'edit'}
                  onChange={(e) => setEditor({ ...editor, scope: e.target.value as 'project' | 'user' })}
                >
                  <option value="project" disabled={!project}>项目 .lidow/skills</option>
                  <option value="user">用户 ~/.lidow/skills</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>描述</span>
                <input
                  className="field h-9"
                  placeholder="一句话说明什么时候使用"
                  value={editor.description}
                  onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>正文（Markdown）</span>
              <textarea
                className="field min-h-[220px] resize-y py-2 font-mono text-[11.5px] leading-[1.65]"
                value={editor.body}
                onChange={(e) => setEditor({ ...editor, body: e.target.value })}
              />
            </label>
            {editor.mode === 'edit' && (
              <div className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                保存会重写 name/description frontmatter，正文中可保留其余 Markdown。
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}>
            <button className="btn btn-sm btn-ghost" disabled={editorBusy} onClick={() => setEditor(null)}>取消</button>
            <button className="btn btn-sm btn-primary" disabled={editorBusy} onClick={() => void saveEditor()}>
              {editorBusy ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}

      {importing && (
        <Modal onClose={() => !importing.busy && setImporting(null)}>
          <div className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <IconDownload size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">导入现有 Agent 技能</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                从 Claude Code / Codex / Qoder / Cursor 等目录复制到 Lidow，不改动原文件
              </div>
            </div>
            <button className="btn btn-sm btn-ghost btn-icon" title="关闭" disabled={importing.busy} onClick={() => setImporting(null)}>
              <IconClose size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>导入到</span>
                <select
                  className="field h-9"
                  value={importing.scope}
                  onChange={(e) => setImporting({ ...importing, scope: e.target.value as 'project' | 'user' })}
                >
                  <option value="project" disabled={!project}>项目技能</option>
                  <option value="user">用户技能</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>分类（可选）</span>
                <input
                  className="field h-9"
                  placeholder="留空则按来源分类"
                  value={importing.category}
                  onChange={(e) => setImporting({ ...importing, category: e.target.value })}
                />
              </label>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
                {importing.loading
                  ? '正在扫描其他 Agent…'
                  : `检测到 ${importing.skills.length} 个技能${
                      externalGroups.length > 1 ? ` · 来自 ${externalGroups.length} 个 Agent` : ''
                    }`}
              </span>
              {importing.skills.length > 0 && (
                <button
                  className="text-[11px] hover:underline"
                  style={{ color: 'var(--accent)' }}
                  onClick={() =>
                    setExpandedSources(
                      expandedSources.size === externalGroups.length
                        ? new Set()
                        : new Set(externalGroups.map(([source]) => source))
                    )
                  }
                >
                  {expandedSources.size === externalGroups.length ? '全部收起' : '全部展开'}
                </button>
              )}
            </div>
            {importing.error && (
              <div className="rounded-[var(--r-md)] px-3 py-2 text-[11.5px]" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
                {importing.error}
              </div>
            )}
            {!importing.loading && importing.skills.length === 0 && (
              <div className="rounded-[var(--r-lg)] border border-dashed px-4 py-6 text-center text-[11.5px] leading-relaxed" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-hint)' }}>
                没有在常见的其他 Agent 目录里找到技能。支持 Claude Code、Codex、Gemini、Cursor、Copilot、Windsurf、Trae、Qoder、Roo 等。
              </div>
            )}
            {importing.result && (
              <div className="rounded-[var(--r-md)] px-3 py-2 text-[11.5px]" style={{ background: 'var(--surface-sunken)', color: 'var(--text-dim)' }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: 'var(--success)' }}><IconCheck size={13} /></span>
                  已导入 {importing.result.imported.length} 个技能
                </div>
                {importing.result.imported.map((x) => (
                  <div key={x.path} className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                    {x.name} · {x.path}
                  </div>
                ))}
                {importing.result.skipped.length > 0 && (
                  <div className="mt-1.5 leading-relaxed" style={{ color: 'var(--warning)' }}>
                    跳过：{importing.result.skipped.join('；')}
                  </div>
                )}
              </div>
            )}
            {externalGroups.map(([source, list]) => {
              const expanded = expandedSources.has(source)
              const selectedCount = list.filter((s) => importing.selected.has(s.path)).length
              const allSelected = selectedCount === list.length
              return (
              <section key={source}>
                <div
                  className="mb-1 flex items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-[11px] font-medium"
                  style={{ color: 'var(--text-dim)' }}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleSource(source)}
                  >
                    {expanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                    <IconFolder size={11} className="opacity-50" />
                    <span className="truncate">{source}</span>
                    <span className="badge">
                      {selectedCount > 0 ? `${selectedCount}/${list.length}` : list.length}
                    </span>
                  </button>
                  <button
                    className="shrink-0 text-[10.5px] hover:underline"
                    style={{ color: 'var(--accent)' }}
                    onClick={() => toggleSourceSelection(list)}
                  >
                    {allSelected ? '取消选择' : '全选'}
                  </button>
                </div>
                {expanded && (
                <div className="space-y-1">
                  {list.map((skill) => {
                    const selected = importing.selected.has(skill.path)
                    return (
                      <button
                        key={skill.path}
                        role="checkbox"
                        aria-checked={selected}
                        className="flex w-full items-start gap-2.5 rounded-[var(--r-md)] border px-2.5 py-2 text-left transition-colors duration-[110ms]"
                        style={{
                          borderColor: selected ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border-soft)',
                          background: selected ? 'var(--accent-soft)' : 'var(--surface)'
                        }}
                        onClick={() => toggleImport(skill.path)}
                      >
                        <span
                          className="mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border"
                          style={{
                            borderColor: selected ? 'var(--accent)' : 'var(--border-strong)',
                            background: selected ? 'var(--accent)' : 'transparent',
                            color: 'var(--on-accent)'
                          }}
                        >
                          {selected && <IconCheck size={10} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[12px] font-medium">{skill.name}</span>
                            {skill.category && <span className="badge">{skill.category}</span>}
                          </span>
                          <span className="mt-0.5 block line-clamp-2 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                            {skill.description || '（无描述）'}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[10px]" style={{ color: 'var(--text-hint)' }}>
                            {skill.path}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                )}
              </section>
              )
            })}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}>
            <button className="btn btn-sm btn-ghost" disabled={importing.busy} onClick={() => setImporting(null)}>关闭</button>
            <button
              className="btn btn-sm btn-primary"
              disabled={importing.busy || importing.loading || importing.selected.size === 0}
              onClick={() => void runImport()}
            >
              {importing.busy ? '导入中…' : `导入 ${importing.selected.size} 个`}
            </button>
          </div>
        </Modal>
      )}

      {install && (
        <Modal onClose={() => !install.busy && setInstall(null)}>
          <div className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <IconGlobe size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">从 GitHub 安装技能</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                支持仓库根地址，或 /tree/&lt;branch&gt;/&lt;目录&gt; 地址；自动寻找 SKILL.md
              </div>
            </div>
            <button className="btn btn-sm btn-ghost btn-icon" title="关闭" disabled={install.busy} onClick={() => setInstall(null)}>
              <IconClose size={12} />
            </button>
          </div>
          <div className="space-y-3 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>GitHub 仓库地址</span>
              <input
                className="field h-9 font-mono text-[11.5px]"
                placeholder="https://github.com/Leonxlnx/taste-skill"
                value={install.url}
                autoFocus
                onChange={(e) => setInstall({ ...install, url: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>安装到</span>
                <select
                  className="field h-9"
                  value={install.scope}
                  onChange={(e) => setInstall({ ...install, scope: e.target.value as 'project' | 'user' })}
                >
                  <option value="project" disabled={!project}>项目技能</option>
                  <option value="user">用户技能</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>分类（可选）</span>
                <input
                  className="field h-9"
                  placeholder="默认使用仓库名"
                  value={install.category}
                  onChange={(e) => setInstall({ ...install, category: e.target.value })}
                />
              </label>
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
              仓库里的其他脚本/资源会一起复制；同名目录会自动加后缀，不会覆盖已有技能。
            </div>
            {install.error && (
              <div className="rounded-[var(--r-md)] px-3 py-2 text-[11.5px] leading-relaxed" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
                {install.error}
              </div>
            )}
            {install.result && (
              <div className="rounded-[var(--r-md)] px-3 py-2 text-[11.5px]" style={{ background: 'var(--surface-sunken)', color: 'var(--text-dim)' }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: 'var(--success)' }}><IconCheck size={13} /></span>
                  已从 {install.result.repo} 安装 {install.result.installed.length} 个技能
                </div>
                {install.result.installed.map((x) => (
                  <div key={x.path} className="mt-1 truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                    {x.name} · {x.path}
                  </div>
                ))}
                {install.result.skipped.length > 0 && (
                  <div className="mt-1.5 leading-relaxed" style={{ color: 'var(--warning)' }}>
                    跳过：{install.result.skipped.join('；')}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}>
            <button className="btn btn-sm btn-ghost" disabled={install.busy} onClick={() => setInstall(null)}>关闭</button>
            <button className="btn btn-sm btn-primary" disabled={install.busy || !install.url.trim()} onClick={() => void runInstall()}>
              {install.busy ? '安装中…' : '安装'}
            </button>
          </div>
        </Modal>
      )}
    </Page>
  )
}
