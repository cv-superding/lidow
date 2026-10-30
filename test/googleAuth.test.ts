import { describe, expect, it } from 'vitest'
import { chromeUserAgent, isGoogleAuthUrl } from '@main/app/googleAuth'

describe('Google OAuth 独立窗口识别', () => {
  it('识别账号登录与 OAuth 路径', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier?x=1')).toBe(true)
    expect(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=abc')).toBe(true)
    expect(isGoogleAuthUrl('https://www.google.com/o/oauth2/auth?redirect_uri=x')).toBe(true)
    expect(isGoogleAuthUrl('https://www.google.com/accounts/Logout')).toBe(true)
  })

  it('不拦截普通 Google 页面和非 https 链接', () => {
    expect(isGoogleAuthUrl('https://www.google.com/search?q=lidow')).toBe(false)
    expect(isGoogleAuthUrl('https://gemini.google.com/app')).toBe(false)
    expect(isGoogleAuthUrl('http://accounts.google.com/signin')).toBe(false)
    expect(isGoogleAuthUrl('https://chatgpt.com/auth/login')).toBe(false)
    expect(isGoogleAuthUrl('not a url')).toBe(false)
  })

  it('登录窗口使用不含 Electron 标识的桌面 Chrome UA', () => {
    const ua = chromeUserAgent('win32')
    expect(ua).toContain('Chrome/')
    expect(ua).not.toContain('Electron')
    expect(ua).toContain('Windows NT 10.0')
  })
})
