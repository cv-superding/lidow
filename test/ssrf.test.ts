import { describe, expect, it } from 'vitest'
import { assertSafeUrl, isPrivateIp } from '@main/security/ssrf'

describe('isPrivateIp', () => {
  it('识别 IPv4 私网/回环/链路本地/CGNAT', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
  })
  it('放行公网 IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })
  it('识别 IPv6 回环/ULA/链路本地/IPv4 映射', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:192.168.1.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    expect(isPrivateIp('2606:4700::1')).toBe(false)
  })
})

describe('assertSafeUrl', () => {
  it('拒绝非 http(s) 协议', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('协议')
    await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow('协议')
  })
  it('拒绝私网/回环 IP', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/x')).rejects.toThrow('SSRF')
    await expect(assertSafeUrl('http://192.168.1.1/')).rejects.toThrow('SSRF')
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow('SSRF')
  })
  it('拒绝云元数据端点', async () => {
    await expect(assertSafeUrl('http://metadata.google.internal/computeMetadata/')).rejects.toThrow('SSRF')
  })
  it('allowPrivate 时放行回环', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:3000/', { allowPrivate: true })).resolves.toBeUndefined()
  })
  it('拒绝无效 URL', async () => {
    await expect(assertSafeUrl('not-a-url')).rejects.toThrow('无效')
  })
})
