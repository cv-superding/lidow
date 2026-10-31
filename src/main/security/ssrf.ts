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

/** 展开 IPv6 为 8 个 16 位分组；支持 :: 简写与末尾点分 IPv4，非法返回 null */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!
  if (!s.includes(':')) return null
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const parts = v4[1]!.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return null
    s =
      s.slice(0, -v4[1]!.length) +
      ((parts[0]! << 8) | parts[1]!).toString(16) +
      ':' +
      ((parts[2]! << 8) | parts[3]!).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(':').filter(Boolean) : []
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(':').filter(Boolean) : []
  const parse = (x: string): number => {
    if (!/^[0-9a-f]{1,4}$/i.test(x)) return NaN
    return parseInt(x, 16)
  }
  const h = head.map(parse)
  const t = tail.map(parse)
  if ([...h, ...t].some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null
  if (halves.length === 1) return h.length === 8 ? h : null
  const missing = 8 - h.length - t.length
  if (missing < 1) return null
  return [...h, ...(Array(missing).fill(0) as number[]), ...t]
}

function ipv4FromGroups(g: number[], offset: number): string {
  return `${g[offset]! >> 8}.${g[offset]! & 255}.${g[offset + 1]! >> 8}.${g[offset + 1]! & 255}`
}

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
    const g = ipv6Groups(ip)
    if (!g) return false
    if (g.every((x) => x === 0)) return true // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
    if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
    if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
    if ((g[0]! & 0xffc0) === 0xfec0) return true // fec0::/10 站点本地（已废弃）
    // IPv4-mapped ::ffff:0:0/96（URL 会把 ::ffff:127.0.0.1 规范成 ::ffff:7f00:1）
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isPrivateIp(ipv4FromGroups(g, 6))
    }
    // 已废弃的 IPv4-compatible ::/96
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIp(ipv4FromGroups(g, 6))
    }
    // NAT64 64:ff9b::/96 映射到内网 IPv4
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return isPrivateIp(ipv4FromGroups(g, 6))
    }
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
