import {
  app,
  BrowserWindow,
  dialog,
  shell,
  nativeTheme,
  session as electronSession,
  webContents
} from 'electron'
import type { OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AppContext } from './context'
import type { IpcHandler } from '../index'
import { TodoBoard } from '@main/ecosystem/todos'
import { BUILT_IN_PROVIDERS } from '@main/providers/registry'
import { runTerminal } from '@main/tools/terminal'
import { deleteWebChat as removeWebChat } from '@main/bridge/webChatDelete'
import { deleteChatsInHiddenPage } from '@main/bridge/webChatDeleteHidden'
import { parentWindowFor, showDirectoryPicker } from '@main/app/directoryPicker'
import { isProjectRootAvailable } from '@main/app/projectFs'
import { IMAGE_EXTS, savePastedImages } from './pasteImages'
import { Logger } from '@main/infra/log'
import { isAbsoluteProjectPath } from '@shared/path'
import type {
  DomAdapter,
  McpServerConfig,
  ProviderDescriptor,
  QuickCommand,
  SkillDraft,
  StopLevel
} from '@shared/types'

/** 主题令牌 → Chromium nativeTheme：嵌入网页经 prefers-color-scheme 跟随应用主题 */
function applyNativeTheme(theme: unknown): void {
  // 主题映射：light/graphite 是浅色系，dark/midnight 是深色系，system 跟随系统。
  // 旧版 warm（暖沙）已废弃并迁移为 graphite。
  const LIGHT_THEMES = new Set(['light', 'graphite', 'warm'])
  const DARK_THEMES = new Set(['dark', 'midnight'])
  const key = String(theme ?? 'dark')
  const t =
    key === 'system'
      ? 'system'
      : LIGHT_THEMES.has(key)
        ? 'light'
        : DARK_THEMES.has(key)
          ? 'dark'
          : 'dark'
  if (nativeTheme.themeSource !== t) nativeTheme.themeSource = t
}

/** 平台上传附件/生成缩略图是异步的，注入后留一点时间 */
const ATTACH_SETTLE_MS = 1800

/**
 * 把本机文件注入网页的 file input：附件按钮与剪贴板粘贴共用。
 * 页面里可能有多个 input，按 accept 挑一个匹配的，再用 CDP 写入。
 */
async function attachFilesToWebInput(wcId: number, filePaths: string[]): Promise<void> {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) throw new Error('网页已关闭，请重新打开')
  const exts = filePaths.map((p) => p.split('.').pop()?.toLowerCase() ?? '')
  const wantImage = exts.length > 0 && exts.every((e) => IMAGE_EXTS.has(e))
  const inputCount = (await wc
    .executeJavaScript(
      `(() => {
      const xs = [...document.querySelectorAll('input[type=file]')].filter((el) => !el.disabled)
      if (!xs.length) return 0
      document.querySelectorAll('[data-lidow-upload-input]').forEach((el) => el.removeAttribute('data-lidow-upload-input'))
      const exts = ${JSON.stringify(exts)}
      const wantImage = ${wantImage ? 'true' : 'false'}
      const accepts = (el) => {
        if (!el.accept) return true
        const a = String(el.accept).toLowerCase()
        if (a.includes('*') || a.includes('file')) return true
        if (wantImage && a.includes('image')) return true
        return exts.some((e) => e && a.includes(e))
      }
      const pick = xs.find(accepts) || xs[0]
      pick.setAttribute('data-lidow-upload-input', '1')
      return xs.length
    })()`
    )
    .catch(() => 0)) as number
  if (!inputCount) throw new Error('网页输入区没有文件上传入口，请先在 AI 页面点一次附件按钮')
  let attached = false
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      attached = true
    }
    const doc = (await wc.debugger.sendCommand('DOM.getDocument', { depth: 1 })) as {
      root?: { nodeId?: number }
    }
    const rootId = doc?.root?.nodeId
    if (!rootId) throw new Error('无法读取网页 DOM')
    const found = (await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: rootId,
      selector: 'input[data-lidow-upload-input]'
    })) as { nodeId?: number }
    if (!found?.nodeId) throw new Error('未找到文件输入框')
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      files: filePaths,
      nodeId: found.nodeId
    })
  } catch (e) {
    Logger.warn('session', `附加文件失败: ${e instanceof Error ? e.message : String(e)}`)
    throw new Error(`附加文件失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
  } finally {
    try {
      void wc.executeJavaScript(
        `document.querySelectorAll('[data-lidow-upload-input]').forEach((el) => el.removeAttribute('data-lidow-upload-input'))`
      )
    } catch {
      /* 页面已关闭 */
    }
    try {
      if (attached && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* 已断开 */
    }
  }
  await new Promise((r) => setTimeout(r, ATTACH_SETTLE_MS))
}

/** 附件缩略图：图片小于 2MB 时回传 data URL，供纯模式输入框显示预览 */
const PREVIEW_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

function describeWebFiles(paths: string[]): { path: string; name: string; preview?: string }[] {
  return paths.map((file) => {
    const name = basename(file)
    const mime = PREVIEW_MIME[extname(file).slice(1).toLowerCase()]
    if (!mime) return { path: file, name }
    try {
      if (statSync(file).size > 2 * 1024 * 1024) return { path: file, name }
      return {
        path: file,
        name,
        preview: `data:${mime};base64,${readFileSync(file).toString('base64')}`
      }
    } catch {
      return { path: file, name }
    }
  })
}

/** 全量 IPC 方法注册：方法名 = LidowApi 契约方法名（renderer Proxy 按 name 调用） */
export function registerHandlers(
  register: (name: string, fn: IpcHandler) => void,
  ctx: AppContext,
  hooks?: { onSettingsChanged?: () => void }
): void {
  const R = register

  applyNativeTheme(ctx.settings.get().theme)
  // ---------- 应用 ----------
  R('getAppState', () => ({
    projects: ctx.projectsSnapshot(),
    activeProjectId: ctx.activeProjectId(),
    settings: ctx.settings.get(),
    version: app.getVersion()
  }))
  R('updateSettings', (...args: unknown[]) => {
    const patch = args[0] as Record<string, unknown>
    const next = ctx.settings.set(patch as never)
    ctx.hotkeys.applyAll()
    applyNativeTheme(next.theme)
    // 每轮注入开关/系统提示词变化后，已经打开的网页 hook 立即生效
    ctx.refreshProviderHooks()
    hooks?.onSettingsChanged?.()
    return next
  })
  R('pickDirectory', () => showDirectoryPicker(parentWindowFor()))
  R('openProject', (root: string) => {
    const r = String(root ?? '')
    // POSIX（Docker/macOS）路径是 /xxx，不能只认 Windows 盘符
    if (!isAbsoluteProjectPath(r, process.platform === 'win32' ? 'win32' : 'posix')) {
      throw new Error('无效的项目路径: ' + r)
    }
    const opened = ctx.openProject(r)
    // 多客户端（桌面 + Web）场景：其他渲染层也要同步项目切换
    ctx.emit({ type: 'projects-changed', sessionId: '' })
    return opened
  })
  R('relocateProject', (projectId: string, root: string) => {
    const r = String(root ?? '')
    if (!isAbsoluteProjectPath(r, process.platform === 'win32' ? 'win32' : 'posix')) {
      throw new Error('无效的项目路径: ' + r)
    }
    const project = ctx.relocateProject(String(projectId), r)
    ctx.emit({ type: 'projects-changed', sessionId: '' })
    return project
  })
  R('closeProject', (projectId: string) => ctx.closeProject(String(projectId)))
  R('removeProject', async (projectId: string, deleteWebChats?: boolean) => {
    const id = String(projectId)
    const project = ctx.projects.find((p) => p.id === id)
    if (!project) return { removed: false, webDeleted: 0, webFailed: 0, message: '项目已移除' }
    if (ctx.activeProjectId() === id && ctx.projectAvailable(id)) {
      throw new Error('请先切换到其他项目，再移除当前项目')
    }
    const refs = deleteWebChats ? ctx.projectChatRefs(id) : []
    const outcomes = new Map<string, { ok: boolean; reason?: string }>()
    type HiddenGroup = { partition: string; home: string; refs: typeof refs }
    const hiddenGroups = new Map<string, HiddenGroup>()
    const queueHidden = (ref: (typeof refs)[number]): void => {
      const partition = ctx.projectChatPartition(ref)
      const home =
        ctx.projectChatHome(ref) ||
        BUILT_IN_PROVIDERS.find((p) => p.id === ref.providerId)?.home ||
        ''
      const key = `${partition}|${home}`
      const group = hiddenGroups.get(key) ?? { partition, home, refs: [] }
      group.refs.push(ref)
      hiddenGroups.set(key, group)
    }
    const succeed = (ref: (typeof refs)[number]): void => {
      ctx.forgetProjectChat(ref.url)
      ctx.clearSessionWebUrl(ref.sessionId)
    }

    for (const ref of refs) {
      // 已打开的网页优先：不用再起隐藏窗口
      const bound = ctx.overlay.wcIdOfSession(ref.sessionId)
      const wcId = bound ?? ctx.webContentsIdForProvider(ref.providerId, ref.accountId)
      const wc = wcId === undefined ? undefined : webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) {
        ctx.markWebChatDeleteInFlight(ref.url)
        const res = await removeWebChat(wc, ref.url, ref.title)
        outcomes.set(ref.url, { ok: res.ok, reason: res.reason })
        if (res.ok) succeed(ref)
        else queueHidden(ref)
        await new Promise((r) => setTimeout(r, 250))
      } else {
        // 没有打开的页面：用该账号的 partition 起隐藏窗口，侧栏删除
        queueHidden(ref)
      }
    }

    for (const group of hiddenGroups.values()) {
      const results = await deleteChatsInHiddenPage(
        group.partition,
        group.home,
        group.refs.map((r) => ({ url: r.url, title: r.title }))
      )
      for (const res of results) {
        outcomes.set(res.url, { ok: res.ok, reason: res.reason })
        if (res.ok) {
          const ref = group.refs.find((r) => r.url === res.url)
          if (ref) succeed(ref)
        }
      }
    }

    const failed = refs.filter((ref) => !outcomes.get(ref.url)?.ok)
    const webDeleted = refs.length - failed.length
    const failedTitles = failed.map((r) => r.title || r.url)
    const parts: string[] = []
    if (deleteWebChats && failed.length > 0) {
      // 网页对话没删干净就不要移除项目：保留索引/本地会话，用户打开平台后可重试
      for (const ref of failed) {
        if (!outcomes.has(ref.url)) outcomes.set(ref.url, { ok: false, reason: '未执行删除' })
      }
      let msg = `项目未移除：${failed.length} 个网页对话删除失败`
      if (failedTitles.length > 0) {
        msg += `（${failedTitles.slice(0, 3).join('、')}${failedTitles.length > 3 ? ' 等' : ''}）`
      }
      msg += '。请打开对应 AI 平台页面后重试，或取消勾选「同时删除」后仅移除项目'
      return { removed: false, webDeleted, webFailed: failed.length, message: msg }
    }

    ctx.removeProject(id, { deleteLocalSessions: Boolean(deleteWebChats) })
    ctx.emit({ type: 'projects-changed', sessionId: '' })

    parts.push(`已移除项目「${project.name}」`)
    if (deleteWebChats) {
      if (webDeleted > 0) parts.push(`；已删除 ${webDeleted} 个网页对话`)
      if (refs.length === 0) parts.push('；没有找到可删除的网页对话')
    } else {
      parts.push('；网页端对话已保留')
    }
    return { removed: true, webDeleted, webFailed: 0, message: parts.join('') }
  })
  R('quit', () => app.quit())

  // ---------- 窗口控制（自绘标题栏） ----------
  R('windowMinimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  R('windowToggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  R('windowClose', () => BrowserWindow.getFocusedWindow()?.close())
  R('windowIsMaximized', () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false)

  // ---------- Provider / 账号 ----------
  R('listProviders', (projectId: string) => {
    // 没有项目时返回内置平台表：用户需要能先进 AI 页面，引导才会出现在网页里。
    // 这些描述是只读副本，不带持久化账号（账号属于具体项目）。
    // 项目目录被删除后也走这条：不能为缺失目录构造 Registry（写 providers.json
    // 会把用户删掉的目录重新建出来）。
    const pid = String(projectId ?? '')
    if (!pid || pid === 'undefined' || !ctx.projectAvailable(pid)) {
      return BUILT_IN_PROVIDERS.filter((p) => p.enabled).map((p) => ({ ...p, accounts: [] }))
    }
    return ctx.providerRegistryOf(pid).list()
  })
  R('addProvider', (...args: unknown[]) => {
    const [projectId, desc] = args as [
      string,
      { id: string; name: string; home: string; adapter?: Partial<ProviderDescriptor['adapter']> }
    ]
    return ctx.providerRegistryOf(String(projectId)).add(desc)
  })
  R('removeProvider', (projectId: string, providerId: string) =>
    ctx.providerRegistryOf(String(projectId)).remove(String(providerId))
  )
  R('addAccount', (projectId: string, providerId: string, label: string) => {
    const reg = ctx.providerRegistryOf(String(projectId))
    reg.addAccount(String(providerId), String(label ?? ''))
    // 返回完整 provider（与 ipc 类型一致）：调用方据此拿到新账号 id 并立即打开它
    return reg.get(String(providerId))
  })
  R('switchAccount', (projectId: string, providerId: string, accountId: string) => {
    ctx.providerRegistryOf(String(projectId)).switchAccount(String(providerId), String(accountId))
    return ctx.providerRegistryOf(String(projectId)).get(String(providerId))
  })
  R('removeAccount', (projectId: string, providerId: string, accountId: string) => {
    const pid = String(projectId)
    const acc = String(accountId)
    const reg = ctx.providerRegistryOf(pid)
    // 该账号下的会话回落到默认分区，避免之后打开时指向一个已被删除的账号
    const sessions = ctx.sessionStoreOf(pid)
    for (const m of sessions.list()) {
      if (m.accountId === acc) sessions.update(m.id, (s) => ({ ...s, accountId: '__default__' }))
    }
    reg.removeAccount(String(providerId), acc)
    return reg.get(String(providerId))
  })
  R(
    'updateProviderAdapter',
    (projectId: string, providerId: string, adapter: ProviderDescriptor['adapter']) =>
      ctx.providerRegistryOf(String(projectId)).update(String(providerId), { adapter })
  )
  /**
   * Web 版登录态：浏览器拿不到系统目录对话框，也没有可操作的网页窗口。
   * 允许把平台登录后的 Cookie 直接写进对应 partition，服务端隐藏宿主随即生效。
   */
  R('importProviderCookies', async (providerId: string, cookieText: string, accountId?: string) => {
    const project = ctx.activeProject()
    if (!project) throw new Error('请先初始化项目')
    const reg = ctx.providerRegistryOf(project.id)
    const provider = reg.get(String(providerId))
    if (!provider) throw new Error(`未知平台: ${String(providerId)}`)
    const pairs = parseCookieInput(String(cookieText ?? ''))
    if (pairs.length === 0) throw new Error('没有解析到有效 Cookie')
    const partition = reg.partitionOf(String(providerId), accountId ? String(accountId) : undefined)
    const origin = new URL(provider.home).origin
    const jar = electronSession.fromPartition(partition)
    let imported = 0
    for (const c of pairs) {
      try {
        await jar.cookies.set({
          url: origin,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure ?? origin.startsWith('https:'),
          expirationDate: c.expirationDate ?? Math.floor(Date.now() / 1000) + 365 * 86400
        })
        imported++
      } catch (e) {
        Logger.warn(
          'provider',
          `Cookie 写入失败 ${c.name}: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    // 已经打开的宿主页面需要重载才能用新登录态
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (wc.getType() === 'webview' && wc.session === jar) wc.reload()
      } catch {
        /* 页面正在销毁 */
      }
    }
    return { imported }
  })

  // ---------- 会话 ----------
  R('listSessions', (projectId: string, providerId?: string) => {
    const id = String(projectId)
    // 项目目录被删除后不能再构造 SessionStore（会重建目录），列表按空处理
    if (!ctx.projectAvailable(id)) return []
    return ctx.sessionStoreOf(id).list(providerId ? String(providerId) : undefined)
  })
  R('getSession', (sessionId: string) => ctx.sessionOf(String(sessionId)))
  R('createSession', (...args: unknown[]) => {
    const [projectId, providerId, parentSessionId, accountId] = args as [
      string,
      string,
      string?,
      string?
    ]
    if (!ctx.projectAvailable(String(projectId)))
      throw new Error('项目目录不存在，请到「工作区」重新选择目录')
    const store = ctx.sessionStoreOf(String(projectId))
    // 新建前回收同平台的历史空会话（0 轮次）：点一次平台建一次会话，
    // 用户没发消息就切走的话，列表会被「新会话」堆满（实测堆过 11 个）
    if (!parentSessionId) {
      for (const m of store.list()) {
        if (m.providerId !== String(providerId)) continue
        if (m.id === ctx.lastSessionId) continue
        // 正在被网页承载 / 正在执行的会话不能删：删了之后回复会落进不存在的会话
        if (ctx.overlay.wcIdOfSession(m.id) !== undefined) continue
        if (ctx.loop.runningSessionIds().includes(m.id)) continue
        const s = store.get(m.id)
        // 只看 turns 会误删「只在网页里聊过」的会话（没有本地轮次但有 providerUrl）
        if (s && s.turns.length === 0 && !s.providerUrl && !s.systemPromptSent) store.delete(m.id)
      }
    }
    return store.create(
      String(projectId),
      String(providerId),
      parentSessionId,
      accountId ? String(accountId) : undefined
    )
  })
  /** 清理空会话（0 轮次）：新建后从未发送的会话会无限堆积 */
  R('cleanupEmptySessions', (projectId: string, keepSessionId?: string) => {
    const pid = String(projectId)
    if (!ctx.projectAvailable(pid)) return 0
    const store = ctx.sessionStoreOf(pid)
    let removed = 0
    for (const m of store.list()) {
      if (m.id === keepSessionId) continue
      // 正在被网页承载 / 正在执行的会话不能删：删了之后回复会落进不存在的会话
      if (ctx.overlay.wcIdOfSession(m.id) !== undefined) continue
      if (ctx.loop.runningSessionIds().includes(m.id)) continue
      const s = store.get(m.id)
      if (s && s.turns.length === 0 && !s.providerUrl && !s.systemPromptSent) {
        ctx.overlay.unbindSession(m.id)
        store.delete(m.id)
        removed++
      }
    }
    return removed
  })
  R('deleteSession', async (sessionId: string, deleteWebChat?: boolean) => {
    const sid = String(sessionId)
    const session = ctx.sessionOf(sid)
    const project = findProjectOfSession(ctx, sid)
    const boundWcId = ctx.overlay.wcIdOfSession(sid)
    // 当前会话没绑定网页时，用同平台/同账号的网页执行删除；
    // 否则用户切到别的会话后，删除旧会话就永远删不到网页端。
    const wcId =
      boundWcId ??
      (session ? ctx.webContentsIdForProvider(session.providerId, session.accountId) : undefined)
    // 先停掉正在跑的任务：否则循环后续 appendTurn 会写进已删除的会话
    ctx.loop.stop(sid, 'all')

    let webDeleted: boolean | undefined
    let message = '本地会话已删除（网页端历史保留，页面已切到新对话）'
    // 默认双向删除；显式传 false 才只删本地（兼容旧调用）
    if (deleteWebChat !== false) {
      if (!session?.providerUrl) {
        webDeleted = false
        message = '本地会话已删除；该会话还没有对应的网页端对话'
      } else if (wcId === undefined) {
        webDeleted = false
        message = '本地会话已删除；网页未连接，网页端对话需要手动删除'
      } else {
        const wc = webContents.fromId(wcId)
        // 自动删除也会点网页里的「删除」，标记后忽略 overlay 的反向回调
        ctx.markWebChatDeleteInFlight(session.providerUrl)
        const res = wc
          ? await removeWebChat(wc, session.providerUrl, session.title)
          : { ok: false, reason: '网页已关闭' }
        webDeleted = res.ok
        message = res.ok
          ? '会话已删除（含网页端对话）'
          : `本地会话已删除；网页端删除失败：${res.reason ?? '未知原因'}`
        Logger.info(
          'session',
          `网页端删除 session=${sid.slice(-6)} ok=${res.ok}${res.reason ? ` reason=${res.reason}` : ''}`
        )
      }
    }

    ctx.overlay.unbindSession(sid)
    // 网页对话确认已删：索引同步移除；删除失败/只删本地时保留索引，
    // 以后移除项目仍可再尝试清理网页端。
    if (webDeleted === true) ctx.forgetProjectChat(session?.providerUrl)
    if (project) {
      const store = ctx.sessionStoreOf(project)
      store.delete(sid)
      // 广播给所有窗口：即使删除动作来自 IPC/其它窗口，纯净模式列表也要同步消失
      ctx.emit({ type: 'session-deleted', sessionId: sid, title: session?.title ?? '' })
      // 已没有“带轮次”的会话 → 项目回到未初始化，网页需要重新出现初始化入口
      const stillInitialized = store.list().some((m) => {
        const s = store.get(m.id)
        return Boolean(s && (s.turns.length > 0 || s.providerUrl || s.systemPromptSent))
      })
      if (!stillInitialized) ctx.resetProjectInitialization(project, wcId)
    }
    // 离开被删除的对话：否则网页仍停留在已删除会话，甚至继续接管后续消息。
    // 延迟一点，让 reset-first-run 的 localStorage 清理先落盘（页面随后可能 SPA 跳转）。
    if (boundWcId !== undefined) {
      setTimeout(() => ctx.overlay.sendCmdToWebContents(boundWcId, { kind: 'new-chat' }), 200)
    }
    if (wcId !== undefined) ctx.syncChatWatchToWebview(wcId)
    return { webDeleted, message }
  })
  R('renameSession', (sessionId: string, title: string) => {
    const sid = String(sessionId)
    const project = findProjectOfSession(ctx, sid)
    if (project) {
      ctx.sessionStoreOf(project).rename(sid, String(title))
      // 同步所有 Lidow 窗口（桌面纯净模式 / Web 版）的会话列表与当前标题
      ctx.emit({ type: 'session-updated', sessionId: sid })
    }
    const wcId = ctx.overlay.wcIdOfSession(sid)
    if (wcId !== undefined) ctx.syncProjectFoldersToWebview(wcId)
  })
  R('startProjectSession', (sessionId: string) => ctx.startProjectSession(String(sessionId)))
  R('compactSession', (sessionId: string) => {
    ctx.loop.compactNow(String(sessionId))
    return ctx.sessionOf(String(sessionId))
  })

  // ---------- Agent 循环 ----------
  R('sendPrompt', (sessionId: string, text: string) => {
    ctx.lastSessionId = String(sessionId)
    void ctx.loop.run(String(sessionId), String(text))
    void ctx.sync.pushAll(`Lidow 收到新任务：${String(text).slice(0, 200)}`)
  })
  R('stop', (sessionId: string, level: StopLevel) => {
    const sid = String(sessionId ?? '')
    if (sid) ctx.loop.stop(sid, (level ?? 'all') as StopLevel)
    else ctx.stopAll((level ?? 'all') as StopLevel)
  })
  R('newChat', (sessionId: string) => {
    ctx.overlay.sendCmd(String(sessionId), { kind: 'new-chat' })
  })
  R('confirmTool', (callId: string, approved: boolean) => {
    ctx.resolveConfirm(String(callId), Boolean(approved))
  })
  R(
    'confirmPlan',
    (
      sessionId: string,
      approved: boolean,
      edits?: { id: string; title: string; detail: string }[]
    ) => {
      const sid = String(sessionId)
      if (!approved) {
        ctx.plans.abort(sid)
        return
      }
      // 确认后必须让 AI 真正开始执行：否则它停在「等待确认」的答复上，
      // 用户点了确认也看不到任何后续动作。
      const plan = ctx.plans.confirm(sid, edits)
      if (!plan) return
      ctx.lastSessionId = sid
      void ctx.loop.run(
        sid,
        '用户已确认计划，请按顺序执行计划中的各项任务；每完成一项更新 todoWrite，全部完成后给出总结。'
      )
    }
  )
  R('abortPlan', (sessionId: string) => {
    const sid = String(sessionId)
    ctx.plans.abort(sid)
    ctx.loop.stop(sid, 'all')
  })
  R('getActivePlan', (sessionId: string) => ctx.plans.activeOf(String(sessionId)))

  // ---------- 人机共用待办看板 ----------
  const boardOf = (): TodoBoard => {
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    return new TodoBoard(project.root)
  }
  R('listTodos', () => boardOf().list())
  R('addTodo', (title: string) => {
    boardOf().add(String(title))
    return boardOf().list()
  })
  R(
    'setTodoStatus',
    (id: string, status: 'pending' | 'running' | 'done' | 'failed' | 'skipped') => {
      boardOf().setStatus(String(id), status)
      return boardOf().list()
    }
  )
  R('clearDoneTodos', () => {
    boardOf().clearDone()
    return boardOf().list()
  })

  // ---------- 会话导出 ----------
  R('exportSession', (sessionId: string) => {
    const session = ctx.sessionOf(String(sessionId))
    if (!session) throw new Error('会话不存在')
    // 导出到会话所属项目的 .lidow/exports（多项目时不能用活动项目）
    const project = ctx.projects.find((p) => p.id === session.projectId) ?? ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    const md = [
      `# ${session.title}`,
      ``,
      `- 平台：${session.providerId}`,
      `- 导出时间：${new Date().toLocaleString()}`,
      `- 轮次：${session.turns.length}${session.compactedTurns > 0 ? `（已压缩 ${session.compactedTurns} 轮）` : ''}`,
      ``,
      `---`,
      ``,
      ...session.turns.map((t) => {
        const role =
          t.role === 'user' ? '## 🧑 用户' : t.role === 'assistant' ? '## 🤖 AI' : '## ⚙️ 系统'
        const tools =
          t.toolResults
            ?.map((r) => `> 工具 ${r.name} → ${r.ok ? '✓' : '✗'} ${r.durationMs}ms`)
            .join('\n') ?? ''
        return `${role}\n\n${t.text}\n${tools ? `\n${tools}\n` : ''}`
      })
    ].join('\n')
    const dir = join(project.root, '.lidow', 'exports')
    mkdirSync(dir, { recursive: true })
    const safeName = session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'session'
    const file = join(dir, `${safeName}-${session.id.slice(-6)}.md`)
    writeFileSync(file, md, 'utf-8')
    return file
  })

  // ---------- 顶栏工具 ----------
  R('revealPath', async (target: string) => {
    const p = String(target ?? '')
    if (!p || !existsSync(p)) return false
    shell.showItemInFolder(p)
    return true
  })
  R('openExportDir', () => {
    const project = ctx.activeProject()
    if (!project) throw new Error('请先打开项目')
    if (!isProjectRootAvailable(project.root))
      throw new Error('项目目录不存在，请到「工作区」重新选择目录')
    const dir = join(project.root, '.lidow', 'exports')
    mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
    return dir
  })
  R('terminalCwd', () => ctx.activeProject()?.root ?? process.cwd())
  R('listTools', () => ctx.tools.all().map((t) => ({ name: t.name, description: t.description })))
  /** 用外部程序打开项目：explorer / vscode / pycharm / terminal */
  R('openInApp', async (appId: string, target: string) => {
    const dir = String(target ?? '')
    if (!dir) throw new Error('没有项目目录')
    const { spawn } = await import('node:child_process')
    const map: Record<string, [string, string[]]> = {
      explorer: [process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [dir]],
      vscode: ['code', [dir]],
      pycharm: ['pycharm64.exe', [dir]],
      terminal: [
        process.platform === 'win32' ? 'powershell.exe' : 'bash',
        process.platform === 'win32'
          ? ['-NoExit', '-Command', `Set-Location -LiteralPath '${dir}'`]
          : ['-i']
      ]
    }
    const [bin, args] = map[String(appId)] ?? map.explorer!
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore', cwd: dir })
      child.unref()
      return true
    } catch {
      return false
    }
  })
  R('openExternal', async (url: string) => {
    const u = String(url ?? '')
    // 只放行 http(s)，避免 file:// 或自定义协议被执行
    if (!/^https?:\/\//i.test(u)) return false
    await shell.openExternal(u)
    return true
  })
  R('runTerminal', async (command: string, cwd?: string) => {
    const project = ctx.activeProject()
    const root = project?.root ?? process.cwd()
    // 只允许在项目目录内执行（终端面板不提供越界能力）
    let workdir = root
    const raw = String(cwd ?? '')
    if (raw) {
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
      if (resolved.startsWith(resolve(root))) workdir = resolved
    }
    return runTerminal(String(command ?? ''), workdir)
  })

  // ---------- 工具 / 文件 ----------
  R('readFileTree', (projectId: string, dir: string, depth: number) => {
    const project = ctx.projects.find((p) => p.id === String(projectId))
    return project ? ctx.readFileTree(project.root, String(dir ?? ''), Number(depth ?? 3)) : []
  })
  R('readFileContent', (projectId: string, relPath: string) => {
    const project = ctx.projects.find((p) => p.id === String(projectId))
    if (!project) throw new Error('项目不存在')
    const abs = resolve(join(project.root, String(relPath)))
    const rel = relative(project.root, abs)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径越界')
    const raw = readFileSync(abs, 'utf-8')
    if (raw.includes('\u0000')) return '（二进制文件，暂不支持预览）'
    // 大文件全量塞进渲染进程会卡死：预览截断到 300k
    return raw.length > 300_000 ? `${raw.slice(0, 300_000)}\n\n…[文件过大，预览已截断]` : raw
  })
  R('openPathInSystem', (path: string) => {
    const p = String(path ?? '')
    if (!p || !existsSync(p)) throw new Error('目录不存在，请到「工作区」重新选择目录')
    void shell.openPath(p)
  })

  // ---------- 生态 ----------
  const skillImports = () => import('@main/ecosystem/skills')
  R('listSkills', () => skillImports().then((m) => m.listSkills(ctx.activeProject()?.root)))
  R('getSkillDir', (scope: 'project' | 'user') =>
    skillImports().then((m) =>
      m.skillsDirForScope(scope === 'project' ? 'project' : 'user', ctx.activeProject()?.root)
    )
  )
  R('createSkill', (input: SkillDraft) =>
    skillImports().then((m) => m.createSkill(input, ctx.activeProject()?.root))
  )
  R('updateSkill', (path: string, input: SkillDraft) =>
    skillImports().then((m) => m.updateSkill(String(path), input, ctx.activeProject()?.root))
  )
  R('setSkillEnabled', (path: string, enabled: boolean) =>
    skillImports().then((m) =>
      m.setSkillEnabled(String(path), Boolean(enabled), ctx.activeProject()?.root)
    )
  )
  R('trashSkill', (path: string) =>
    skillImports().then((m) => m.trashSkill(String(path), ctx.activeProject()?.root))
  )
  R('listSkillTrash', () => skillImports().then((m) => m.listSkillTrash(ctx.activeProject()?.root)))
  R('restoreSkillTrash', (id: string) =>
    skillImports().then((m) => m.restoreSkillTrash(String(id), ctx.activeProject()?.root))
  )
  R('purgeSkillTrash', (id: string) =>
    skillImports().then((m) => m.purgeSkillTrash(String(id), ctx.activeProject()?.root))
  )
  R('installSkillsFromGitHub', (url: string, scope: 'project' | 'user', category?: string) =>
    import('@main/ecosystem/skillInstall').then((m) =>
      m.installSkillsFromGitHub(
        {
          url: String(url),
          scope: scope === 'project' ? 'project' : 'user',
          category: category ? String(category) : undefined
        },
        ctx.activeProject()?.root
      )
    )
  )
  R('listExternalSkills', () =>
    skillImports().then((m) => m.listExternalSkills(ctx.activeProject()?.root))
  )
  R('importExternalSkills', (paths: string[], scope: 'project' | 'user', category?: string) =>
    skillImports().then((m) =>
      m.importExternalSkills(
        Array.isArray(paths) ? paths.map(String) : [],
        scope === 'project' ? 'project' : 'user',
        ctx.activeProject()?.root,
        category ? String(category) : undefined
      )
    )
  )
  R('listAgents', () => skillImports().then((m) => m.listAgents(ctx.activeProject()?.root)))
  R('listRules', () => skillImports().then((m) => m.listRules(ctx.activeProject()?.root)))
  R('readSkill', (path: string) =>
    skillImports().then((m) => m.readSkill(String(path), ctx.activeProject()?.root))
  )
  R('listMemory', () => ctx.memory.list())
  R('addMemory', (title: string, content: string, tags: string[]) =>
    ctx.memory.add(String(title), String(content), (tags as string[]) ?? [], 'manual')
  )
  R('deleteMemory', (id: string) => ctx.memory.remove(String(id)))

  // ---------- MCP ----------
  R('listMcpServers', () => ctx.mcp.listServers())
  R('addMcpServer', async (cfg: McpServerConfig) => {
    const list = ctx.mcp.addServer(cfg)
    try {
      await ctx.mcp.connect(String(cfg.name))
    } catch {
      /* 连接失败保留配置，UI 提示 */
    }
    return list
  })
  R('removeMcpServer', (name: string) => ctx.mcp.removeServer(String(name)))
  R('listMcpTools', () => ctx.mcp.listTools())

  // ---------- 插件 ----------
  R('listInstalledPlugins', () => ctx.plugins.list())
  R('listBuiltinPlugins', () => ctx.plugins.listBuiltins())
  R('searchMarket', (query: string, category?: string) =>
    ctx.plugins.searchMarket(String(query ?? ''), category ? String(category) : undefined)
  )
  R('installPlugin', async (id: string) => {
    const [source, repo] = String(id).split(':')
    if (source === 'builtin') {
      ctx.plugins.installBuiltin(String(repo ?? id))
    } else {
      await ctx.plugins.install(repo ?? String(id), source === 'gitee' ? 'gitee' : 'github')
    }
    await ctx.loadAllPlugins()
    return ctx.plugins.list()
  })
  R('uninstallPlugin', (id: string) => {
    ctx.plugins.uninstall(String(id))
    // 已加载的 DSH 服务没有卸载通道，需要重启才彻底失效（如实提示）
    void ctx.loadAllPlugins()
    return ctx.plugins.list()
  })
  R('togglePlugin', (id: string, enabled: boolean) => {
    ctx.plugins.toggle(String(id), Boolean(enabled))
    void ctx.loadAllPlugins()
    return ctx.plugins.list()
  })

  // ---------- DSH ----------
  R('dshCoverage', () => ctx.dshCoverage())
  R('getTokenStats', () => ctx.tokenStats())

  // ---------- 任务 / 审计 ----------
  R('listAudit', (sessionId?: string, limit?: number) =>
    ctx.audit.list(sessionId ? String(sessionId) : undefined, Number(limit ?? 200))
  )
  R('revertAudit', (entryId: string) => ctx.audit.revert(String(entryId)))

  // ---------- 知识库 ----------
  R('listKnowledgeBases', () => ctx.knowledge.list())
  R('addKnowledgeBase', (name: string, root: string) =>
    ctx.knowledge.add(String(name), String(root))
  )
  R('removeKnowledgeBase', (id: string) => ctx.knowledge.remove(String(id)))
  R('searchKnowledge', (kbId: string, query: string, limit?: number) =>
    ctx.knowledge.search(String(kbId), String(query), Number(limit ?? 5))
  )

  // ---------- 快捷指令 ----------
  R('listQuickCommands', () => ctx.quickCommands.list())
  R('saveQuickCommand', (cmd: QuickCommand) => ctx.quickCommands.save(cmd))
  R('deleteQuickCommand', (id: string) => ctx.quickCommands.remove(String(id)))

  // ---------- 视图 ----------
  R('attachWebview', (providerId: string, accountId: string) => {
    if (!providerId || typeof providerId !== 'string')
      throw new Error('attachWebview 缺少 providerId')
    const overlayPath = join(__dirname, '../preload/overlay.js')
    const project = ctx.activeProject()
    // 没有项目时也允许打开 AI 页面：初始化引导由 overlay 注入在网页里
    // （cuckoo 的 first-time-dialog 同款位置）。挡在外面的话用户永远看不到引导。
    if (!project) {
      const p = BUILT_IN_PROVIDERS.find((x) => x.id === String(providerId))
      if (!p) throw new Error(`未知平台: ${String(providerId)}`)
      return {
        // partition 格式必须与 partitionOf 完全一致（persist:lidow-<id>-default），
        // 否则先无项目登录、后开项目会拿到两个不同分区，登录态凭空丢失
        partition: `persist:lidow-${p.id}-default`,
        overlayPath,
        home: p.home,
        // 无项目也要下发 adapter：overlay 靠它判断登录态，
        // 而首次引导必须等"登录完成"才弹
        adapter: p.adapter
      }
    }
    const reg = ctx.providerRegistryOf(project.id)
    if (!reg.get(String(providerId))) throw new Error(`未知平台: ${String(providerId)}`)
    return {
      partition: reg.partitionOf(String(providerId), accountId ? String(accountId) : undefined),
      overlayPath,
      home: reg.get(String(providerId))?.home ?? ''
    }
  })
  R('bindSession', (sessionId: string, webContentsId: number) => {
    const sid = String(sessionId)
    const wcId = Number(webContentsId)
    const prev = ctx.overlay.sessionOfWebContents(wcId)
    // 单个 webview 只能承载一个会话：换绑会把原会话正在跑的任务踢下车，
    // 明确提示而不是让用户以为任务还在后台继续
    if (prev && prev !== sid && ctx.loop.isRunning(prev)) {
      ctx.emit({
        type: 'notice',
        sessionId: prev,
        level: 'warn',
        message: '原会话正在执行任务：切换到其他会话后该任务无法继续'
      })
    }
    // 换绑时清理被抛弃的空会话（0 轮次）：否则每点一次「新建任务」又切走，
    // 侧栏就多一个空壳会话，看起来像多了几个对话窗口。
    if (prev && prev !== sid && !ctx.loop.isRunning(prev)) {
      const prevSession = ctx.sessionOf(prev)
      // 有网页对话地址或已发过提示词的空会话不是“空壳”，不能当垃圾清理
      if (
        prevSession &&
        prevSession.turns.length === 0 &&
        !prevSession.providerUrl &&
        !prevSession.systemPromptSent
      ) {
        const prevProject = findProjectOfSession(ctx, prev)
        if (prevProject) ctx.sessionStoreOf(prevProject).delete(prev)
        ctx.overlay.unbindSession(prev)
        ctx.emit({ type: 'session-updated', sessionId: prev })
      }
    }
    ctx.overlay.bindSession(sid, wcId)
    const boundSession = ctx.sessionOf(sid)
    if (boundSession)
      ctx.registerWebviewProvider(wcId, boundSession.providerId, boundSession.accountId)
    ctx.configureOverlay(sid)
    // 首次绑定/换绑必须把页面落到该会话自己的对话：
    // 新会话没有 providerUrl → 切到新对话，避免它继承网页当前那条旧对话
    // （否则会出现两个 Lidow 会话指向同一个网页对话）。
    if (prev !== sid) void ctx.landSession(sid)
  })
  /**
   * 还没有会话时（无项目也能进 AI 页面）给网页侧下发运行所需配置：
   * DOM adapter（登录态轮询依赖它）+ 当前项目目录（决定是否弹首次引导）。
   * 按 webContentsId 下发，不依赖会话绑定。
   */
  /** 让页面落到指定会话自己的对话（有 providerUrl 导航回原对话，否则开新聊天） */
  R('landSession', (sessionId: string) => ctx.landSession(String(sessionId)))
  R(
    'syncProjectToWebview',
    (webContentsId: number, adapter?: unknown, providerId?: string, accountId?: string) => {
      const id = Number(webContentsId)
      if (providerId)
        ctx.registerWebviewProvider(
          id,
          String(providerId),
          accountId ? String(accountId) : undefined
        )
      // 渲染层可能还没拿到 adapter（无会话时 tab 记录可能是空的）。
      // 按 providerId 精确查表，不要随便拿一个平台的 adapter ——
      // 每个平台的 avatar 选择器不同，用错会导致登录态误判。
      let ad = adapter as DomAdapter | undefined
      if (!ad && providerId) {
        ad = ctx.activeProject()
          ? ctx.providerRegistryOf(ctx.activeProject()!.id).get(String(providerId))?.adapter
          : BUILT_IN_PROVIDERS.find((p) => p.id === String(providerId))?.adapter
      }
      if (ad) ctx.overlay.sendCmdToWebContents(id, { kind: 'configure', adapter: ad })
      const project = ctx.activeProject()
      const root = project?.root ?? null
      // 没有绑定会话 = 新开的网页/新窗口：即使项目已有历史，也给一个初始化入口，
      // 否则用户无法把新对话接到当前项目（只能看一个没有 Lidow 引导的空白页）。
      ctx.syncChatWatchToWebview(id)
      return ctx.overlay.sendCmdToWebContents(id, {
        kind: 'set-project',
        projectRoot: root,
        initialized: ctx.settings.get().pureMode
      })
    }
  )
  /** 透传网页内交互命令（深度思考/智能搜索/上传文件） */
  R(
    'overlayToggle',
    (sessionId: string, kind: 'toggle-think' | 'toggle-search' | 'upload-file') => {
      return ctx.overlay.sendCmd(String(sessionId), { kind })
    }
  )
  /**
   * 桌面纯模式：本机选文件后直接写入网页的 file input。
   * 不能只点 input[type=file]：纯模式下网页被遮住，平台原生文件框会弹在后面；
   * 用 CDP DOM.setFileInputFiles 注入才会真正进入平台的附件流程（图片/文档通用）。
   */
  R('uploadWebFile', async (sessionId: string) => {
    const sid = String(sessionId)
    const wcId = ctx.overlay.wcIdOfSession(sid)
    if (wcId === undefined) throw new Error('网页未连接：请先打开该会话的 AI 页面')
    const wc = webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) throw new Error('网页已关闭，请重新打开')
    const options: OpenDialogOptions = {
      title: '选择要附加到对话的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
        {
          name: '文档',
          extensions: [
            'pdf',
            'doc',
            'docx',
            'xls',
            'xlsx',
            'ppt',
            'pptx',
            'txt',
            'md',
            'csv',
            'json'
          ]
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const parent = parentWindowFor(wcId)
    const res = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    await attachFilesToWebInput(wcId, res.filePaths)
    return {
      ok: true,
      count: res.filePaths.length,
      files: describeWebFiles(res.filePaths),
      message: `已附加 ${res.filePaths.length} 个文件到网页输入框，发送消息即可一起上传`
    }
  })
  /**
   * 纯模式输入框 Ctrl+V 粘贴图片：渲染层把剪贴板图片读成 data URL 传来，
   * 落盘后走和附件按钮相同的 CDP 注入，平台才会显示附件预览并随消息上传。
   */
  R('pasteWebImages', async (sessionId: string, images: unknown) => {
    const sid = String(sessionId)
    const wcId = ctx.overlay.wcIdOfSession(sid)
    if (wcId === undefined) throw new Error('网页未连接：请先打开该会话的 AI 页面')
    const files = savePastedImages(images, join(app.getPath('userData'), 'attachments'))
    if (files.length === 0) return { ok: false, message: '剪贴板里没有可附加的图片' }
    await attachFilesToWebInput(wcId, files)
    return {
      ok: true,
      count: files.length,
      files: describeWebFiles(files),
      message: `已附加 ${files.length} 张图片到网页输入框，发送消息即可一起上传`
    }
  })
  /** 按文案点击平台自带按钮（底部 chip 转发，各平台功能不同） */
  R('overlayAction', (sessionId: string, keywords: string[]) => {
    return ctx.overlay.sendCmd(String(sessionId), {
      kind: 'click-keywords',
      keywords: keywords ?? []
    })
  })
  R('setPureMode', (on: boolean) => {
    ctx.settings.set({ pureMode: Boolean(on) })
    // 退出纯净模式后重新评估首次引导：纯净模式下网页被对话面板遮住，
    // 弹窗只会藏在后面；退出后新会话需要正常提示一次初始化。
    if (ctx.lastSessionId) ctx.configureOverlay(ctx.lastSessionId)
  })
  R('checkUpdate', (manual?: boolean) => ctx.updateCheck(Boolean(manual)))
  R('getUpdateState', () => import('@main/app/platform').then((m) => m.getUpdateState()))
  R('downloadUpdate', () => import('@main/app/platform').then((m) => m.downloadAndInstallUpdate()))
  R('listTemplates', () => ctx.templates())
  R('applyTemplate', (templateId: string, root: string) =>
    ctx.applyTemplate(String(templateId), String(root))
  )
  R('pushToSync', (text: string) => ctx.pushSync(String(text)))
}

interface CookieInput {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  expirationDate?: number
}

/** 支持浏览器 DevTools 的 Cookie 请求头，也支持导出的 JSON Cookie 数组 */
function parseCookieInput(raw: string): CookieInput[] {
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text) as unknown
      if (!Array.isArray(arr)) return []
      return arr
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof item.name === 'string' && item.name && 'value' in item)
        .map((item) => ({
          name: String(item.name),
          value: String(item.value ?? ''),
          domain: typeof item.domain === 'string' && item.domain ? item.domain : undefined,
          path: typeof item.path === 'string' && item.path ? item.path : undefined,
          secure: typeof item.secure === 'boolean' ? item.secure : undefined,
          expirationDate: typeof item.expirationDate === 'number' ? item.expirationDate : undefined
        }))
    } catch {
      return []
    }
  }
  const out: CookieInput[] = []
  for (const part of text.split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (!name || /^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) continue
    out.push({ name, value })
  }
  return out
}

function findProjectOfSession(ctx: AppContext, sessionId: string): string | null {
  for (const p of ctx.projects) {
    try {
      if (ctx.sessionStoreOf(p.id).get(sessionId)) return p.id
    } catch {
      /* 项目目录不存在：跳过 */
    }
  }
  return null
}
