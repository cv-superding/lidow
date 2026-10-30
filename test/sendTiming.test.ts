import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quietWindow, remainingSendDelay } from '@main/bridge/sendTiming'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

import { OverlayManager } from '@main/bridge/overlayManager'

function makeManager(
  intervalMs: number,
  lastActivityAt?: number
): {
  manager: OverlayManager
  sendNow: ReturnType<typeof vi.fn>
} {
  const manager = new OverlayManager()
  const channel = {
    webContentsId: 1,
    streamBuf: '',
    chunkResolvers: new Set(),
    replyResolvers: new Set(),
    sendResolvers: new Set(),
    lastActivityAt
  }
  const internal = manager as unknown as {
    channels: Map<number, unknown>
    bindings: Map<string, number>
    waitForChannel: () => Promise<unknown>
    sendNow: ReturnType<typeof vi.fn>
  }
  internal.channels.set(1, channel)
  internal.bindings.set('s', 1)
  internal.waitForChannel = async () => channel
  internal.sendNow = vi.fn(async () => undefined)
  manager.setSendIntervalProvider(() => intervalMs)
  return { manager, sendNow: internal.sendNow }
}

describe('sendToPage 的回复后间隔', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('5 秒设置：在最后活动后 5 秒才发送，不受固定 1.5 秒静默窗口限制', async () => {
    const { manager, sendNow } = makeManager(5_000, 9_000)
    void manager.sendToPage('s', 'next')
    await vi.advanceTimersByTimeAsync(1_400)
    expect(sendNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_700)
    expect(sendNow).toHaveBeenCalledTimes(1)
  })

  it('1 秒设置：回复静默 1 秒后发送', async () => {
    const { manager, sendNow } = makeManager(1_000, 9_800)
    void manager.sendToPage('s', 'next')
    await vi.advanceTimersByTimeAsync(600)
    expect(sendNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(sendNow).toHaveBeenCalledTimes(1)
  })

  it('页面从未活动时立即发送', async () => {
    const { manager, sendNow } = makeManager(5_000, undefined)
    void manager.sendToPage('s', 'first')
    await vi.advanceTimersByTimeAsync(1)
    expect(sendNow).toHaveBeenCalledTimes(1)
  })
})

describe('网页发送间隔', () => {
  it('回复结束后不足间隔时补足剩余时间', () => {
    expect(remainingSendDelay(1_000, 1_000, 1_400)).toBe(600)
  })

  it('回复结束已超过间隔则不额外等待', () => {
    expect(remainingSendDelay(1_000, 1_000, 5_000)).toBe(0)
  })

  it('页面没有活动记录时直接发送', () => {
    expect(remainingSendDelay(undefined, 1_000, 5_000)).toBe(0)
  })

  it('更长的间隔按最后一次活动补齐', () => {
    expect(remainingSendDelay(1_000, 5_000, 3_000)).toBe(3_000)
  })

  it('静默检测窗口跟随设置，限制在 1–1.5 秒', () => {
    expect(quietWindow(1_000)).toBe(1_000)
    expect(quietWindow(5_000)).toBe(1_500)
    expect(quietWindow(0)).toBe(1_000)
  })
})
