import type { LidowApi, LidowEvent } from '@shared/ipc'

/**
 * 类型化 IPC 客户端：把 window.lidow.invoke 桥包装成完整 LidowApi。
 * 新增 IPC 方法只需扩展 shared/ipc.ts 的 LidowApi 与 main 的 handler，此处零改动。
 */
export const api: LidowApi = new Proxy({} as LidowApi, {
  get(_target, method: string) {
    if (method === 'onEvent') {
      return (cb: (e: LidowEvent) => void): (() => void) => window.lidow.onEvent(cb)
    }
    if (method === 'quit') {
      return (): void => void window.lidow.invoke('quit', [])
    }
    return (...args: unknown[]): unknown => window.lidow.invoke(method, args)
  }
})
