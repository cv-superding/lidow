import type { SessionMeta } from '@shared/types'

const normAccount = (id?: string): string => (id && id !== '__default__' ? id : '__default__')

export interface SessionListFilter {
  query: string
  /** 当前选择查看的平台 */
  providerId: string
  /** 当前网页标签的平台：用于决定是否进一步按账号隔离 */
  currentProvider: string
  currentAccount?: string
}

/**
 * 纯净模式会话列表过滤：
 * - 永远只显示选中平台的会话（平台隔离）
 * - 正在看的平台再按当前账号隔离（多账号隔离）
 * - 手动切到其他平台时显示该平台全部账号，点击会话会切到对应标签
 */
export function filterSessionList(sessions: SessionMeta[], opts: SessionListFilter): SessionMeta[] {
  const q = opts.query.trim().toLowerCase()
  return sessions.filter((s) => {
    if (opts.providerId && s.providerId !== opts.providerId) return false
    if (opts.providerId && opts.providerId === opts.currentProvider) {
      if (normAccount(s.accountId) !== normAccount(opts.currentAccount)) return false
    }
    return !q || s.title.toLowerCase().includes(q)
  })
}
