/**
 * 「上一条回复结束后等待 N 秒」的发送节奏计算。
 * 独立成纯函数，避免把 Electron 的 Channel 拖进单测。
 */

/** 从页面最后一次活动算起，还要等多久才能发送下一条 */
export function remainingSendDelay(
  lastActivityAt: number | undefined,
  intervalMs: number,
  now = Date.now()
): number {
  if (!lastActivityAt || intervalMs <= 0) return 0
  return Math.max(0, intervalMs - (now - lastActivityAt))
}

/** 判断回复是否结束的静默窗口：跟随设置，但至少 1 秒、最多 1.5 秒 */
export function quietWindow(intervalMs: number): number {
  return Math.max(1000, Math.min(1500, intervalMs))
}
