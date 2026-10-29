/** 项目根路径校验：Windows 盘符/UNC，macOS/Linux 绝对路径。 */
export function isAbsoluteProjectPath(input: string, platform: 'win32' | 'posix' = 'posix'): boolean {
  const p = (input ?? '').trim()
  if (!p || p === 'undefined' || p === 'null') return false
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p)
  return p.startsWith('/')
}
