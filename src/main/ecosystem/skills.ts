import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
  const raw = readFileSync(path, 'utf-8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw }
  const meta: SkillFrontmatter = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim())
    if (!kv) continue
    const [, key, value] = kv
    const v = value!.replace(/^["']|["']$/g, '').trim()
    if (key === 'name') meta.name = v
    if (key === 'description') meta.description = v
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

export function listSkills(projectRoot?: string): SkillMeta[] {
  const out: SkillMeta[] = []
  const scan = (base: string, scope: 'project' | 'user'): void => {
    const dir = join(base, 'skills')
    for (const f of listMarkdownFiles(dir)) {
      const path = join(dir, f)
      try {
        const { meta } = parseSkillFile(path)
        out.push({
          name: meta.name ?? basename(f, '.md'),
          description: meta.description ?? '',
          scope,
          path
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
  // 安全校验：只允许读取已登记的两个目录
  const allowed = [join(userDir(), 'skills'), projectRoot ? join(projectRoot, '.lidow', 'skills') : null].filter(Boolean) as string[]
  if (!allowed.some((dir) => path.startsWith(dir))) throw new Error('Skill 路径不在允许目录内')
  return readFileSync(path, 'utf-8')
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
