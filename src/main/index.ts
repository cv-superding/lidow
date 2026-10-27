import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Logger } from './infra/log'
import { AppContext } from './app/context'
import { registerHandlers } from './app/handlers'

/**
 * main 进程入口：生命周期 + IPC 分发器。
 * 业务经 registerHandler(name, fn) 注册，renderer 统一 lidow:invoke(method,args)。
 */
const handlers = new Map<string, IpcHandler>()

/** never[] 参数逆变：允许具体签名的函数直接注册 */
export type IpcHandler = (...args: never[]) => unknown

function registerHandler(name: string, fn: IpcHandler): void {
  const existing = handlers.get(name)
  if (existing) Logger.warn('ipc', `handler 覆盖: ${name}`)
  handlers.set(name, fn)
}

const ctx = new AppContext()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
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
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  mkdirSync(join(userData, 'logs'), { recursive: true })
  Logger.init(join(userData, 'logs'))

  ipcMain.handle('lidow:invoke', (_event, method: string, args: unknown[]) => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`未知 IPC 方法: ${method}`)
    return handler(...((Array.isArray(args) ? args : []) as never[]))
  })

  ctx.init()
  ctx.emitFn = (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('lidow:event', event)
    }
  }
  registerHandlers(registerHandler, ctx)

  createWindow()
  Logger.info('app', `Lidow 启动完成 v${app.getVersion()}`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  ctx.jobs.dispose()
  ctx.mcp.disposeAll()
})

process.on('uncaughtException', (err) => {
  Logger.error('app', `未捕获异常: ${err.stack ?? String(err)}`)
})
