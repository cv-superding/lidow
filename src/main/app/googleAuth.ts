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
