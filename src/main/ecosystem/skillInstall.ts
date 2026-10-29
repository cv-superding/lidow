import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GitHubSkillInstallResult } from '@shared/types'
import { parseSkillFile, safeSkillSegment, skillsDirForScope } from './skills'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const UA = 'Lidow-Skills-Installer'
const MAX_FILES = 200
const MAX_BYTES = 8 * 1024 * 1024

export interface GitHubRepoRef {
  owner: string
  repo: string
  ref?: string
  subdir?: string
}

/** 解析 GitHub 仓库 URL，支持 /tree/<branch>/<subdir> */
export function parseGitHubRepoUrl(input: string): GitHubRepoRef {
  // 用户/模型常把 URL 包在 {}、<>、[] 或中文标点里
  const raw = String(input ?? '')
    .trim()
    .replace(/^[\s{<[(【]+|[\s}>)\]】,，。；;!！?？]+$/g, '')
  if (!raw) throw new Error('请输入 GitHub 仓库地址')
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://github.com/${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('无效的 GitHub 地址')
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) throw new Error('只支持 github.com 仓库地址')
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
  if (parts.length < 2) throw new Error('地址里缺少仓库名')
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/i, '')
  if (!owner || !repo) throw new Error('地址里缺少仓库名')
  let ref: string | undefined
  let subdir: string | undefined
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    ref = parts[3]
    subdir = parts.slice(4).join('/') || undefined
  } else if (parts.length > 2) {
    throw new Error('只支持仓库根地址或 /tree/<branch>/<目录> 地址')
  }
  return { owner, repo, ref, subdir }
}

/**
 * 从 git tree 路径中挑出技能根目录（含 SKILL.md 的目录）。
 * 返回相对路径；仓库根技能返回空串。
 */
export function selectSkillRoots(paths: string[], subdir?: string): string[] {
  const base = String(subdir ?? '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\\/g, '/')
  const roots = new Set<string>()
  for (const p of paths) {
    const normalized = p.replace(/\\/g, '/')
    const rel = base ? (normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : '') : normalized
    if (!rel) continue
    if (!/(^|\/)SKILL\.md$/i.test(rel)) continue
    roots.add(rel.replace(/\/?SKILL\.md$/i, ''))
  }
  return [...roots]
}

function ignoredFile(path: string): boolean {
  return /(^|\/)(\.git|\.github|node_modules|dist)(\/|$)/i.test(path) || /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(path)
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    let message = `GitHub ${res.status}`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = `${message}: ${body.message}`
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

interface TreeEntry {
  path?: string
  type?: string
  size?: number
  sha?: string
}

export async function installSkillsFromGitHub(
  input: { url: string; scope: 'project' | 'user'; category?: string },
  projectRoot?: string
): Promise<GitHubSkillInstallResult> {
  const repoRef = parseGitHubRepoUrl(input.url)
  const repoInfo = await githubJson<{ default_branch?: string }>(`${API}/repos/${repoRef.owner}/${repoRef.repo}`)
  const ref = repoRef.ref || repoInfo.default_branch
  if (!ref) throw new Error('无法确定仓库默认分支')
  const tree = await githubJson<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `${API}/repos/${repoRef.owner}/${repoRef.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  )
  if (tree.truncated) throw new Error('仓库文件过多，已拒绝不完整下载')
  const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob' && typeof e.path === 'string')
  const paths = blobs.map((e) => e.path!)
  const roots = selectSkillRoots(paths, repoRef.subdir)
  if (roots.length === 0) throw new Error('仓库里没有找到 SKILL.md，无法安装技能')

  const skillsDir = skillsDirForScope(input.scope, projectRoot)
  mkdirSync(skillsDir, { recursive: true })
  const category = safeSkillSegment(input.category?.trim() || repoRef.repo, 'github')
  const subdirPrefix = repoRef.subdir
    ? `${repoRef.subdir.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/')}/`
    : ''
  const result: GitHubSkillInstallResult = { repo: `${repoRef.owner}/${repoRef.repo}`, installed: [], skipped: [] }

  for (const root of roots.slice(0, 20)) {
    const skillPrefix = subdirPrefix + (root ? `${root}/` : '')
    const files = blobs.filter((e) => {
      const p = e.path!
      return (!skillPrefix || p.startsWith(skillPrefix)) && !ignoredFile(p.slice(skillPrefix.length))
    })
    const total = files.reduce((n, e) => n + (e.size ?? 0), 0)
    if (files.length === 0 || files.length > MAX_FILES || total > MAX_BYTES) {
      result.skipped.push(root || '(仓库根目录)')
      continue
    }
    let slug = safeSkillSegment(root ? basename(root) : repoRef.repo, 'skill')
    let target = join(skillsDir, category, slug)
    for (let i = 2; existsSync(target) && i < 100; i++) {
      slug = `${slug.replace(/-\d+$/, '')}-${i}`
      target = join(skillsDir, category, slug)
    }
    if (existsSync(target)) {
      result.skipped.push(root || '(仓库根目录)')
      continue
    }
    const targetRel = relative(resolve(skillsDir), resolve(target))
    if (!targetRel || targetRel.startsWith('..') || isAbsolute(targetRel)) {
      result.skipped.push(root || '(仓库根目录)')
      continue
    }
    try {
      for (const file of files) {
        const path = file.path!
        const rel = path.slice(skillPrefix.length)
        const dest = join(target, rel)
        const destRel = relative(resolve(target), resolve(dest))
        if (!destRel || destRel.startsWith('..') || isAbsolute(destRel)) throw new Error('文件路径越界')
        const rawUrl = `${RAW}/${repoRef.owner}/${repoRef.repo}/${encodeURIComponent(ref)}/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
        // 优先走 GitHub API 的 blob raw：部分地区 raw.githubusercontent.com 不可达，
        // 但 api.github.com 可用（下载每个文件会消耗一次 API 配额）。
        const downloadUrl = file.sha
          ? `${API}/repos/${repoRef.owner}/${repoRef.repo}/git/blobs/${file.sha}`
          : rawUrl
        const res = await fetch(downloadUrl, {
          headers: {
            Accept: file.sha ? 'application/vnd.github.raw' : '*/*',
            'User-Agent': UA
          },
          signal: AbortSignal.timeout(30_000)
        })
        if (!res.ok) throw new Error(`下载 ${rel} 失败（HTTP ${res.status}）`)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      }
      const meta = parseSkillFile(join(target, 'SKILL.md'))
      result.installed.push({ name: meta.meta.name || slug, path: join(target, 'SKILL.md') })
    } catch (e) {
      rmSync(target, { recursive: true, force: true })
      result.skipped.push(`${root || '(仓库根目录)'}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
