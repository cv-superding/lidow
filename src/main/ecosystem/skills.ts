import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentMeta,
  ExternalSkillImportResult,
  ExternalSkillMeta,
  RuleEntry,
  SkillDraft,
  SkillMeta,
  SkillTrashItem
} from '@shared/types'

/**
 * Skill / Agent / Rules 三级体系，对齐 Claude Code 机制：
 * - 项目级：{projectRoot}/.lidow/{skills,agents,rules}/
 * - 用户级：~/.lidow/{skills,agents,rules}/
 * - 渐进式披露：列表只含 name+description，正文按需 readSkill 读取
 */

interface SkillFrontmatter {
  name?: string
  description?: string
}

function userDir(): string {
  return join(homedir(), '.lidow')
}

function ensureDirs(base: string): void {
  for (const sub of ['skills', 'agents', 'rules']) {
    const dir = join(base, sub)
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* 只读盘等场景静默 */
      }
    }
  }
}

export function userLidowDir(): string {
  ensureDirs(userDir())
  return userDir()
}

export function projectLidowDir(projectRoot: string): string {
  ensureDirs(join(projectRoot, '.lidow'))
  return join(projectRoot, '.lidow')
}

/** 解析 SKILL.md：极简 frontmatter（name/description 两个键，避免 YAML 依赖）+ 正文 */
export function parseSkillFile(path: string): { meta: SkillFrontmatter; body: string } {
  // Windows 记事本保存的 UTF-8 会带 BOM，不剥掉的话 frontmatter 匹配不到
  const raw = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw }
  const meta: SkillFrontmatter = {}
  const lines = m[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(lines[i]!.trim())
    if (!kv) continue
    const key = kv[1]!
    let value = kv[2]!.trim()
    // 支持 YAML 块标量：> / | / >- / |- / >+ 等
    const blockScalar = /^([>|])([+-]?)(\d*)$/.exec(value)
    if ((key === 'name' || key === 'description') && blockScalar) {
      const block: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        if (next.trim() === '') {
          block.push('')
          i++
          continue
        }
        if (!/^\s+/.test(next)) break
        block.push(next.replace(/^\s+/, ''))
        i++
      }
      value = blockScalar[1] === '>' ? block.join(' ').trim() : block.join('\n').trim()
    }
    value = value.replace(/^["']|["']$/g, '').trim()
    if (key === 'name') meta.name = value
    if (key === 'description') meta.description = value
  }
  return { meta, body: raw.slice(m[0]!.length).trim() }
}

function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile())
  } catch {
    return []
  }
}

/**
 * Skill 文件发现：兼容两种布局
 * - skills/tdd/SKILL.md（标准目录技能，支持一层分类目录）
 * - skills/tdd.md（扁平旧格式）
 * 目录技能的 fallback 名称取目录名，不能取「SKILL」。
 */
function listSkillEntries(dir: string): { path: string; fallback: string; category?: string }[] {
  const out: { path: string; fallback: string; category?: string }[] = []
  const visited = new Set<string>()
  // 其他 Agent 常用软链接/junction 复用同一份技能；Dirent.isDirectory() 对链接返回 false，需要 stat 跟随
  const isDir = (full: string, ent: Dirent): boolean => {
    try {
      return ent.isDirectory() || (ent.isSymbolicLink() && statSync(full).isDirectory())
    } catch {
      return false
    }
  }
  const isFile = (full: string, ent: Dirent): boolean => {
    try {
      return ent.isFile() || (ent.isSymbolicLink() && statSync(full).isFile())
    } catch {
      return false
    }
  }
  const visit = (current: string, depth: number): void => {
    try {
      const real = realpathSync(current)
      if (visited.has(real)) return
      visited.add(real)
    } catch {
      /* realpath 失败时按原路径继续 */
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(current, ent.name)
      try {
        // 平铺 .md 只在 skills 根目录算技能；分类目录里的 README.md 等不算
        if (isFile(full, ent) && ent.name.endsWith('.md') && depth === 0) {
          out.push({ path: full, fallback: basename(ent.name, '.md') })
          continue
        }
        if (!isDir(full, ent) || depth >= 2) continue
        const skillMd = join(full, 'SKILL.md')
        if (existsSync(skillMd) && statSync(skillMd).isFile()) {
          const relParts = relative(dir, full).split(/[\\/]/).filter(Boolean)
          out.push({ path: skillMd, fallback: ent.name, category: relParts.length > 1 ? relParts[0] : undefined })
        } else {
          visit(full, depth + 1)
        }
      } catch {
        /* 单个条目不可读时跳过 */
      }
    }
  }
  visit(dir, 0)
  return out
}

/** 技能目录内的路径键：Windows 大小写不敏感 */
function skillPathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function configPath(base: string): string {
  return join(base, 'skills-config.json')
}

function readDisabled(base: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(configPath(base), 'utf-8')) as { disabled?: unknown }
    return new Set(Array.isArray(raw.disabled) ? raw.disabled.filter((p): p is string => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDisabled(base: string, disabled: Set<string>): void {
  const file = configPath(base)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ disabled: [...disabled].sort() }, null, 2), 'utf-8')
  renameSync(tmp, file)
}

function scopeBase(scope: 'project' | 'user', projectRoot?: string): string {
  if (scope === 'project') {
    if (!projectRoot) throw new Error('当前没有打开项目')
    return join(projectRoot, '.lidow')
  }
  return userLidowDir()
}

export function skillsDirForScope(scope: 'project' | 'user', projectRoot?: string): string {
  return join(scopeBase(scope, projectRoot), 'skills')
}

/** 文件名/分类名安全化：保留中英文，去掉路径分隔符和 Windows 非法字符 */
export function safeSkillSegment(input: string, fallback = 'skill'): string {
  const value = String(input ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\p{Cc}/gu, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return value || fallback
}

function formatSkillFile(input: SkillDraft): string {
  const oneLine = (s: string): string => String(s ?? '').replace(/\r?\n/g, ' ').trim()
  const name = oneLine(input.name)
  const description = oneLine(input.description)
  const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim()
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/** 校验技能文件位于项目/用户 skills 目录内；返回所属 base/scope */
function locateSkill(path: string, projectRoot?: string): { base: string; scope: 'project' | 'user'; skillsDir: string } {
  const target = resolve(path)
  const candidates: { base: string; scope: 'project' | 'user' }[] = []
  if (projectRoot) candidates.push({ base: join(projectRoot, '.lidow'), scope: 'project' })
  candidates.push({ base: userDir(), scope: 'user' })
  for (const candidate of candidates) {
    const skillsDir = join(candidate.base, 'skills')
    const rel = relative(resolve(skillsDir), target)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return { ...candidate, skillsDir }
    }
  }
  throw new Error('技能路径不在允许目录内')
}

export function listSkills(projectRoot?: string): SkillMeta[] {
  const out: SkillMeta[] = []
  const seen = new Set<string>()
  const scan = (base: string, scope: 'project' | 'user'): void => {
    const dir = join(base, 'skills')
    const disabled = readDisabled(base)
    for (const entry of listSkillEntries(dir)) {
      try {
        const { meta } = parseSkillFile(entry.path)
        const name = meta.name ?? entry.fallback
        // 同名技能项目级优先（scan 先项目后用户），避免摘要/斜杠菜单重复。
        // 但被禁用的项目技能不能让同名用户技能一起消失。
        if (seen.has(name)) continue
        const enabled = !disabled.has(skillPathKey(entry.path))
        if (enabled) seen.add(name)
        out.push({
          name,
          description: meta.description ?? '',
          scope,
          path: entry.path,
          category: entry.category,
          enabled
        })
      } catch {
        /* skip */
      }
    }
  }
  if (projectRoot && existsSync(join(projectRoot, '.lidow', 'skills'))) scan(join(projectRoot, '.lidow'), 'project')
  scan(userDir(), 'user')
  return out
}

interface ExternalSource {
  id: string
  label: string
  homeDirs: string[]
  projectDirs?: string[]
}

/** 常见 Agent/CLI 的 skills 目录；只读取、不修改对方文件 */
const EXTERNAL_SOURCES: ExternalSource[] = [
  { id: 'dsh', label: 'DSH', homeDirs: ['.dsh/skills'] },
  { id: 'agents', label: 'Shared Agent', homeDirs: ['.agents/skills'], projectDirs: ['.agents/skills'] },
  { id: 'claude', label: 'Claude Code', homeDirs: ['.claude/skills'], projectDirs: ['.claude/skills'] },
  { id: 'codex', label: 'Codex', homeDirs: ['.codex/skills'], projectDirs: ['.codex/skills'] },
  { id: 'gemini', label: 'Gemini', homeDirs: ['.gemini/skills'], projectDirs: ['.gemini/skills'] },
  { id: 'cursor', label: 'Cursor', homeDirs: ['.cursor/skills'], projectDirs: ['.cursor/skills'] },
  { id: 'copilot', label: 'Copilot', homeDirs: ['.copilot/skills'], projectDirs: ['.github/skills'] },
  { id: 'opencode', label: 'OpenCode', homeDirs: ['.config/opencode/skills'], projectDirs: ['.opencode/skills'] },
  {
    id: 'windsurf',
    label: 'Windsurf',
    homeDirs: ['.codeium/windsurf/skills', '.windsurf/skills'],
    projectDirs: ['.windsurf/skills']
  },
  { id: 'trae', label: 'Trae', homeDirs: ['.trae/skills'], projectDirs: ['.trae/skills'] },
  { id: 'trae-cn', label: 'Trae CN', homeDirs: ['.trae-cn/skills'], projectDirs: ['.trae-cn/skills'] },
  { id: 'qoder', label: 'Qoder', homeDirs: ['.qoder/skills'], projectDirs: ['.qoder/skills'] },
  { id: 'qoder-cn', label: 'Qoder CN CLI', homeDirs: ['.qoder-cn/skills'] },
  { id: 'lingma', label: 'Qoder CN', homeDirs: ['.lingma/skills'], projectDirs: ['.lingma/skills'] },
  { id: 'roo', label: 'Roo', homeDirs: ['.roo/skills'], projectDirs: ['.roo/skills'] }
]

interface ExternalRoot {
  dir: string
  sourceId: string
  source: string
}

function externalRoots(projectRoot?: string): ExternalRoot[] {
  const out: ExternalRoot[] = []
  for (const source of EXTERNAL_SOURCES) {
    for (const rel of source.homeDirs) out.push({ dir: join(homedir(), rel), sourceId: source.id, source: source.label })
    if (!projectRoot) continue
    for (const rel of source.projectDirs ?? []) {
      out.push({ dir: join(projectRoot, rel), sourceId: source.id, source: `${source.label} · 项目` })
    }
  }
  return out
}

export function listExternalSkills(projectRoot?: string): ExternalSkillMeta[] {
  const out: ExternalSkillMeta[] = []
  const seen = new Set<string>()
  for (const root of externalRoots(projectRoot)) {
    if (!existsSync(root.dir)) continue
    for (const entry of listSkillEntries(root.dir)) {
      const key = skillPathKey(entry.path)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const { meta } = parseSkillFile(entry.path)
        out.push({
          name: meta.name ?? entry.fallback,
          description: meta.description ?? '',
          source: root.source,
          sourceId: root.sourceId,
          path: entry.path,
          category: entry.category
        })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

/** 把其他 Agent 的技能复制进 Lidow；默认按来源建分类，不修改源目录 */
export function importExternalSkills(
  paths: string[],
  scope: 'project' | 'user',
  projectRoot?: string,
  category?: string
): ExternalSkillImportResult {
  const destRoot = skillsDirForScope(scope, projectRoot)
  mkdirSync(destRoot, { recursive: true })
  const roots = externalRoots(projectRoot)
  const result: ExternalSkillImportResult = { imported: [], skipped: [] }
  for (const rawPath of [...new Set(paths)]) {
    const target = resolve(rawPath)
    const root = roots.find((r) => {
      const rel = relative(resolve(r.dir), target)
      return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
    })
    if (!root) {
      result.skipped.push(`${rawPath}：不是已知 Agent 技能目录`)
      continue
    }
    const entry = listSkillEntries(root.dir).find((e) => resolve(e.path) === target)
    if (!entry) {
      result.skipped.push(`${rawPath}：技能文件不存在`)
      continue
    }
    const skillRoot = basename(entry.path).toLowerCase() === 'skill.md' ? dirname(entry.path) : entry.path
    if (!existsSync(skillRoot)) {
      result.skipped.push(`${rawPath}：技能目录不存在`)
      continue
    }
    try {
      const { meta } = parseSkillFile(entry.path)
      const categoryName = safeSkillSegment(category?.trim() || root.sourceId, 'imported')
      let slug = safeSkillSegment(meta.name || entry.fallback, 'skill')
      let dest = join(destRoot, categoryName, slug)
      for (let i = 2; existsSync(dest) && i < 100; i++) {
        slug = `${slug.replace(/-\d+$/, '')}-${i}`
        dest = join(destRoot, categoryName, slug)
      }
      const relDest = relative(resolve(destRoot), resolve(dest))
      if (!relDest || relDest.startsWith('..') || isAbsolute(relDest)) throw new Error('目标路径越界')
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(skillRoot, dest, { recursive: true, dereference: true })
      result.imported.push({
        name: meta.name || entry.fallback,
        path: basename(entry.path).toLowerCase() === 'skill.md' ? join(dest, 'SKILL.md') : dest
      })
    } catch (e) {
      result.skipped.push(`${metaFallback(rawPath)}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

function metaFallback(path: string): string {
  return basename(dirname(path)) || path
}

export function readSkill(path: string, projectRoot?: string): string {
  // 安全校验：只允许读取技能目录内的文件（用 relative 防 skills-evil 之类的前缀绕过）
  const target = resolve(path)
  const allowed = [join(userDir(), 'skills'), projectRoot ? join(projectRoot, '.lidow', 'skills') : null].filter(
    Boolean
  ) as string[]
  const ok = allowed.some((dir) => {
    const rel = relative(resolve(dir), target)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  })
  if (!ok) throw new Error('Skill 路径不在允许目录内')
  return readFileSync(target, 'utf-8')
}

export function createSkill(input: SkillDraft, projectRoot?: string): SkillMeta {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('技能名称不能为空')
  const category = input.category?.trim() ? safeSkillSegment(input.category, 'category') : ''
  const slug = safeSkillSegment(name, 'skill')
  const skillsDir = skillsDirForScope(input.scope, projectRoot)
  const targetDir = join(skillsDir, category, slug)
  const rel = relative(resolve(skillsDir), resolve(targetDir))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('技能路径越界')
  if (existsSync(targetDir)) throw new Error('同名技能目录已存在')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'SKILL.md'), formatSkillFile({ ...input, name }), 'utf-8')
  return {
    name,
    description: String(input.description ?? '').trim(),
    scope: input.scope,
    path: join(targetDir, 'SKILL.md'),
    category: category || undefined,
    enabled: true
  }
}

export function updateSkill(path: string, input: SkillDraft, projectRoot?: string): SkillMeta {
  const located = locateSkill(path, projectRoot)
  if (!existsSync(path)) throw new Error('技能文件不存在')
  if (!/\.md$/i.test(path)) throw new Error('只能编辑 Markdown 技能文件')
  writeFileSync(path, formatSkillFile(input), 'utf-8')
  const rel = relative(resolve(located.skillsDir), resolve(path)).split(/[\\/]/).filter(Boolean)
  const category = rel.length > 2 ? rel[0] : undefined
  return {
    name: String(input.name ?? '').trim(),
    description: String(input.description ?? '').trim(),
    scope: located.scope,
    path,
    category,
    enabled: true
  }
}

export function setSkillEnabled(path: string, enabled: boolean, projectRoot?: string): SkillMeta[] {
  const located = locateSkill(path, projectRoot)
  const disabled = readDisabled(located.base)
  const key = skillPathKey(path)
  if (enabled) disabled.delete(key)
  else disabled.add(key)
  writeDisabled(located.base, disabled)
  return listSkills(projectRoot)
}

interface TrashIndex {
  items: SkillTrashItem[]
}

function trashDirOf(base: string): string {
  return join(base, 'skill-trash')
}

function trashIndexPath(base: string): string {
  return join(trashDirOf(base), 'index.json')
}

function readTrashIndex(base: string): TrashIndex {
  try {
    const raw = JSON.parse(readFileSync(trashIndexPath(base), 'utf-8')) as TrashIndex
    return { items: Array.isArray(raw.items) ? raw.items : [] }
  } catch {
    return { items: [] }
  }
}

function writeTrashIndex(base: string, index: TrashIndex): void {
  const dir = trashDirOf(base)
  mkdirSync(dir, { recursive: true })
  const file = trashIndexPath(base)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** 软删除：移入 .lidow/skill-trash，保留原路径，可恢复 */
export function trashSkill(path: string, projectRoot?: string): SkillTrashItem {
  const located = locateSkill(path, projectRoot)
  const entry = listSkillEntries(located.skillsDir).find((e) => resolve(e.path) === resolve(path))
  if (!entry) throw new Error('技能文件不在技能列表中')
  const { meta } = parseSkillFile(entry.path)
  const skillRoot = basename(entry.path).toLowerCase() === 'skill.md' ? dirname(entry.path) : entry.path
  if (!existsSync(skillRoot)) throw new Error('技能文件不存在')
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const trashDir = join(trashDirOf(located.base), id)
  mkdirSync(trashDir, { recursive: true })
  const payload = join(trashDir, basename(skillRoot))
  try {
    renameSync(skillRoot, payload)
  } catch {
    cpSync(skillRoot, payload, { recursive: true })
    rmSync(skillRoot, { recursive: true, force: true })
  }
  const item: SkillTrashItem = {
    id,
    name: meta.name ?? entry.fallback,
    description: meta.description ?? '',
    scope: located.scope,
    path: skillRoot,
    trashPath: payload,
    category: entry.category,
    deletedAt: Date.now()
  }
  const index = readTrashIndex(located.base)
  writeTrashIndex(located.base, { items: [...index.items, item] })
  const disabled = readDisabled(located.base)
  if (disabled.delete(skillPathKey(entry.path))) writeDisabled(located.base, disabled)
  return item
}

export function listSkillTrash(projectRoot?: string): SkillTrashItem[] {
  const out: SkillTrashItem[] = []
  if (projectRoot) out.push(...readTrashIndex(join(projectRoot, '.lidow')).items.map((x) => ({ ...x, scope: 'project' as const })))
  out.push(...readTrashIndex(userDir()).items.map((x) => ({ ...x, scope: 'user' as const })))
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

function findTrashItem(id: string, projectRoot?: string): { base: string; item: SkillTrashItem } {
  const bases: string[] = []
  if (projectRoot) bases.push(join(projectRoot, '.lidow'))
  bases.push(userDir())
  for (const base of bases) {
    const item = readTrashIndex(base).items.find((x) => x.id === id)
    if (item) return { base, item }
  }
  throw new Error('回收站项目不存在')
}

export function restoreSkillTrash(id: string, projectRoot?: string): SkillTrashItem {
  const { base, item } = findTrashItem(id, projectRoot)
  if (!existsSync(item.trashPath)) throw new Error('回收站文件已丢失')
  if (existsSync(item.path)) throw new Error('原位置已有同名技能，请先处理')
  mkdirSync(dirname(item.path), { recursive: true })
  try {
    renameSync(item.trashPath, item.path)
  } catch {
    cpSync(item.trashPath, item.path, { recursive: true })
    rmSync(item.trashPath, { recursive: true, force: true })
  }
  const index = readTrashIndex(base)
  writeTrashIndex(base, { items: index.items.filter((x) => x.id !== id) })
  return item
}

export function purgeSkillTrash(id: string, projectRoot?: string): void {
  const { base, item } = findTrashItem(id, projectRoot)
  rmSync(item.trashPath, { recursive: true, force: true })
  const index = readTrashIndex(base)
  writeTrashIndex(base, { items: index.items.filter((x) => x.id !== id) })
}

export function listAgents(projectRoot?: string): AgentMeta[] {
  const out: AgentMeta[] = []
  const scan = (base: string, scope: 'project' | 'user'): void => {
    const dir = join(base, 'agents')
    for (const f of listMarkdownFiles(dir)) {
      try {
        const { meta, body } = parseSkillFile(join(dir, f))
        out.push({
          name: meta.name ?? basename(f, '.md'),
          description: meta.description ?? '',
          scope,
          path: join(dir, f),
          body
        })
      } catch {
        /* skip */
      }
    }
  }
  if (projectRoot && existsSync(join(projectRoot, '.lidow', 'agents'))) scan(join(projectRoot, '.lidow'), 'project')
  scan(userDir(), 'user')
  return out
}

export function listRules(projectRoot?: string): RuleEntry[] {
  const out: RuleEntry[] = []
  const scan = (base: string, scope: 'project' | 'user'): void => {
    const dir = join(base, 'rules')
    for (const f of listMarkdownFiles(dir)) {
      try {
        out.push({ name: basename(f, '.md'), scope, path: join(dir, f), content: readFileSync(join(dir, f), 'utf-8') })
      } catch {
        /* skip */
      }
    }
  }
  if (projectRoot && existsSync(join(projectRoot, '.lidow', 'rules'))) scan(join(projectRoot, '.lidow'), 'project')
  scan(userDir(), 'user')
  return out
}

/** 渐进式披露：列表段只给 name+description */
export function skillsDigest(projectRoot?: string): string {
  const skills = listSkills(projectRoot).filter((s) => s.enabled !== false)
  if (skills.length === 0) return ''
  return skills.map((s) => `- ${s.name}: ${s.description}（${s.scope}）`).join('\n')
}
