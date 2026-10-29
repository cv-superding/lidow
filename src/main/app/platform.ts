import { app, globalShortcut } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Logger } from '@main/infra/log'

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

/** 应用内自动更新（electron-updater，GitHub Releases；开发环境静默跳过） */
export async function checkForUpdate(): Promise<{ hasUpdate: boolean; version?: string; url?: string }> {
  if (!app.isPackaged) return { hasUpdate: false }
  try {
    const { autoUpdater } = await import('electron-updater')
    const result = await autoUpdater.checkForUpdates()
    const update = result?.updateInfo
    if (update && update.version !== app.getVersion()) {
      return { hasUpdate: true, version: update.version, url: RELEASES_URL }
    }
    return { hasUpdate: false }
  } catch (e) {
    Logger.warn('updater', `检查更新失败: ${String(e)}`)
    return { hasUpdate: false }
  }
}

/**
 * 下载更新并退出安装。
 * - 安装版：electron-updater 下载 → 进度经事件上抛 → quitAndInstall
 * - 便携版 / 开发环境：打开 Releases 页（便携版无法原地替换自身）
 */
export async function downloadAndInstallUpdate(
  emit: (event: { type: string; [k: string]: unknown }) => void
): Promise<{ ok: boolean; message: string }> {
  if (!app.isPackaged || isPortable()) {
    const { shell } = await import('electron')
    await shell.openExternal(RELEASES_URL)
    return { ok: true, message: '便携版请在浏览器中下载最新版（已打开 Releases 页）' }
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.on('download-progress', (p) => {
      emit({
        type: 'notice',
        sessionId: '',
        level: 'info',
        message: `更新下载中 ${Math.round(p.percent)}%`
      })
    })
    autoUpdater.on('update-downloaded', () => {
      emit({
        type: 'notice',
        sessionId: '',
        level: 'info',
        message: '更新下载完成，即将重启安装…'
      })
      setTimeout(() => void autoUpdater.quitAndInstall(), 1500)
    })
    await autoUpdater.downloadUpdate()
    return { ok: true, message: '更新下载中，完成后将自动重启安装' }
  } catch (e) {
    Logger.warn('updater', `下载更新失败: ${String(e)}`)
    return { ok: false, message: `下载失败：${e instanceof Error ? e.message : String(e)}` }
  }
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
