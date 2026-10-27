import { contextBridge, ipcRenderer } from 'electron'
import type { LidowEvent } from '@shared/ipc'

/**
 * renderer preload：暴露极小的 invoke/onEvent 桥。
 * 方法级契约在 shared/ipc.ts 的 LidowApi 类型中，renderer 侧用 Proxy 映射，
 * 避免每加一个 IPC 方法就改一遍 preload。
 */
const bridge = {
  invoke: (method: string, args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('lidow:invoke', method, args),
  onEvent: (cb: (event: LidowEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: LidowEvent): void => cb(data)
    ipcRenderer.on('lidow:event', listener)
    return () => {
      ipcRenderer.removeListener('lidow:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('lidow', bridge)
