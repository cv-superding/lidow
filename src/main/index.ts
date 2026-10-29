import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Logger } from './infra/log'
import { AppContext } from './app/context'
import { registerHandlers } from './app/handlers'
import { scheduleAutoUpdateCheck, setUpdateEmitter } from './app/platform'
import { disposeRuntimeServices } from './dsh/services'
import { WebServer } from './web/server'

/** 服务端 Web 版：浏览器访问原生网页 UI，Electron 窗口只做隐藏的网页宿主 */
const WEB_SERVER = process.env.LIDOW_WEB_SERVER === '1'

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

let hostWindow: BrowserWindow | null = null
let webServer: WebServer | null = null

function createWindow(host = false): BrowserWindow {
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png')
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    // Web 版：窗口只作为 AI 网页宿主，不给人看；容器里配合 Xvfb 仍保持渲染活跃
    show: !host || process.env.LIDOW_HOST_VISIBLE === '1',
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#101014',
    // 开发模式与打包/容器模式都使用品牌图标；不能依赖 Electron 默认图标
    icon: iconPath,
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
      webviewTag: true,
      // 隐藏宿主不能走后台节流，否则 webview 里的 AI 页面不响应、回复也不流式
      backgroundThrottling: false
    }
  })

  // Windows 任务栏不总是跟随 BrowserWindow.icon（开发模式尤其会落到 electron.exe 默认图标）。
  // 显式 setIcon + setAppDetails：图标路径必须存在且为 Windows 可读的 ico。
  if (process.platform === 'win32') {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) win.setIcon(image)
    const icoPath = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(__dirname, '../../build/icon.ico')
    win.setAppDetails({
      appId: 'ai.lidow.app',
      appIconPath: icoPath,
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: 'Lidow'
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

app.whenReady().then(async () => {
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
    webServer?.broadcast(event)
  }
  // 更新状态由 main 统一维护：进度/可用版本经事件推给渲染层
  setUpdateEmitter((state) => ctx.emit({ type: 'update-state', sessionId: '', state }))
  registerHandlers(registerHandler, ctx)

  if (WEB_SERVER) {
    /**
     * Web 客户端的会话没有自己的 webview：让隐藏宿主渲染器创建/换绑页面，
     * 主进程只等待 overlay 绑定完成，之后 loop 就能照常按 session 发送。
     */
    const hostAttach = async (sessionId: string): Promise<boolean> => {
      const bound = (): boolean => ctx.overlay.wcIdOfSession(sessionId) !== undefined
      if (bound()) return true
      const win = hostWindow
      if (!win || win.isDestroyed()) return false
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        try {
          win.webContents.send('lidow:event', { type: 'host-open-session', sessionId })
        } catch {
          return false
        }
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 200))
          if (bound()) return true
        }
      }
      Logger.warn('web', `宿主未能绑定会话 ${sessionId}`)
      return false
    }
    registerHandler('hostAttachSession', (sessionId: string) => hostAttach(String(sessionId)))

    const webRoot = app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '../web')
    webServer = new WebServer({
      root: webRoot,
      host: process.env.LIDOW_WEB_HOST || '0.0.0.0',
      port: Number(process.env.LIDOW_WEB_PORT || 6080),
      token: process.env.LIDOW_WEB_TOKEN || undefined,
      invoke: (method, args) => {
        const handler = handlers.get(method)
        if (!handler) throw new Error(`未知 API 方法: ${method}`)
        return handler(...(args as never[]))
      }
    })
    await webServer.listen()
  }

  hostWindow = createWindow(WEB_SERVER)
  scheduleAutoUpdateCheck()
  Logger.info('app', `Lidow 启动完成 v${app.getVersion()}${WEB_SERVER ? '（Web 服务）' : ''}`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) hostWindow = createWindow(WEB_SERVER)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  webServer?.close()
  ctx.jobs.dispose()
  ctx.mcp.disposeAll()
  disposeRuntimeServices()
})

process.on('uncaughtException', (err) => {
  Logger.error('app', `未捕获异常: ${err.stack ?? String(err)}`)
})
