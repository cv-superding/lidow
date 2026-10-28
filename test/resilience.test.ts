import { describe, expect, it } from 'vitest'
import { isContextExhausted, backoffDelay } from '@main/bridge/resilience'

describe('上下文耗尽判定', () => {
  it('识别 DeepSeek 的 incomplete 信号', () => {
    expect(isContextExhausted('incomplete')).toBe(true)
    expect(isContextExhausted('stream ended: INCOMPLETE')).toBe(true)
  })

  it('识别中英文上下文超限文案', () => {
    expect(isContextExhausted('上下文已用完，请开启新对话')).toBe(true)
    expect(isContextExhausted('对话过长，超出模型限制')).toBe(true)
    expect(isContextExhausted('This model has a maximum context length')).toBe(true)
  })

  it('普通错误不误判为上下文耗尽', () => {
    expect(isContextExhausted('网页未连接（平台页面未加载完成）')).toBe(false)
    expect(isContextExhausted('AI 回复为空')).toBe(false)
    expect(isContextExhausted('network error')).toBe(false)
  })
})

describe('重试退避计算', () => {
  const cfg = { delayMinMs: 4000, delayMaxMs: 10000, delay429Ms: 120000 }

  it('指数退避并封顶', () => {
    expect(backoffDelay(1, cfg, false)).toBe(4000)
    expect(backoffDelay(2, cfg, false)).toBe(8000)
    expect(backoffDelay(3, cfg, false)).toBe(10000) // 16000 被封顶
    expect(backoffDelay(9, cfg, false)).toBe(10000)
  })

  it('429 使用专用长等待，不参与指数退避', () => {
    expect(backoffDelay(1, cfg, true)).toBe(120000)
    expect(backoffDelay(5, cfg, true)).toBe(120000)
  })
})
