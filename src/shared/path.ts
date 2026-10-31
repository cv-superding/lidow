import { resolve, sep } from 'node:path'

/** 项目根路径校验：Windows 盘符/UNC，macOS/Linux 绝对路径。 */
export function isAbsoluteProjectPath(input: string, platform: 'win32' | 'posix' = 'posix'): boolean {
  const p = (input ?? '').trim()
  if (!p || p === 'undefined' || p === 'null') return false
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p)
  return p.startsWith('/')
}

/**
 * 目标路径是否位于根目录内（含根本身）。
 * 必须按「根 + 分隔符」比较：`C:\proj-evil` 不能被 `C:\proj` 前缀误判为内部。
 */
export function isPathInside(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  const caseInsensitive = process.platform === 'win32'
  const a = caseInsensitive ? r.toLowerCase() : r
  const b = caseInsensitive ? t.toLowerCase() : t
  if (b === a) return true
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}
