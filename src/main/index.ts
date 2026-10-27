import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Logger } from './infra/log'
import { JsonStore } from './infra/store'
import type { AppSettings } from '@shared/types'
import type { LidowEvent } from '@shared/ipc'

/**
 * main 进程入口：生命周期、窗口、IPC 分发器。
 * 业务模块通过 registerHandler 注册 IPC 方法，renderer 统一经
 * lidow:invoke(method, args) 调用，单一通道避免通道名漂移。
 */

export type IpcHandler = (...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()

export function registerHandler(name: string, fn: IpcHandler): void {
  const existing = handlers.get(name)
  if (existing) Logger.warn('ipc', `handler 覆盖: ${name}`)
  handlers.set(name, fn)
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accent: '#5b8cff',
  language: 'zh-CN',
  pureMode: false,
  dangerConfirm: true,
  ssrfProtection: true,
  commandTimeoutMs: 30_000,
  sandboxTimeoutMs: 60_000,
  outputBufferLimit: 1024 * 1024,
  compactThreshold: 60_000,
  autoCompact: true,
  globalHotkeys: {},
  securityMod: { enabled: true, ctfInject: false, refusalRewrite: 'off', maxRewrites: 2 },
  sync: {}
}

let mainWindow: BrowserWindow | null = null
let settingsStore: JsonStore<AppSettings>

function emitEvent(event: LidowEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('lidow:event', event)
  }
}
export { emitEvent }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function bootstrap(): void {
  const userData = app.getPath('userData')
  process.env.LIDOW_USER_DATA = userData
  mkdirSync(join(userData, 'logs'), { recursive: true })
  Logger.init(join(userData, 'logs'))
  settingsStore = new JsonStore<AppSettings>(join(userData, 'settings.json'), DEFAULT_SETTINGS)

  ipcMain.handle('lidow:invoke', async (_event, method: string, args: unknown[]) => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`未知 IPC 方法: ${method}`)
    return handler(...(Array.isArray(args) ? args : []))
  })

  registerHandler('updateSettings', (...args: unknown[]) =>
    settingsStore.set(args[0] as Partial<AppSettings>)
  )
  registerHandler('quit', () => app.quit())
}

app.whenReady().then(() => {
  bootstrap()
  createWindow()
  Logger.info('app', `Lidow 启动完成 v${app.getVersion()}`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (err) => {
  Logger.error('app', `未捕获异常: ${err.stack ?? String(err)}`)
})
