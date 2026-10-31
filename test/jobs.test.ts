import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobScheduler } from '@main/infra/jobs'

describe('JobScheduler 非法时间兜底', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('非法每日时间不递归空转', () => {
    vi.useFakeTimers()
    const scheduler = new JobScheduler()
    let runs = 0
    scheduler.setRunner(async () => {
      runs++
    })
    scheduler.create('bad-daily', { kind: 'daily', at: '99:99' }, 'echo')
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000)
    expect(runs).toBe(0)
    scheduler.dispose()
  })

  it('intervalMs=NaN 回退到 60 秒而不是 1ms 死循环', () => {
    vi.useFakeTimers()
    const scheduler = new JobScheduler()
    let runs = 0
    scheduler.setRunner(async () => {
      runs++
    })
    scheduler.create('bad-interval', { kind: 'interval', intervalMs: Number.NaN }, 'echo')
    vi.advanceTimersByTime(59_000)
    expect(runs).toBe(0)
    vi.advanceTimersByTime(2_000)
    expect(runs).toBe(1)
    scheduler.dispose()
  })
})
