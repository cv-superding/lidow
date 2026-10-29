import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Logger } from './infra/log'
import { AppContext } from './app/context'
import { registerHandlers } from './app/handlers'
import { scheduleAutoUpdateCheck, setUpdateEmitter } from './app/platform'
import { disposeRuntimeServices } from './dsh/services'

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

/**
 * 固定 userData 目录名：开发模式（npx electron）默认用 "Electron" 作应用名，
 * 打包版用 productName "Lidow"，两者数据目录不同 → 登录态互不相通
 * （表现为"刚登录过又要重新登录"）。这里在 app ready 前锁定同名目录。
 */
app.setPath('userData', join(app.getPath('appData'), 'Lidow'))
// 不暴露 Chromium 的 Client Hints 品牌列表（其中包含 Electron），
// 否则 Google 登录会按“嵌入式应用”直接拒绝。
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint')
// Windows 任务栏分组/通知归属（与 electron-builder appId 一致）
if (process.platform === 'win32') app.setAppUserModelId('ai.lidow.app')

const ctx = new AppContext()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#101014',
    // 开发模式窗口/任务栏图标：打包版由 electron-builder 写入 exe 图标
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    // Windows/Linux 自绘标题栏（去掉系统标题栏，避免双栏 + 与 thinkrail 风格一致）
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 10 } : undefined,
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
  // 更新状态由 main 统一维护：进度/可用版本经事件推给渲染层
  setUpdateEmitter((state) => ctx.emit({ type: 'update-state', sessionId: '', state }))
  registerHandlers(registerHandler, ctx)

  createWindow()
  scheduleAutoUpdateCheck()
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
  disposeRuntimeServices()
})

process.on('uncaughtException', (err) => {
  Logger.error('app', `未捕获异常: ${err.stack ?? String(err)}`)
})
