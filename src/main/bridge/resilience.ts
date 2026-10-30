/**
 * 对话韧性纯函数：从 loop 中抽出，便于单元测试。
 */

/**
 * 判断错误是否为「上下文已用完」。
 * 必须只认真正的上下文信号：DeepSeek 的 SSE `INCOMPLETE` 是服务端截断
 * （网络抖动/输出中断），重试后能继续，不能当成上下文耗尽去压缩换会话 ——
 * 否则开着自动续接时，任何一次长回复被截断都会误触发新会话。
 */
export function isContextExhausted(msg: string): boolean {
  return /context_exhausted|上下文.{0,6}(用完|超限|上限)|context.{0,12}(limit|window|exhaust)|对话过长|输入过长|token.{0,6}(上限|超限)|maximum context/i.test(
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
