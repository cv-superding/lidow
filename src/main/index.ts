import { app, BrowserWindow, ipcMain, nativeImage, shell, webContents } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Logger } from './infra/log'
import { AppContext } from './app/context'
import { registerHandlers } from './app/handlers'
import { scheduleAutoUpdateCheck, setUpdateEmitter } from './app/platform'
import { disposeRuntimeServices } from './dsh/services'
import { WebServer } from './web/server'
import { createOpenAiHandler, type OpenAiHost } from './web/openaiApi'
import { BUILT_IN_PROVIDERS } from './providers/registry'
import type { Session } from '@shared/types'

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
// 开发/测试可用 LIDOW_USER_DATA 指向临时目录，避免碰到真实用户数据
const userDataOverride = app.isPackaged ? '' : process.env.LIDOW_USER_DATA
app.setPath(
  'userData',
  userDataOverride ? join(userDataOverride) : join(app.getPath('appData'), 'Lidow')
)
// 不暴露 Chromium 的 Client Hints 品牌列表（其中包含 Electron），
// 否则 Google 登录会按“嵌入式应用”直接拒绝。
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint')

const APP_ID = 'ai.lidow.app'
// 开发模式必须用独立 AUMID，并在开始菜单里放一个同 AUMID 的快捷方式（图标=build/icon.ico）：
// Win11 任务栏按 AUMID 查找快捷方式图标，直接跑 electron.exe 且无快捷方式时会回落到原子图标。
const RUN_APP_ID = app.isPackaged ? APP_ID : `${APP_ID}.dev`
if (process.platform === 'win32') app.setAppUserModelId(RUN_APP_ID)

/**
 * 单实例：同一份 userData 上的 Cookie/LocalStorage 只能被一个 Chromium 进程持有。
 * 多开时后启动的实例拿不到这些存储，所有平台都会显示未登录、重新登录也存不下来。
 * 必须在创建任何窗口/会话之前抢锁；拿不到就把已有实例的窗口叫回前台。
 */
const singleInstanceLock = app.requestSingleInstanceLock()

const ctx = new AppContext()

/** 等待宿主渲染器打开并绑定会话（Web/API 共用）；隐藏宿主不会抢用户当前标签 */
async function waitForHostBind(sessionId: string, win: BrowserWindow | null): Promise<boolean> {
  const bound = (): boolean => ctx.overlay.wcIdOfSession(sessionId) !== undefined
  if (bound()) return true
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
  Logger.warn('api', `宿主未能绑定会话 ${sessionId}`)
  return false
}

/** /v1 模型 = 当前可用平台（当前项目注册表；没有项目时回退内置平台） */
function apiModels(): { id: string; name: string }[] {
  const project = ctx.activeProject() ?? ctx.projectsSnapshot().find((p) => !p.missing) ?? null
  const list = project ? ctx.providerRegistryOf(project.id).list() : BUILT_IN_PROVIDERS
  return list.filter((p) => p.enabled !== false).map((p) => ({ id: p.id, name: p.name }))
}

function apiResolveProject(ref?: string): { id: string; name: string } | null {
  const projects = ctx.projectsSnapshot().filter((p) => !p.missing)
  if (ref) {
    const hit = projects.find((p) => p.id === ref || p.root === ref || p.name === ref)
    return hit ? { id: hit.id, name: hit.name } : null
  }
  const active = ctx.activeProject()
  const project = active && !active.missing ? active : projects[0]
  return project ? { id: project.id, name: project.name } : null
}

const openAiHost: OpenAiHost = {
  listModels: apiModels,
  resolveProject: apiResolveProject,
  createSession(projectId, providerId, accountId) {
    const handler = handlers.get('createSession')
    if (!handler) throw new Error('createSession 未注册')
    // 未指定账号时优先当前账号；有显式账号列表就取第一个，避免落到未登录的隐式默认分区
    let account = accountId
    if (!account) {
      const provider = ctx.providerRegistryOf(projectId).get(providerId)
      account = provider?.activeAccountId ?? provider?.accounts[0]?.id
    }
    return (handler as (...args: unknown[]) => Session)(projectId, providerId, undefined, account)
  },
  getSession: (sessionId) => ctx.sessionOf(sessionId),
  ensureAttached: (sessionId) => waitForHostBind(sessionId, apiHostWindow ?? hostWindow),
  run: (sessionId, text) => {
    ctx.lastSessionId = sessionId
    return ctx.loop.run(sessionId, text)
  },
  stop: (sessionId) => ctx.loop.stop(sessionId, 'all'),
  onEvent: (listener) =>
    ctx.onEvent((event) => {
      if (event.type !== 'turn-chunk') return
      listener({
        type: event.type,
        sessionId: event.sessionId,
        text: typeof event.text === 'string' ? event.text : undefined
      })
    })
}

/**
 * 桌面版内置 HTTP API：按设置启停；独立隐藏宿主窗口承载网页会话。
 * 默认只监听 127.0.0.1，必须配置 Token；端口/Token/开关变更后自动重启。
 */
async function syncApiServer(): Promise<void> {
  if (WEB_SERVER) return
  const cfg = ctx.settings.get().apiServer
  const enabled = Boolean(cfg?.enabled)
  const host = String(cfg?.host || '127.0.0.1').trim() || '127.0.0.1'
  const port = Math.max(1, Math.min(65535, Number(cfg?.port) || 6080))
  const token = String(cfg?.token || '').trim()
  const key = `${enabled}|${host}|${port}|${token}`
  if (key === apiServerKey) return

  if (apiServer) {
    try {
      apiServer.close()
    } catch {
      /* 已关闭 */
    }
    apiServer = null
  }
  if (apiHostWindow && !apiHostWindow.isDestroyed()) apiHostWindow.destroy()
  apiHostWindow = null
  apiServerKey = key
  apiStatusError = ''
  if (!enabled) return
  if (!token) {
    apiStatusError = '请先生成访问 Token'
    ctx.emit({
      type: 'notice',
      sessionId: '',
      level: 'warn',
      message: 'HTTP API 未启动：请先在设置里生成 Token'
    })
    return
  }

  apiHostWindow = createWindow(true)
  // 完全隐藏会让 Chromium 把页面判为 hidden，overlay 的 DOM 轮询会被节流；
  // 移到屏幕外并显示，页面保持 visible，回复检测和流式都正常。
  apiHostWindow.setSkipTaskbar(true)
  apiHostWindow.setPosition(-20_000, -20_000)
  apiHostWindow.showInactive()
  apiHostWindow.on('closed', () => {
    apiHostWindow = null
  })
  const server = new WebServer({
    root: app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '../web'),
    host,
    port,
    token,
    invoke: (method, args) => {
      const handler = handlers.get(method)
      if (!handler) throw new Error(`未知 API 方法: ${method}`)
      return handler(...(args as never[]))
    },
    openai: createOpenAiHandler(openAiHost)
  })
  try {
    await server.listen()
    apiServer = server
    ctx.emit({
      type: 'notice',
      sessionId: '',
      level: 'info',
      message: `HTTP API 已启动：http://${host}:${port}/v1`
    })
    Logger.info('api', `HTTP API 监听 http://${host}:${port}/v1`)
  } catch (e) {
    apiStatusError = e instanceof Error ? e.message : String(e)
    try {
      server.close()
    } catch {
      /* 未监听 */
    }
    if (apiHostWindow && !apiHostWindow.isDestroyed()) apiHostWindow.destroy()
    apiHostWindow = null
    ctx.emit({
      type: 'notice',
      sessionId: '',
      level: 'error',
      message: `HTTP API 启动失败：${apiStatusError}`
    })
    Logger.warn('api', `HTTP API 启动失败: ${apiStatusError}`)
  }
}

let hostWindow: BrowserWindow | null = null
let webServer: WebServer | null = null
let apiServer: WebServer | null = null
let apiHostWindow: BrowserWindow | null = null
let apiServerKey = ''
let apiStatusError = ''
/** 启动流程是否已经创建过主窗口：避免启动期间 second-instance 抢先再建一个 */
let mainWindowStarted = false

/** 已有实例收到第二次启动：把主窗口调回前台（窗口可能已被关闭，只剩 API 隐藏宿主） */
function revealMainWindow(): void {
  if (WEB_SERVER || !app.isReady()) return
  if (hostWindow && !hostWindow.isDestroyed()) {
    if (hostWindow.isMinimized()) hostWindow.restore()
    hostWindow.show()
    hostWindow.focus()
    return
  }
  // 启动还没走到建窗口那一步（如正在 await API 服务监听）：
  // 此时再建会与启动流程各建一个窗口，直接交给启动流程即可
  if (!mainWindowStarted) return
  hostWindow = createWindow(false)
  attachMainWindowLifecycle(hostWindow)
}

/**
 * 退出前把 Cookie / DOMStorage 落盘。
 * DeepSeek 等平台的登录 token 在 localStorage，异常退出或更新重启时最容易丢。
 */
function flushSessionStorage(): void {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed()) continue
      wc.session.flushStorageData()
      void wc.session.cookies.flushStore().catch(() => undefined)
    } catch {
      /* 存储服务已关闭 */
    }
  }
}

function onMainWindowClosed(): void {
  hostWindow = null
  // 关闭主窗口就退出：HTTP API 的隐藏宿主窗口还在时 window-all-closed 不会触发，
  // 旧进程会静默驻留并继续独占 Chromium 配置目录，之后启动的实例全部变成未登录。
  if (!WEB_SERVER && process.platform !== 'darwin') app.quit()
}

/** 主窗口生命周期：关窗即退出（桌面版），并在销毁前发起一次存储落盘 */
function attachMainWindowLifecycle(win: BrowserWindow): void {
  // closed 之后 webContents 已销毁，flush 就成了空操作，必须在 close 时先发起
  win.on('close', () => flushSessionStorage())
  if (!WEB_SERVER) win.on('closed', onMainWindowClosed)
}

function createWindow(host = false): BrowserWindow {
  const pngIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
  const icoIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico')
  // 任务栏按 16/24/32px 取图标，Windows 用多尺寸 ICO 才不会拿到模糊或被缩放的位图
  const iconPath = process.platform === 'win32' ? icoIconPath : pngIconPath
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    // Web 版：窗口只作为 AI 网页宿主，不给人看；容器里配合 Xvfb 仍保持渲染活跃
    show: !host || process.env.LIDOW_HOST_VISIBLE === '1',
    minWidth: 960,
    minHeight: 620,
    // 浅色底：切标签/网页重载时 webview 表面会短暂重建，深色底会闪一下黑屏
    backgroundColor: '#f5f6f8',
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
      // 内置 PDF 查看器需要 plugins；渲染层只加载本地界面，不加载远程页面
      plugins: true,
      // 隐藏宿主不能走后台节流，否则 webview 里的 AI 页面不响应、回复也不流式
      backgroundThrottling: false
    }
  })

  // 任务栏图标由 AUMID 对应的快捷方式提供；setIcon 同时兜底标题栏/Alt+Tab。
  // setAppDetails 只给正式版：开发版没有注册表项，固定到 ai.lidow.app 会串到正式版。
  if (process.platform === 'win32') {
    const image = nativeImage.createFromPath(icoIconPath)
    if (!image.isEmpty()) win.setIcon(image)
    if (app.isPackaged) {
      win.setAppDetails({
        appId: RUN_APP_ID,
        appIconPath: icoIconPath,
        appIconIndex: 0,
        relaunchCommand: process.execPath,
        relaunchDisplayName: 'Lidow'
      })
    }
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 渲染层/网页可能触发 window.open；只允许 http(s) 交给系统浏览器，
    // file:// 或自定义协议（ms-*/vbscript 等）一律不执行
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

if (!singleInstanceLock) {
  // 已有实例：直接退出，绝不能在同一个 userData 上再起一个 Chromium
  Logger.warn('app', '检测到已运行的 Lidow 实例，本次启动退出并唤起已有窗口')
  app.quit()
} else {
  app.on('second-instance', () => revealMainWindow())
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return
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
  registerHandlers(registerHandler, ctx, { onSettingsChanged: () => void syncApiServer() })

  const invokeApi = (method: string, args: unknown[]): unknown => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`未知 API 方法: ${method}`)
    return handler(...(args as never[]))
  }
  registerHandler('hostAttachSession', (sessionId: string) =>
    waitForHostBind(String(sessionId), WEB_SERVER ? hostWindow : apiHostWindow)
  )
  registerHandler('getApiStatus', () => {
    if (WEB_SERVER) {
      return {
        mode: 'web' as const,
        running: true,
        host: process.env.LIDOW_WEB_HOST || '0.0.0.0',
        port: Number(process.env.LIDOW_WEB_PORT || 6080),
        error: ''
      }
    }
    const cfg = ctx.settings.get().apiServer
    return {
      mode: 'desktop' as const,
      running: Boolean(apiServer),
      host: cfg?.host || '127.0.0.1',
      port: Number(cfg?.port || 6080),
      error: apiStatusError
    }
  })

  if (WEB_SERVER) {
    const webToken = process.env.LIDOW_WEB_TOKEN || undefined
    webServer = new WebServer({
      root: app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '../web'),
      host: process.env.LIDOW_WEB_HOST || '0.0.0.0',
      port: Number(process.env.LIDOW_WEB_PORT || 6080),
      token: webToken,
      invoke: invokeApi,
      openai: createOpenAiHandler(openAiHost)
    })
    if (!webToken) {
      Logger.warn(
        'web',
        'Web 版未设置 LIDOW_WEB_TOKEN：接口仅靠 Sec-Fetch-Site 挡住浏览器跨站请求，远程访问请务必配置 Token'
      )
    }
    await webServer.listen()
  }

  hostWindow = createWindow(WEB_SERVER)
  mainWindowStarted = true
  attachMainWindowLifecycle(hostWindow)
  await syncApiServer()
  scheduleAutoUpdateCheck()
  Logger.info('app', `Lidow 启动完成 v${app.getVersion()}${WEB_SERVER ? '（Web 服务）' : ''}`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      hostWindow = createWindow(WEB_SERVER)
      attachMainWindowLifecycle(hostWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // 兜底：正常退出时尽量把登录态写回磁盘（页面关闭后 webContents 已销毁，
  // 这里只覆盖仍在运行的会话）
  flushSessionStorage()
  webServer?.close()
  ctx.jobs.dispose()
  ctx.mcp.disposeAll()
  disposeRuntimeServices()
})

process.on('uncaughtException', (err) => {
  Logger.error('app', `未捕获异常: ${err.stack ?? String(err)}`)
})
