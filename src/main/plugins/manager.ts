import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import { execCommand } from '@main/tools/exec'
import type { ToolContext } from '@main/tools/types'
import type { InstalledPlugin, MarketPlugin, PluginManifest } from '@shared/types'

/**
 * 插件系统：安装（GitHub/Gitee zip 下载 + 系统解压）、启停、卸载、依赖检测。
 * 插件可打包：skills/agents/rules/mcp/自定义平台/网页脚本/DSH 服务。
 */

interface PluginStoreData {
  disabled: string[]
}

export class PluginManager {
  private store: JsonStore<PluginStoreData>

  constructor(
    private userDataDir: string,
    private execCtx: () => ToolContext
  ) {
    this.store = new JsonStore<PluginStoreData>(join(userDataDir, 'plugins.json'), { disabled: [] })
    mkdirSync(this.pluginsDir(), { recursive: true })
  }

  private pluginsDir(): string {
    return join(this.userDataDir, 'plugins')
  }

  private pluginDir(id: string): string {
    return join(this.pluginsDir(), id)
  }

  list(): InstalledPlugin[] {
    const out: InstalledPlugin[] = []
    const fsDirs = safeReadDir(this.pluginsDir())
    for (const id of fsDirs) {
      const manifestPath = join(this.pluginsDir(), id, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
        out.push({
          ...manifest,
          id: manifest.id ?? id,
          installedAt: statMtime(manifestPath),
          enabled: !this.store.get().disabled.includes(manifest.id ?? id),
          dir: join(this.pluginsDir(), id)
        })
      } catch (e) {
        Logger.warn('plugins', `清单损坏 ${id}: ${String(e)}`)
      }
    }
    return out
  }

  /** 依赖检测：插件的 provides 引用（如 mcp server 依赖的 command）是否可用 */
  checkDependencies(plugin: InstalledPlugin): { ok: boolean; problems: string[] } {
    const problems: string[] = []
    if (plugin.entry && !existsSync(join(plugin.dir, plugin.entry))) {
      problems.push(`入口文件缺失: ${plugin.entry}`)
    }
    if (plugin.dsh && !existsSync(join(plugin.dir, plugin.dsh))) {
      problems.push(`DSH 入口缺失: ${plugin.dsh}`)
    }
    return { ok: problems.length === 0, problems }
  }

  /** 市场搜索：GitHub topic:lidow-plugin + Gitee 双源 */
  async searchMarket(query: string, category?: string): Promise<MarketPlugin[]> {
    const results: MarketPlugin[] = []
    const q = query ? `${query}` : ''
    // GitHub
    try {
      const ghQuery = [`topic:lidow-plugin`, q, category ? `topic:lidow-${category}` : ''].filter(Boolean).join(' ')
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(ghQuery)}&per_page=20`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (res.ok) {
        const data = (await res.json()) as { items?: { name: string; full_name: string; description: string; html_url: string; stargazers_count: number; pushed_at: string }[] }
        for (const it of data.items ?? []) {
          results.push({
            id: it.full_name,
            name: it.name,
            description: it.description ?? '',
            version: it.pushed_at.slice(0, 10),
            author: it.full_name.split('/')[0] ?? '',
            stars: it.stargazers_count,
            repoUrl: it.html_url,
            source: 'github'
          })
        }
      }
    } catch (e) {
      Logger.warn('plugins', `GitHub 市场搜索失败: ${String(e)}`)
    }
    // Gitee
    try {
      const res = await fetch(`https://gitee.com/api/v5/search/repositories?q=${encodeURIComponent(q || 'lidow-plugin')}&per_page=20`, {
        signal: AbortSignal.timeout(15_000)
      })
      if (res.ok) {
        const data = (await res.json()) as { full_name: string; name: string; description: string; html_url: string; stargazers_count: number; owner?: { login: string } }[]
        for (const it of Array.isArray(data) ? data : []) {
          results.push({
            id: it.full_name,
            name: it.name,
            description: it.description ?? '',
            version: '',
            author: it.owner?.login ?? '',
            stars: it.stargazers_count,
            repoUrl: it.html_url,
            source: 'gitee'
          })
        }
      }
    } catch (e) {
      Logger.warn('plugins', `Gitee 市场搜索失败: ${String(e)}`)
    }
    const installed = new Set(this.list().map((p) => p.id))
    return results.map((r) => ({ ...r, installed: installed.has(r.id) }))
  }

  /** 安装：下载 zip → 系统解压 → 校验 manifest */
  async install(repoFullName: string, source: 'github' | 'gitee'): Promise<void> {
    const id = repoFullName.split('/').pop() ?? repoFullName
    const target = this.pluginDir(id)
    if (existsSync(target)) throw new Error(`插件已安装: ${id}`)
    const zipUrl =
      source === 'github'
        ? `https://codeload.github.com/${repoFullName}/zip/refs/heads/master`
        : `https://gitee.com/${repoFullName}/repository/archive/master.zip`
    const tmpZip = join(this.userDataDir, `${id}.zip`)
    const res = await fetch(zipUrl, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) {
      // master 失败试 main
      const alt =
        source === 'github'
          ? `https://codeload.github.com/${repoFullName}/zip/refs/heads/main`
          : zipUrl.replace('master', 'main')
      const res2 = await fetch(alt, { signal: AbortSignal.timeout(60_000) })
      if (!res2.ok) throw new Error(`下载失败 HTTP ${res2.status}`)
      await downloadTo(res2, tmpZip)
    } else {
      await downloadTo(res, tmpZip)
    }
    mkdirSync(target, { recursive: true })
    const extractTo = join(this.userDataDir, `.extract-${Date.now()}`)
    mkdirSync(extractTo, { recursive: true })
    const isWin = process.platform === 'win32'
    const cmd = isWin
      ? `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${extractTo}' -Force"`
      : `unzip -o ${JSON.stringify(tmpZip)} -d ${JSON.stringify(extractTo)}`
    const r = await execCommand(cmd, this.execCtx())
    if (!r.ok) throw new Error(`解压失败: ${r.output.slice(0, 300)}`)
    // zip 内通常是 <repo>-master/ 顶层目录，取唯一子目录内容
    const inner = safeReadDir(extractTo)
    const srcDir = inner.length === 1 ? join(extractTo, inner[0]!) : extractTo
    const r2 = await execCommand(
      isWin
        ? `powershell -NoProfile -Command "Copy-Item -Path '${srcDir}\\*' -Destination '${target}' -Recurse -Force"`
        : `cp -a ${JSON.stringify(srcDir + '/.')} ${JSON.stringify(target)}/`,
      this.execCtx()
    )
    rmSync(extractTo, { recursive: true, force: true })
    rmSync(tmpZip, { force: true })
    if (!r2.ok) throw new Error(`安装文件复制失败: ${r2.output.slice(0, 300)}`)
    if (!existsSync(join(target, 'manifest.json'))) {
      Logger.warn('plugins', `插件 ${id} 无 manifest.json，按原样保留`)
    }
  }

  uninstall(id: string): void {
    rmSync(this.pluginDir(id), { recursive: true, force: true })
    this.store.update((d) => ({ disabled: d.disabled.filter((x) => x !== id) }))
  }

  toggle(id: string, enabled: boolean): void {
    this.store.update((d) => ({
      disabled: enabled ? d.disabled.filter((x) => x !== id) : [...new Set([...d.disabled, id])]
    }))
  }

  isEnabled(id: string): boolean {
    return !this.store.get().disabled.includes(id)
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

async function downloadTo(res: Response, file: string): Promise<void> {
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}
