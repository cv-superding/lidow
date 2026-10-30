import { BrowserWindow } from 'electron'
import { deleteWebChat } from './webChatDelete'
import { Logger } from '@main/infra/log'

export interface HiddenChatDeleteTask {
  url: string
  title: string
}

export interface HiddenChatDeleteResult {
  url: string
  title: string
  ok: boolean
  reason?: string
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const platform =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
const CHROME_UA = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`

/**
 * 没有已打开的 AI 网页时，用该账号的 partition 起一个隐藏窗口，
 * 加载平台首页后按侧栏删除网页对话。删除是 UI 自动化，必须等侧栏出现。
 */
export async function deleteChatsInHiddenPage(
  partition: string,
  home: string,
  tasks: HiddenChatDeleteTask[]
): Promise<HiddenChatDeleteResult[]> {
  if (tasks.length === 0) return []
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    win.webContents.setUserAgent(CHROME_UA)
    const target = home || tasks[0]!.url
    Logger.info('session', `隐藏窗口删除网页对话：partition=${partition} home=${target} tasks=${tasks.length}`)
    await Promise.race([win.loadURL(target).catch(() => undefined), delay(20_000)])
    // 等侧栏历史列表渲染；加载完成不代表 React 列表已挂载
    await delay(2500)
    const results: HiddenChatDeleteResult[] = []
    for (const task of tasks) {
      if (win.webContents.isDestroyed()) {
        results.push({ ...task, ok: false, reason: '后台页面已关闭' })
        continue
      }
      const res = await deleteWebChat(win.webContents, task.url, task.title)
      results.push({ ...task, ok: res.ok, reason: res.reason })
      Logger.info(
        'session',
        `隐藏窗口删除结果：${res.ok ? 'ok' : 'fail'} ${task.url.slice(0, 70)}${res.reason ? ` reason=${res.reason}` : ''}`
      )
      await delay(300)
    }
    return results
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return tasks.map((t) => ({ ...t, ok: false, reason }))
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      /* 窗口已销毁 */
    }
  }
}
