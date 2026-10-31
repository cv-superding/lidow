import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'
import { JsonStore } from '@main/infra/store'
import { Logger } from '@main/infra/log'
import { execCommand } from '@main/tools/exec'
import { isPathInside } from '@shared/path'
import type { ToolContext } from '@main/tools/types'
import type { InstalledPlugin, MarketPlugin, PluginManifest } from '@shared/types'

const SAFE_ID = /^[A-Za-z0-9._-]+$/
const MAX_PLUGIN_ZIP = 200 * 1024 * 1024

/** 插件 id/目录名只允许单段安全字符：manifest 里的 id 不能当路径用 */
function safePluginId(id: string): string {
  const v = String(id ?? '')
  if (!SAFE_ID.test(v) || v === '.' || v === '..') throw new Error(`非法插件 id: ${id}`)
  return v
}

/** manifest 里的入口路径必须落在插件目录内（否则 = 加载/读取任意文件） */
function insidePlugin(pluginDir: string, rel: string | undefined): string | undefined {
  if (!rel) return undefined
  const abs = join(pluginDir, rel)
  return isPathInside(pluginDir, abs) ? rel : undefined
}

/**
 * 插件系统：安装（GitHub/Gitee zip 下载 + 系统解压）、启停、卸载、依赖检测。
 * 插件可打包：skills/agents/rules/mcp/自定义平台/网页脚本/DSH 服务。
 */

interface PluginStoreData {
  disabled: string[]
}

/**
 * 走系统代理的网络请求：net.fetch 走 Chromium 网络栈（继承系统代理设置）。
 * 用全局 fetch 直连 GitHub 在国内环境必然超时，且失败是静默的 ——
 * 市场看起来就像"什么都没有"，用户无从知道是网络问题。
 */
function netFetch(url: string, timeoutMs = 15_000, headers?: Record<string, string>): Promise<Response> {
  return net.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }) as unknown as Promise<Response>
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
    return join(this.pluginsDir(), safePluginId(id))
  }

  list(): InstalledPlugin[] {
    const out: InstalledPlugin[] = []
    const fsDirs = safeReadDir(this.pluginsDir())
    for (const dirName of fsDirs) {
      // 目录名就是插件身份：manifest.id 只用于展示，绝不能拿来拼 uninstall 路径
      if (!SAFE_ID.test(dirName) || dirName === '.' || dirName === '..') continue
      const pluginDir = join(this.pluginsDir(), dirName)
      const manifestPath = join(pluginDir, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
        out.push({
          ...manifest,
          id: dirName,
          entry: insidePlugin(pluginDir, manifest.entry),
          dsh: insidePlugin(pluginDir, manifest.dsh),
          webScript: insidePlugin(pluginDir, manifest.webScript),
          installedAt: statMtime(manifestPath),
          enabled: !this.store.get().disabled.includes(dirName),
          dir: pluginDir
        })
      } catch (e) {
        Logger.warn('plugins', `清单损坏 ${dirName}: ${String(e)}`)
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

  /** 市场搜索：GitHub topic:lidow-plugin + Gitee 双源；失败原因如实带回（不再静默吞掉） */
  async searchMarket(query: string, category?: string): Promise<{ items: MarketPlugin[]; warning?: string }> {
    const results: MarketPlugin[] = []
    const errors: string[] = []
    const q = query ? `${query}` : ''
    // GitHub
    try {
      const ghQuery = [`topic:lidow-plugin`, q, category ? `topic:lidow-${category}` : ''].filter(Boolean).join(' ')
      const res = await netFetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(ghQuery)}&per_page=20`,
        15_000,
        { Accept: 'application/vnd.github+json' }
      )
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
      } else {
        errors.push(`GitHub HTTP ${res.status}`)
      }
    } catch (e) {
      errors.push(`GitHub ${e instanceof Error ? e.message : String(e)}`)
    }
    // Gitee
    try {
      const res = await netFetch(`https://gitee.com/api/v5/search/repositories?q=${encodeURIComponent(q || 'lidow-plugin')}&per_page=20`)
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
      } else {
        errors.push(`Gitee HTTP ${res.status}`)
      }
    } catch (e) {
      errors.push(`Gitee ${e instanceof Error ? e.message : String(e)}`)
    }
    // 全部失败且无结果：这是网络问题的信号，必须让用户看见而不是显示空态
    const warning = results.length === 0 && errors.length > 0 ? `市场搜索失败：${errors.join('；')}（请检查系统代理设置）` : undefined
    const installed = new Set(this.list().map((p) => p.id))
    return {
      items: results.map((r) => ({
        ...r,
        // 市场 id 是 owner/repo，安装后的目录名是 repo
        installed: installed.has(r.id) || installed.has(r.id.split('/').pop() ?? '')
      })),
      warning
    }
  }

  /** 安装：下载 zip → 系统解压 → 校验 manifest */
  async install(repoFullName: string, source: 'github' | 'gitee'): Promise<void> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
      throw new Error(`非法仓库地址: ${repoFullName}`)
    }
    const rawId = repoFullName.split('/').pop() ?? repoFullName
    const id = safePluginId(rawId.replace(/[^A-Za-z0-9._-]/g, '_'))
    const target = this.pluginDir(id)
    if (existsSync(target)) throw new Error(`插件已安装: ${id}`)
    const zipUrl =
      source === 'github'
        ? `https://codeload.github.com/${repoFullName}/zip/refs/heads/master`
        : `https://gitee.com/${repoFullName}/repository/archive/master.zip`
    const tmpZip = join(this.userDataDir, `${id}.zip`)
    const res = await netFetch(zipUrl, 60_000)
    if (!res.ok) {
      // master 失败试 main
      const alt =
        source === 'github'
          ? `https://codeload.github.com/${repoFullName}/zip/refs/heads/main`
          : zipUrl.replace('master', 'main')
      const res2 = await netFetch(alt, 60_000)
      if (!res2.ok) throw new Error(`下载失败 HTTP ${res2.status}`)
      await downloadTo(res2, tmpZip)
    } else {
      await downloadTo(res, tmpZip)
    }
    mkdirSync(target, { recursive: true })
    const extractTo = join(this.userDataDir, `.extract-${Date.now()}`)
    mkdirSync(extractTo, { recursive: true })
    const isWin = process.platform === 'win32'
    // PowerShell 单引号字符串里的 ' 必须双写；路径均来自本地临时目录
    const psQuote = (p: string): string => `'${p.replace(/'/g, "''")}'`
    const cmd = isWin
      ? `powershell -NoProfile -Command "Expand-Archive -LiteralPath ${psQuote(tmpZip)} -DestinationPath ${psQuote(extractTo)} -Force"`
      : `unzip -o ${JSON.stringify(tmpZip)} -d ${JSON.stringify(extractTo)}`
    const r = await execCommand(cmd, this.execCtx())
    if (!r.ok) {
      rmSync(extractTo, { recursive: true, force: true })
      rmSync(tmpZip, { force: true })
      throw new Error(`解压失败: ${r.output.slice(0, 300)}`)
    }
    // zip 内通常是 <repo>-master/ 顶层目录，取唯一子目录内容。
    // 这里必须校验目录名：压缩包里的顶层目录名可控，不能直接拼进 shell。
    const inner = safeReadDir(extractTo)
    const candidate = inner.length === 1 ? join(extractTo, inner[0]!) : extractTo
    const srcDir = isPathInside(extractTo, candidate) ? candidate : extractTo
    try {
      // 用 Node 复制而不是 cp/Copy-Item：zip 解出的目录名可包含引号/$(...)，
      // 拼 shell 会变成命令注入。
      cpSync(srcDir, target, { recursive: true, force: true })
    } catch (e) {
      // 复制失败不要留下一个“已安装”的空壳目录
      rmSync(target, { recursive: true, force: true })
      throw e
    } finally {
      rmSync(extractTo, { recursive: true, force: true })
      rmSync(tmpZip, { force: true })
    }
    if (!existsSync(join(target, 'manifest.json'))) {
      Logger.warn('plugins', `插件 ${id} 无 manifest.json，按原样保留`)
    }
  }

  uninstall(id: string): void {
    const safe = safePluginId(id)
    rmSync(this.pluginDir(safe), { recursive: true, force: true })
    this.store.update((d) => ({ disabled: d.disabled.filter((x) => x !== safe) }))
  }

  toggle(id: string, enabled: boolean): void {
    const safe = safePluginId(id)
    this.store.update((d) => ({
      disabled: enabled ? d.disabled.filter((x) => x !== safe) : [...new Set([...d.disabled, safe])]
    }))
  }

  isEnabled(id: string): boolean {
    return !this.store.get().disabled.includes(id)
  }

  // ---------- 内置精选（本地直装，不依赖网络） ----------
  //
  // 市场搜索依赖 GitHub/Gitee，网络不通时页面就是一片空白。
  // 内置精选保证"打开市场就有东西可装"，而且这些插件是真实生效的：
  // 装完立刻被插件运行时加载（见 AppContext.loadAllPlugins）。

  /** 内置精选清单（未安装的才展示） */
  listBuiltins(): MarketPlugin[] {
    const installed = new Set(this.list().map((p) => p.id))
    return BUILTIN_PLUGINS.map((b) => ({
      id: b.manifest.id,
      name: b.manifest.name,
      description: b.manifest.description ?? '',
      version: b.manifest.version,
      author: 'Lidow 官方',
      stars: undefined,
      repoUrl: '',
      source: 'builtin' as const,
      installed: installed.has(b.manifest.id)
    }))
  }

  /** 安装内置插件：直接落盘（无网络），装完由运行时加载 */
  installBuiltin(id: string): void {
    const b = BUILTIN_PLUGINS.find((x) => x.manifest.id === id)
    if (!b) throw new Error(`未知内置插件: ${id}`)
    const target = this.pluginDir(id)
    if (existsSync(target)) throw new Error(`插件已安装: ${id}`)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(b.manifest, null, 2))
    for (const [name, content] of Object.entries(b.files)) {
      writeFileSync(join(target, name), content)
    }
    Logger.info('plugins', `内置插件已安装: ${id}`)
  }
}

/**
 * 内置精选插件：manifest + 文件在编译期写死，安装即落盘。
 * 两个都是真实生效的最小可用件 —— 不是占位 demo：
 *  1. dsh-storage-demo：DSH 扩展，加载时向 storage 写一条「加载时间」，
 *     用于验证插件运行时接线（应用启动日志可见）
 *  2. web-badge：网页脚本，在 DeepSeek 对话页右下角注入一枚「Lidow 已接管」徽标，
 *     用于验证 webScript 注入链路
 */
const BUILTIN_PLUGINS: { manifest: PluginManifest; files: Record<string, string> }[] = [
  {
    manifest: {
      id: 'dsh-storage-demo',
      name: 'DSH 存储示例',
      version: '1.0.0',
      description: 'DSH 扩展最小示例：加载时向 storage 写入加载时间，验证插件运行时接线。',
      author: 'Lidow',
      category: 'dsh',
      provides: ['dsh'],
      dsh: 'dsh.js'
    },
    files: {
      'dsh.js': `// DSH 扩展：register(ctx) 收到全部 119 个兼容服务
export async function register(ctx) {
  try {
    const ts = new Date().toISOString()
    await ctx.storage.set('dsh-storage-demo.loadedAt', ts)
    console.log('[lidow-plugin] DSH 存储示例已加载', ts)
  } catch (e) {
    console.warn('[lidow-plugin] storage 不可用', e)
  }
}
`
    }
  },
  {
    manifest: {
      id: 'web-badge',
      name: '接管徽标',
      version: '1.0.0',
      description: '在 AI 对话页右下角注入一枚「Lidow 已接管」徽标，验证网页脚本注入链路。',
      author: 'Lidow',
      category: 'webScript',
      provides: ['webScript'],
      platform: 'deepseek',
      webScript: 'badge.js'
    },
    files: {
      'badge.js': `// 网页脚本：在页面上加一枚小徽标（不碰平台自己的 DOM 逻辑）
;(() => {
  if (document.getElementById('lidow-plugin-badge')) return
  const el = document.createElement('div')
  el.id = 'lidow-plugin-badge'
  el.textContent = 'Lidow 已接管'
  el.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:150px', 'z-index:2147483645',
    'padding:4px 10px', 'border-radius:999px', 'font-size:11px', 'font-weight:600',
    'background:rgba(141,255,79,.16)', 'color:#59d915', 'border:1px solid rgba(89,217,21,.4)',
    'font-family:system-ui,sans-serif', 'pointer-events:none', 'opacity:.8'
  ].join(';')
  document.body.appendChild(el)
})()
`
    }
  }
]

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
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_PLUGIN_ZIP) throw new Error(`插件包过大（${Math.round(declared / 1024 / 1024)}MB）`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_PLUGIN_ZIP) throw new Error(`插件包过大（${Math.round(buf.byteLength / 1024 / 1024)}MB）`)
  writeFileSync(file, buf)
}
