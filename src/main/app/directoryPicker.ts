import { BrowserWindow, dialog, webContents, type OpenDialogOptions } from 'electron'

/** 目录选择框是否打开：打开期间不允许其他逻辑把主窗口抢到前面，否则对话框会被压到后面 */
let picking = false

export function isDirectoryPickerOpen(): boolean {
  return picking
}

/** 找 dialog 的父窗口：webview 的 webContents 要回溯到宿主 BrowserWindow */
export function parentWindowFor(webContentsId?: number): BrowserWindow | null {
  if (webContentsId !== undefined) {
    const wc = webContents.fromId(webContentsId)
    const host = wc?.hostWebContents
    const win = host ? BrowserWindow.fromWebContents(host) : wc ? BrowserWindow.fromWebContents(wc) : null
    if (win && !win.isDestroyed()) return win
  }
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/**
 * 统一的目录选择入口。
 * 必须传父窗口：不带 parent 的 showOpenDialog 在 Windows 上可能被主窗口盖住
 * （首次初始化引导悬浮层 + 选择文件夹的实际反馈）。
 */
export async function showDirectoryPicker(parent?: BrowserWindow | null): Promise<string | null> {
  picking = true
  try {
    if (parent?.isMinimized()) parent.restore()
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  } finally {
    picking = false
  }
}
