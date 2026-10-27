import type { LidowEvent } from './ipc'

/**
 * preload 暴露的原始桥。renderer 通过 api.ts 的 Proxy 包装成类型化 LidowApi。
 */
export interface LidowBridge {
  invoke(method: string, args: unknown[]): Promise<unknown>
  onEvent(cb: (event: LidowEvent) => void): () => void
}

declare global {
  interface Window {
    lidow: LidowBridge
  }
}

export {}
