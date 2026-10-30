import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { CookiesSetDetails, Session } from 'electron'
import { Logger } from '@main/infra/log'

export type SystemLoginResult = 'synced' | 'aborted' | 'rejected' | 'unsupported'

interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: string
  partitionKey?: unknown
}

const GOOGLE_DOMAINS = [
  'google.com',
  'google.cn',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'youtube.com',
  'ytimg.com',
  'ggpht.com',
  'googlevideo.com',
  'withgoogle.com'
]

/** ChatGPT / Claude 的登录态有一部分在 SSO 域上，只靠来源域会漏 */
const RELATED_DOMAINS: Record<string, string[]> = {
  'chatgpt.com': ['openai.com'],
  'claude.ai': ['anthropic.com']
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, '').toLowerCase()
}

function isGoogleDomain(domain: string): boolean {
  const d = normalizeDomain(domain)
  return GOOGLE_DOMAINS.some((g) => d === g || d.endsWith(`.${g}`))
}

function relatedDomainsFor(host: string): string[] {
  const out = [host]
  for (const [key, extra] of Object.entries(RELATED_DOMAINS)) {
    if (host === key || host.endsWith(`.${key}`)) out.push(...extra)
  }
  if (host.endsWith('.google.com') || host === 'google.com') out.push('google.com')
  return out
}

function matchesDomains(domain: string, domains: string[]): boolean {
  const d = normalizeDomain(domain)
  return domains.some((x) => d === x || d.endsWith(`.${x}`))
}

/** Google 自己的站点登录（Gemini）必须回传 Google Cookie，其余站点跳过，避免串号 */
function shouldTransferCookie(domain: string, sourceHost: string): boolean {
  return isGoogleDomain(sourceHost) || !isGoogleDomain(domain)
}

/** 各平台真正代表「已登录」的 Cookie，避免把 state/csrf 之类的中间态当成登录成功 */
function sessionCookiePattern(host: string): RegExp {
  if (host.endsWith('chatgpt.com')) return /next-auth\.session-token/i
  if (host.endsWith('claude.ai')) return /^sessionKey$/i
  if (host.endsWith('google.com')) return /^(SID|__Secure-1PSID|__Secure-3PSID)$/i
  return /session-token|sessionKey|(^|[-_.])session($|[-_.])/i
}

export function findSystemBrowser(): string | null {
  const win = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  const candidates: string[] = []
  if (win) {
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? ''
    candidates.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    )
  } else if (mac) {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else {
    for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try {
        const found = execFileSync('which', [bin], { encoding: 'utf8' }).trim()
        if (found) candidates.push(found)
      } catch {
        /* 未安装 */
      }
    }
  }
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 上次异常退出可能留下一个没有调试端口的浏览器，会把新实例的启动参数吞掉 */
function killStaleBrowsers(): void {
  try {
    if (process.platform === 'win32') {
      const script =
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('system-login-browser') } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 8000
      })
    } else {
      execFileSync('pkill', ['-f', 'system-login-browser'], { timeout: 5000 })
    }
  } catch {
    /* 没有残留进程 */
  }
}

/**
 * 端口 0 让 Chrome/Edge 自己选端口并写入 DevToolsActivePort；
 * 预先探测空闲端口会与浏览器启动竞态，实测会导致调试端口一直不监听。
 */
async function waitForDevTools(
  profileDir: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<{ port: number; wsUrl: string } | null> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null
    try {
      if (existsSync(portFile)) {
        const [portText, path = ''] = readFileSync(portFile, 'utf8').split(/\r?\n/)
        const port = Number(portText)
        if (port > 0) {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1500)
          })
          if (res.ok) {
            const info = (await res.json()) as { webSocketDebuggerUrl?: string }
            const wsUrl = info.webSocketDebuggerUrl || `ws://127.0.0.1:${port}${path}`
            return { port, wsUrl }
          }
        }
      }
    } catch {
      /* 浏览器还在启动 */
    }
    await sleep(250)
  }
  return null
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class Cdp {
  private readonly pending = new Map<number, PendingCall>()
  private seq = 0

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number
        result?: unknown
        error?: { message?: string }
      }
      if (!msg.id) return
      const call = this.pending.get(msg.id)
      if (!call) return
      this.pending.delete(msg.id)
      clearTimeout(call.timer)
      if (msg.error) call.reject(new Error(msg.error.message ?? 'CDP 调用失败'))
      else call.resolve(msg.result)
    }
    ws.onclose = () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    }
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('CDP 连接失败'))
      }
    })
    return new Cdp(ws)
  }

  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, 12_000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* 已关闭 */
    }
  }
}

async function listTargets(port: number): Promise<{ type: string; url: string }[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) return []
    return (await res.json()) as { type: string; url: string }[]
  } catch {
    return []
  }
}

function sameSiteToElectron(sameSite?: string): CookiesSetDetails['sameSite'] {
  if (sameSite === 'Strict') return 'strict'
  if (sameSite === 'Lax') return 'lax'
  if (sameSite === 'None') return 'no_restriction'
  return 'unspecified'
}

function toElectronCookie(cookie: BrowserCookie): CookiesSetDetails {
  const host = normalizeDomain(cookie.domain)
  const path = cookie.path || '/'
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    // __Host- 前缀要求不能带 Domain 属性，带了会被 Chromium 直接拒绝
    ...(cookie.name.startsWith('__Host-') ? {} : { domain: cookie.domain }),
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    sameSite: sameSiteToElectron(cookie.sameSite)
  }
}

/**
 * 清掉系统配置里该平台的旧登录态：残留的 auth.openai.com session/state 会让
 * chatgpt.com 一打开就续上旧 OAuth 流程（可能正是被 Google 标记的那一条）。
 * 只清平台相关域，Google 登录态保留，省去重新输入密码。
 */
async function clearProviderSession(cdp: Cdp, host: string): Promise<void> {
  const origins = new Set<string>()
  for (const domain of relatedDomainsFor(host)) {
    origins.add(`https://${domain}`)
    origins.add(`https://auth.${domain}`)
    origins.add(`https://www.${domain}`)
  }
  // 远程调试让 Chrome 被 Google 标记过，旧 Google 会话可能一起被标记；
  // 清掉后重新登录，最多多过一次验证码，但不会继承被拒状态。
  if (!isGoogleDomain(host)) {
    origins.add('https://accounts.google.com')
    origins.add('https://www.google.com')
    origins.add('https://google.com')
    origins.add('https://accounts.youtube.com')
  }
  for (const origin of origins) {
    try {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies' })
    } catch {
      /* 清不掉也不阻塞登录 */
    }
  }
}

async function readCookies(cdp: Cdp): Promise<BrowserCookie[]> {
  const result = await cdp.send<{ cookies: BrowserCookie[] }>('Storage.getCookies')
  return result.cookies ?? []
}

function sessionCookies(
  cookies: BrowserCookie[],
  domains: string[],
  sourceHost: string
): BrowserCookie[] {
  const pattern = sessionCookiePattern(sourceHost)
  return cookies.filter(
    (c) =>
      c.domain &&
      matchesDomains(c.domain, domains) &&
      shouldTransferCookie(c.domain, sourceHost) &&
      pattern.test(c.name)
  )
}

function cookieKey(cookie: BrowserCookie): string {
  return `${cookie.domain}|${cookie.name}|${cookie.value}`
}

async function importCookies(
  cdp: Cdp,
  session: Session,
  domains: string[],
  sourceHost: string
): Promise<number> {
  const cookies = await readCookies(cdp)
  let imported = 0
  for (const cookie of cookies) {
    if (!cookie.domain || !matchesDomains(cookie.domain, domains)) continue
    if (!shouldTransferCookie(cookie.domain, sourceHost)) continue
    if (cookie.partitionKey) continue
    try {
      await session.cookies.set(toElectronCookie(cookie))
      imported += 1
    } catch {
      /* 单个 Cookie 失败不影响整体 */
    }
  }
  await session.cookies.flushStore().catch(() => undefined)
  return imported
}

/**
 * Google 会按环境风控拒绝第三方登录：UA/UA-CH 伪装、复用旧 OAuth URL 都可能被拒，
 * 真实浏览器复用被标记的 dsh 会话也一样。做法是用系统 Chrome/Edge 的独立配置，
 * 从平台首页重新发起一次全新登录，检测到平台的会话 Cookie 后同步回 webview 分区。
 */
export async function runSystemBrowserLogin(opts: {
  browserPath: string
  sourceOrigin: string
  session: Session
}): Promise<SystemLoginResult> {
  let sourceHost: string
  try {
    sourceHost = new URL(opts.sourceOrigin).hostname
  } catch {
    return 'unsupported'
  }
  if (!sourceHost) return 'unsupported'
  const domains = relatedDomainsFor(sourceHost)

  const profileDir = join(app.getPath('userData'), 'system-login-browser')
  mkdirSync(profileDir, { recursive: true })
  killStaleBrowsers()
  await sleep(400)
  // 上一次异常退出可能留下过期端口文件，Chrome 会直接复用它
  try {
    unlinkSync(join(profileDir, 'DevToolsActivePort'))
  } catch {
    /* 不存在 */
  }

  const child = spawn(
    opts.browserPath,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-background-mode',
      '--disable-session-crashed-bubble',
      '--window-size=560,860',
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: false }
  )

  const devtools = await waitForDevTools(profileDir, child, 25_000)
  if (!devtools) {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    Logger.warn('auth', `系统浏览器未能在调试端口上启动（exit=${child.exitCode}）`)
    return 'unsupported'
  }
  const { port, wsUrl } = devtools

  let cdp: Cdp | null = null
  let browserClosed = false
  try {
    cdp = await Cdp.connect(wsUrl)
    await clearProviderSession(cdp, sourceHost)
    const initial = sessionCookies(await readCookies(cdp), domains, sourceHost)
    const baseline = new Set(initial.map(cookieKey))
    let baselineSyncAt = initial.length > 0 ? Date.now() : 0

    // 从平台首页重新发起登录：不复用旧 OAuth URL（其中的 dsh 可能已被 Google 标记）
    const startUrl = `https://${sourceHost}/`
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: startUrl })
    try {
      const all = await cdp.send<{
        targetInfos: { targetId: string; type: string; url: string }[]
      }>('Target.getTargets')
      for (const info of all.targetInfos) {
        if (info.targetId === created.targetId) continue
        if (info.type === 'page' && /^(about:blank|chrome:\/\/newtab\/?)$/.test(info.url)) {
          await cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
        }
      }
    } catch {
      /* 关不掉也不影响登录 */
    }

    Logger.info('auth', `Google 登录改用系统浏览器: ${opts.browserPath}（从 ${startUrl} 重新登录）`)

    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      await sleep(1800)
      if (child.exitCode !== null) {
        Logger.warn('auth', '系统浏览器在登录完成前被关闭')
        return 'aborted'
      }
      const targets = await listTargets(port)
      if (targets.some((t) => t.type === 'page' && t.url.includes('/signin/rejected'))) {
        Logger.warn('auth', 'Google 在系统浏览器中仍拒绝了登录')
        return 'rejected'
      }
      const current = sessionCookies(await readCookies(cdp), domains, sourceHost)
      if (current.length === 0) {
        baselineSyncAt = 0
        continue
      }
      const changed = current.some((c) => !baseline.has(cookieKey(c)))
      // 系统配置里本来就有可用登录态：给用户几秒看清页面后直接同步
      if (!changed && baselineSyncAt && Date.now() - baselineSyncAt < 5000) continue
      const imported = await importCookies(cdp, opts.session, domains, sourceHost)
      if (imported === 0) {
        baselineSyncAt = 0
        continue
      }
      browserClosed = true
      try {
        await cdp.send('Browser.close')
      } catch {
        child.kill()
      }
      Logger.info('auth', `登录态已从系统浏览器同步 ${imported} 个 Cookie`)
      return 'synced'
    }
    Logger.warn('auth', '系统浏览器登录超时')
    return 'aborted'
  } catch (e) {
    Logger.warn('auth', `系统浏览器登录失败: ${e instanceof Error ? e.message : String(e)}`)
    if (!browserClosed) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }
    return 'unsupported'
  } finally {
    cdp?.close()
  }
}
