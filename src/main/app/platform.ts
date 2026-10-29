import { app, globalShortcut } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Logger } from '@main/infra/log'
import type { UpdateState } from '@shared/ipc'
// 必须用静态 import：打包后 `await import('electron-updater')` 的命名空间里
// autoUpdater 是 defineProperty getter，动态导入拿不到（实测 v0.4.0：
// Cannot set properties of undefined (setting 'autoDownload')）。
import { autoUpdater, type AppUpdater } from 'electron-updater'

/**
 * 全局热键：设置里可自定义（默认 Alt+Shift+L 唤起、Alt+Shift+N 新会话、Alt+Shift+S 中止全部）。
 * action 由 handlers 层注册执行器。
 */
export class HotkeyManager {
  private actions = new Map<string, () => void>()

  constructor(private getHotkeys: () => Record<string, string>) {}

  registerAction(action: string, fn: () => void): void {
    this.actions.set(action, fn)
  }

  applyAll(): void {
    globalShortcut.unregisterAll()
    for (const [action, accelerator] of Object.entries(this.getHotkeys())) {
      if (!accelerator) continue
      try {
        globalShortcut.register(accelerator, () => {
          Logger.info('hotkey', `触发 ${action}`)
          this.actions.get(action)?.()
        })
      } catch (e) {
        Logger.warn('hotkey', `注册失败 ${accelerator}: ${String(e)}`)
      }
    }
  }

  static defaults(): Record<string, string> {
    return {
      'show-window': 'Alt+Shift+L',
      'new-session': 'Alt+Shift+N',
      'stop-all': 'Alt+Shift+S',
      'toggle-pure': 'Alt+Shift+P'
    }
  }
}

const RELEASES_URL = 'https://github.com/cv-superding/lidow/releases'

/** 便携版无法自更新（electron-updater 已知限制）：引导去 Releases 页手动下载 */
export function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

// ---------- 应用内更新 ----------
//
// 状态集中在 main：启动自动检查可能早于渲染层订阅，渲染层通过
// getUpdateState 补拉一次；下载进度用 update-state 事件推送，
// 不再用 notice 文本刷屏（也无法驱动进度条）。

let updateState: UpdateState = { phase: 'idle', portable: isPortable() }
let updateEmitter: ((state: UpdateState) => void) | null = null
let updaterWired = false
let autoCheckTimer: NodeJS.Timeout | null = null
/** Docker 镜像版本固定，应用内自动更新不可用；通过重建镜像升级 */
const UPDATES_DISABLED = process.env.LIDOW_DISABLE_UPDATE === '1'

function publishUpdate(patch: Partial<UpdateState>): UpdateState {
  updateState = { ...updateState, ...patch, portable: isPortable() }
  updateEmitter?.(updateState)
  return updateState
}

export function setUpdateEmitter(fn: (state: UpdateState) => void): void {
  updateEmitter = fn
}

export function getUpdateState(): UpdateState {
  return updateState
}

/** 统一挂一次 electron-updater 监听：重复挂会重复 quitAndInstall / 重复进度事件 */
async function wireUpdater(autoUpdater: AppUpdater): Promise<void> {
  if (updaterWired) return
  updaterWired = true
  // 关键：默认 autoDownload=true 会在 check 时静默后台下载，进度条和“是否更新”
  // 的提示都会失效；必须改成用户点「立即更新」后才下载。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => publishUpdate({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    publishUpdate({ phase: 'available', version: info.version, message: '' })
  )
  autoUpdater.on('update-not-available', () => publishUpdate({ phase: 'up-to-date' }))
  autoUpdater.on('download-progress', (p) =>
    publishUpdate({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, p.percent)),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdate({ phase: 'downloaded', version: info.version, percent: 100, message: '下载完成，正在重启安装…' })
    // 稍等让渲染层把「下载完成」画出来，再退出安装；isForceRunAfter=true 安装后自动启动
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (e) {
        Logger.warn('updater', `退出安装失败: ${String(e)}`)
      }
    }, 1500)
  })
  autoUpdater.on('error', (e) => {
    publishUpdate({ phase: 'error', message: e?.message ?? String(e) })
  })
}

/** 应用内自动更新（electron-updater，GitHub Releases；开发环境静默跳过） */
export async function checkForUpdate(
  manual = false
): Promise<{ hasUpdate: boolean; version?: string; url?: string; portable?: boolean }> {
  if (UPDATES_DISABLED) {
    publishUpdate({ phase: 'idle', manual, message: 'Docker 部署请更新镜像' })
    return { hasUpdate: false, portable: isPortable() }
  }
  if (!app.isPackaged) {
    publishUpdate({ phase: 'idle', manual, message: '开发环境不检查更新' })
    return { hasUpdate: false, portable: isPortable() }
  }
  // 下载中/已下载时重复检查会打断下载，直接回报当前状态
  if (updateState.phase === 'downloading' || updateState.phase === 'downloaded') {
    return { hasUpdate: true, version: updateState.version, url: RELEASES_URL, portable: isPortable() }
  }
  publishUpdate({ phase: 'checking', manual, message: '' })
  try {
    await wireUpdater(autoUpdater)
    await autoUpdater.checkForUpdates()
    // 事件监听已把 phase 写好；这里只按最终状态回包。
    // 通过函数读取：直接读模块变量会被 TypeScript 的窄化误判（前面已排除下载态）。
    const finalState = getUpdateState()
    return {
      hasUpdate:
        finalState.phase === 'available' || finalState.phase === 'downloading' || finalState.phase === 'downloaded',
      version: finalState.version,
      url: RELEASES_URL,
      portable: isPortable()
    }
  } catch (e) {
    Logger.warn('updater', `检查更新失败: ${String(e)}`)
    publishUpdate({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    return { hasUpdate: false, portable: isPortable() }
  }
}

/**
 * 下载更新并自动安装。
 * - 安装版：electron-updater 下载（进度经 update-state 推送）→ quitAndInstall
 * - 便携版 / 开发环境：打开 Releases 页（便携版无法原地替换自身）
 */
export async function downloadAndInstallUpdate(): Promise<{ ok: boolean; message: string }> {
  if (UPDATES_DISABLED) return { ok: false, message: 'Docker 部署请更新镜像' }
  if (isPortable()) {
    const { shell } = await import('electron')
    await shell.openExternal(RELEASES_URL)
    return { ok: true, message: '便携版无法自动替换自身，已在浏览器打开下载页' }
  }
  if (!app.isPackaged) return { ok: false, message: '开发环境不支持自动更新' }
  if (updateState.phase === 'downloading') return { ok: true, message: '更新正在下载中…' }
  try {
    await wireUpdater(autoUpdater)
    publishUpdate({ phase: 'downloading', percent: 0, message: '' })
    await autoUpdater.downloadUpdate()
    return { ok: true, message: '下载完成，正在重启安装…' }
  } catch (e) {
    Logger.warn('updater', `下载更新失败: ${String(e)}`)
    const message = `下载失败：${e instanceof Error ? e.message : String(e)}`
    publishUpdate({ phase: 'error', message })
    return { ok: false, message }
  }
}

/** 启动后延迟自动检查一次（打包版；不打断首屏加载） */
export function scheduleAutoUpdateCheck(delayMs = 8000): void {
  if (UPDATES_DISABLED || !app.isPackaged || autoCheckTimer) return
  autoCheckTimer = setTimeout(() => {
    autoCheckTimer = null
    void checkForUpdate(false)
  }, delayMs)
  autoCheckTimer.unref?.()
}

/** 项目模板库：内置 templates/ 目录扫描 */
export interface ProjectTemplate {
  id: string
  name: string
  description: string
  files: { path: string; content: string }[]
}

export function listTemplates(templatesRoot: string): ProjectTemplate[] {
  const out: ProjectTemplate[] = []
  try {
    for (const dir of readdirSync(templatesRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const tplDir = join(templatesRoot, dir.name)
      const manifestPath = join(tplDir, 'template.json')
      if (!existsSync(manifestPath)) continue
      try {
        const meta = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name: string; description: string }
        const files: ProjectTemplate['files'] = []
        collectFiles(tplDir, tplDir, files)
        out.push({ id: dir.name, name: meta.name, description: meta.description, files })
      } catch {
        /* skip */
      }
    }
  } catch {
    /* templates 目录不存在 */
  }
  return out
}

function collectFiles(root: string, dir: string, out: ProjectTemplate['files']): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(root, full, out)
    } else {
      const rel = full.slice(root.length + 1)
      try {
        out.push({ path: rel, content: readFileSync(full, 'utf-8') })
      } catch {
        /* binary 模板文件忽略 */
      }
    }
  }
}

export function templateSummaryName(p: string): string {
  return basename(p)
}
