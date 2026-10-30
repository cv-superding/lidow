import type { WebContents } from 'electron'

/**
 * Google 只在嵌入式 webview 里拒绝 OAuth；独立顶层窗口可以正常打开登录页。
 * 命中 accounts.google.com 或 google.com 的 OAuth/登录路径时改走独立窗口。
 */
export function isGoogleAuthUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'accounts.google.com' || host === 'accounts.google.cn') return true
  if (host === 'google.com' || host.endsWith('.google.com') || host === 'google.cn' || host.endsWith('.google.cn')) {
    return /^\/(?:o\/oauth2|signin|accounts|ServiceLogin)/i.test(url.pathname)
  }
  return false
}

/** 与 webview 一致的桌面 Chrome UA（去掉 Electron 标识） */
export function chromeUserAgent(platform = process.platform): string {
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  const chrome = process.versions.chrome ?? '126'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

/**
 * Chrome 的 UA-CH 品牌里必须有 "Google Chrome"，否则 Google 会把声称 Chrome 的
 * Electron 判定为不安全的内嵌浏览器（disallowed_useragent）。session.setUserAgent
 * 只能改 UA 字符串、改不了品牌，所以用 CDP 在页面加载前覆盖 UA + client hints。
 *
 * 必须在 loadURL 之前 await：Google 是在收到 OAuth 请求时就做判定的。
 */
export async function applyChromeClientHints(wc: WebContents): Promise<boolean> {
  const fullVersion = process.versions.chrome ?? '126.0.0.0'
  const major = fullVersion.split('.')[0]!
  const metadata = {
    brands: [
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major },
      { brand: 'Not?A_Brand', version: '24' }
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version: fullVersion },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Not?A_Brand', version: '24.0.0.0' }
    ],
    fullVersion,
    platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    platformVersion: process.platform === 'darwin' ? '14.0.0' : process.platform === 'win32' ? '10.0.0' : '6.5.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false
  }
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    const apply = async (): Promise<boolean> => {
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: chromeUserAgent(),
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
        platform: process.platform === 'darwin' ? 'MacIntel' : 'Win32',
        userAgentMetadata: metadata
      })
      return true
    }
    // 没有 renderer 时 CDP 命令会一直排队：超时后照常打开，避免登录窗口白屏
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500))
    return await Promise.race([apply(), timeout])
  } catch {
    return false
  }
}
