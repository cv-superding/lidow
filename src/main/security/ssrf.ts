import { isIP } from 'node:net'
import { lookup } from 'node:dns'

/**
 * SSRF 防护：拦截私网地址 / 回环 / 链路本地 / 元数据端点
 * 纯函数判定 IP + DNS 解析后再判定一次（防 DNS rebinding 的初阶防护）
 */

const BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.goog'
]

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    const [a = 0, b = 0] = parts
    if (a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase()
    if (low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd')) return true
    if (low.startsWith('fe80')) return true
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
  }
  return false
}

export async function assertSafeUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {}
): Promise<void> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new Error(`无效 URL: ${rawUrl}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不允许的协议: ${u.protocol}`)
  }
  // URL 的 IPv6 字面量主机名带方括号（[::1]），isIP 无法识别，必须先剥掉
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (BLOCKED_HOSTNAMES.includes(host.toLowerCase())) {
    throw new Error(`目标被 SSRF 防护拦截: ${host}`)
  }
  // 纯 IP 直接判定
  if (isIP(host)) {
    if (!opts.allowPrivate && isPrivateIp(host)) {
      throw new Error(`目标为私网地址，已被 SSRF 防护拦截: ${host}`)
    }
    return
  }
  // localhost 变体
  if (/^localhost$/i.test(host) || host.endsWith('.localhost')) {
    if (!opts.allowPrivate) throw new Error(`目标为回环地址，已被 SSRF 防护拦截: ${host}`)
    return
  }
  // 域名：解析所有记录后判定
  if (!opts.allowPrivate) {
    const addrs = await new Promise<string[]>((resolve) => {
      lookup(host, { all: true }, (err, res) => resolve(err ? [] : res.map((r) => r.address)))
    })
    for (const addr of addrs) {
      if (isPrivateIp(addr)) {
        throw new Error(`域名解析到私网地址，已被 SSRF 防护拦截: ${host} → ${addr}`)
      }
    }
  }
}
