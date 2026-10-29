import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentMeta, RuleEntry, SkillMeta } from '@shared/types'

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
    // 支持 YAML 块标量：description: >（折叠）/ description: |（保留换行）
    if ((key === 'name' || key === 'description') && (value === '>' || value === '|')) {
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
      value = value === '>' ? block.join(' ').trim() : block.join('\n').trim()
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
function listSkillEntries(dir: string): { path: string; fallback: string }[] {
  const out: { path: string; fallback: string }[] = []
  const visit = (current: string, depth: number): void => {
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
        if (ent.isFile() && ent.name.endsWith('.md') && depth === 0) {
          out.push({ path: full, fallback: basename(ent.name, '.md') })
          continue
        }
        if (!ent.isDirectory() || depth >= 2) continue
        const skillMd = join(full, 'SKILL.md')
        if (existsSync(skillMd) && statSync(skillMd).isFile()) {
          out.push({ path: skillMd, fallback: ent.name })
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

export function listSkills(projectRoot?: string): SkillMeta[] {
  const out: SkillMeta[] = []
  const seen = new Set<string>()
  const scan = (base: string, scope: 'project' | 'user'): void => {
    const dir = join(base, 'skills')
    for (const entry of listSkillEntries(dir)) {
      try {
        const { meta } = parseSkillFile(entry.path)
        const name = meta.name ?? entry.fallback
        // 同名技能项目级优先（scan 先项目后用户），避免摘要/斜杠菜单重复
        if (seen.has(name)) continue
        seen.add(name)
        out.push({
          name,
          description: meta.description ?? '',
          scope,
          path: entry.path
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
  const skills = listSkills(projectRoot)
  if (skills.length === 0) return ''
  return skills.map((s) => `- ${s.name}: ${s.description}（${s.scope}）`).join('\n')
}
