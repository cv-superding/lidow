/**
 * overlay preload：注入到 AI 网页 webview 内运行。
 * 直接持有 ipcRenderer（沙箱内置 shim），无需 contextBridge——
 * 目标页面不获得任何能力，所有通信经由 main 中转。
 */
import { ipcRenderer } from 'electron'

void ipcRenderer.send('lidow:overlay', { type: 'ready' })
