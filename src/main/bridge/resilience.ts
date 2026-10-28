/**
 * 对话韧性纯函数：从 loop 中抽出，便于单元测试。
 */

/**
 * 判断错误是否为「上下文已用完」。
 * 平台信号各不相同：DeepSeek 走 SSE 的 INCOMPLETE，hook 回传 'incomplete'；
 * 其余靠文案兜底。这类失败重试没有意义，必须换会话继续。
 */
export function isContextExhausted(msg: string): boolean {
  return /incomplete|上下文.{0,6}(用完|超限|上限)|context.{0,12}(limit|window|exhaust)|对话过长|token.{0,6}(上限|超限)|maximum context/i.test(
    msg
  )
}

export interface RetryConfig {
  delayMinMs: number
  delayMaxMs: number
  delay429Ms: number
}

/**
 * 第 n 次重试前应等待的毫秒数。
 * 普通失败：delayMin * 2^(n-1)，封顶 delayMax（指数退避，避免打爆平台）；
 * 429 限流：固定使用 delay429Ms（平台要求较长冷却）。
 */
export function backoffDelay(n: number, cfg: RetryConfig, is429: boolean): number {
  if (is429) return cfg.delay429Ms
  const exp = Math.min(cfg.delayMaxMs, cfg.delayMinMs * 2 ** Math.max(0, n - 1))
  return Math.max(cfg.delayMinMs, exp)
}
