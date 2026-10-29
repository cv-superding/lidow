/**
 * Lidow Overlay — 注入 AI 网页 webview 的 preload。
 * 职责：DOM 适配（找输入/发送/消息/流式标志）、发送指令、流式监听、
 *       悬浮球（拖拽 + 右键三层停止菜单）、登录态上报。
 * 与 main 的通信：ipcRenderer 直连（沙箱 shim），页面脚本无法访问。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DomAdapter, OverlayCommand, OverlayEvent } from '@shared/types'

let adapter: DomAdapter | null = null

// ---------- 环境硬化（preload 先于页面脚本执行） ----------
// 补全嵌入式 webview 缺失的浏览器特征，缓解平台"使用环境异常"误判
try {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
  Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true })
  Object.defineProperty(Navigator.prototype, 'plugins', {
    get: () => [{ name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
    configurable: true
  })
  type ChromeStub = { runtime?: { connect?: () => void; sendMessage?: () => void } }
  const w = window as unknown as { chrome?: ChromeStub }
  if (!w.chrome) w.chrome = {}
  if (!w.chrome.runtime) w.chrome.runtime = { connect: () => undefined, sendMessage: () => undefined }
} catch {
  /* 页面环境差异忽略 */
}

const send = (event: OverlayEvent): void => {
  try {
    ipcRenderer.send('lidow:overlay', event)
  } catch {
    /* 通道关闭 */
  }
}

// ---------- 通用 DOM 工具 ----------

function visible(el: Element | null | undefined): el is Element {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

/** 拼 innerHTML 前的转义（项目目录来自用户磁盘，不能直接插入标签） */
function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c)
}

function findFirst(selectors: string[], filter?: (el: Element, index: number) => boolean): Element | null {
  if (!selectors) return null
  let seen = 0
  for (const sel of selectors) {
    try {
      const list = document.querySelectorAll(sel)
      for (const el of list) {
        if (visible(el)) {
          if (!filter || filter(el, seen)) return el
          seen++
        }
      }
    } catch {
      /* 无效选择器跳过 */
    }
  }
  return null
}

/** React 受控输入需要 native setter 才能生效 */
function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** contenteditable（ProseMirror/tiptap）：execCommand insertText 与真实键入等价 */
function fillEditable(el: HTMLElement, text: string): boolean {
  el.focus()
  const sel = window.getSelection()
  sel?.selectAllChildren(el)
  document.execCommand('selectAll', false)
  const ok = document.execCommand('insertText', false, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
  return ok && (el.textContent?.length ?? 0) > 0
}

/**
 * 填入后读回校验。
 *
 * 阈值不能按比例：短消息用 90% 会让「在不」只填进「在」也算通过，
 * AI 收到的就是半句话（实测表现：AI 回「你的消息在'在'之后中断了」）。
 * 改为先比"去空白后完全相等"，再退一步容忍编辑器对换行/空行的归一化（99% 且仅差空白）。
 */
function fillVerified(el: Element, text: string): boolean {
  if (el instanceof HTMLTextAreaElement) {
    el.focus()
    setNativeValue(el, text)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    fillEditable(el, text)
  } else if (el instanceof HTMLInputElement) {
    el.focus()
    setNativeValue(el, text)
  } else {
    return false
  }
  const current =
    el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : ((el as HTMLElement).textContent ?? '')
  if (current === text) return true
  // 编辑器可能改写空白/换行（ProseMirror 把 \n 变 <p>），比紧凑形式
  const compact = (s: string): string => s.replace(/\s+/g, '')
  const want = compact(text)
  if (!want) return false
  return compact(current) === want
}

function pressEnter(el: Element): void {
  ;(el as HTMLElement).focus?.()
  const opts: KeyboardEventInit = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true, isComposing: false
  }
  el.dispatchEvent(new KeyboardEvent('keydown', opts))
  el.dispatchEvent(new KeyboardEvent('keypress', opts))
  el.dispatchEvent(new KeyboardEvent('keyup', opts))
}

/**
 * 真实指针点击：先 pointerdown/mousedown → pointerup/mouseup → click。
 * 只派发一次 click（此前先 .click() 又 dispatch click → 同一按钮被点两次，
 * 是"重复发送"的根因之一）。div[role=button] 也能被这串事件正确触发。
 */
function click(el: Element): void {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base: MouseEventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
  const target = el as HTMLElement
  target.focus?.()
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mousedown', base))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mouseup', base))
  const ev = new MouseEvent('click', base) as MouseEvent & { __lidowInternal?: boolean }
  // 标记为 lidow 程序化点击：新对话监听到自己的合成点击时不能再弹引导
  ev.__lidowInternal = true
  el.dispatchEvent(ev)
}

// ---------- 消息/流式监听 ----------

let observer: MutationObserver | null = null
let lastText = ''
let streaming = false
let everFlag = false // 平台是否出现过流式标志（决定是否启用文本稳定兜底判定）
let endTimer: ReturnType<typeof setTimeout> | null = null
let chunkTimer: ReturnType<typeof setTimeout> | null = null
/** 最近一次经 lidow 发出去的文本：部分平台把用户消息也匹配进 bubble，不能当回复 */
let lastSentText = ''

/** 取最后一个可见匹配（消息类选择器用户/AI 共用时，AI 回复必然在最后） */
function findLast(selectors: string[]): Element | null {
  if (!selectors) return null
  for (const sel of selectors) {
    try {
      const list = document.querySelectorAll(sel)
      for (let i = list.length - 1; i >= 0; i--) {
        const el = list[i]
        if (el && visible(el)) return el
      }
    } catch {
      /* 无效选择器跳过 */
    }
  }
  return null
}

function lastBubbleText(): string {
  const container = findFirst(adapter?.messages ?? [])
  // 优先取最后一个气泡（AI 回复在文档流末尾）；退化到整个容器
  const bubble = findLast(adapter?.bubble ?? [])
  if (!bubble) {
    if (!container) return ''
    return (container as HTMLElement).innerText ?? ''
  }
  // markdown 渲染会把 ``` 围栏转成代码块 DOM：遍历时把代码块重包围栏，
  // 否则解析器看不到 ```lidow ... ``` 边界（工具块永远解析失败）
  const el = bubble as HTMLElement
  const clone = el.cloneNode(true) as HTMLElement
  // 思考区不属于回复正文：DOM 兜底时若把 .ds-think-content 一起抓进去，
  // 本地转录里就会「思考整段漏进气泡」（DeepSeek 分享页 DOM 已证实）
  clone
    .querySelectorAll('[class*="think" i], [class*="reasoning" i], [data-testid*="think" i]')
    .forEach((t) => t.remove())
  clone.querySelectorAll('pre, code[class*="language"], [class*="code-block"]').forEach((codeEl) => {
    const lang = (codeEl.className || '').match(/language-(\w+)/)?.[1] ?? ''
    const text = codeEl.textContent ?? ''
    const wrap = document.createElement('div')
    wrap.textContent = '\n```' + lang + '\n' + text + '\n```\n'
    codeEl.replaceWith(wrap)
  })
  // 移除 UI 按钮文字污染（复制/下载等）
  clone.querySelectorAll('button, [class*="copy"], [class*="download"]').forEach((b) => b.remove())
  let text = clone.innerText ?? ''
  // 补未闭合围栏：奇数个 ``` 说明尾部代码块未渲染完/被截
  const fences = (text.match(/```/g) ?? []).length
  if (fences % 2 === 1) text += '\n```'
  return text
}

function isStreaming(): boolean {
  if (!adapter) return false
  if (adapter.streamingFlag.length === 0) return false
  return findFirst(adapter.streamingFlag) !== null
}

function scheduleChunk(): void {
  if (chunkTimer) return
  chunkTimer = setTimeout(() => {
    chunkTimer = null
    const text = lastBubbleText()
    if (text && text !== lastText) {
      lastText = text
      send({ type: 'stream-chunk', text })
    }
  }, 300)
}

function finishStream(): void {
  streaming = false
  const finalText = lastBubbleText()
  lastText = finalText
  lastSentText = ''
  send({ type: 'stream-end', text: finalText })
}

function watchMessages(): void {
  observer?.disconnect()
  observer = new MutationObserver(() => {
    const flag = isStreaming()
    const text = lastBubbleText()

    // 部分平台的 bubble 选择器同时命中用户消息：刚经由 lidow 发出的那段文本
    // 不是 AI 回复，直接当基线吞掉，否则会触发一次假的流式开始/结束。
    // 用去空白比较：气泡渲染会改写换行/空行。
    if (text && lastSentText && text.replace(/\s+/g, '') === lastSentText.replace(/\s+/g, '')) {
      lastText = text
      return
    }

    if (flag) {
      everFlag = true
      if (!streaming) {
        streaming = true
        send({ type: 'stream-start' })
      }
    }

    if (streaming) {
      // 流式中：上报增量；停止标志消失且文本不再变化 → 延迟确认结束
      if (text && text !== lastText) {
        lastText = text
        scheduleChunk()
      }
      if (endTimer) clearTimeout(endTimer)
      if (!flag) {
        endTimer = setTimeout(() => {
          if (!isStreaming()) finishStream()
        }, 900)
      }
      return
    }

    // 未进入流式状态（平台无停止标志或标志闪现太快）：
    // 文本一旦出现就当作回复开始，并以"文本静默 1.5s"作为结束判据。
    if (text && text !== lastText) {
      lastText = text
      if (!everFlag) {
        streaming = true
        send({ type: 'stream-start' })
      }
      scheduleChunk()
      if (endTimer) clearTimeout(endTimer)
      endTimer = setTimeout(() => {
        // 静默期内没有新文本 → 这一轮结束
        if (lastBubbleText() === lastText) finishStream()
      }, 1500)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

// ---------- 发送 ----------

async function doSend(text: string): Promise<void> {
  try {
    if (!adapter) throw new Error('未配置 DOM 适配器')
    // 填入 + 读回校验，失败换候选输入框重试（页面存在多个输入框时首查可能命中隐藏元素）
    let filled = false
    let input: Element | null = null
    for (let attempt = 0; attempt < 3 && !filled; attempt++) {
      input = findFirst(adapter.input, (_el, i) => i >= attempt)
      if (!input) break
      filled = fillVerified(input, text)
      if (!filled) await new Promise((r) => setTimeout(r, 200))
    }
    if (!input || !filled) throw new Error('输入框填入失败（选择器可能过期或页面未就绪）')
    // 等待 React 状态稳定后再发送（cuckoo 做法：随机 2-4s；这里取 1.2s 折中）
    await new Promise((r) => setTimeout(r, 1200))

    // 发送前记下最后一个 AI 气泡的文本（旧回复仍在页面上，不能当新回复处理）
    const baseline = lastBubbleText()
    // 发送动作只执行一次：
    //   1) 精确点击发送按钮（过滤掉错误的 svg 包装元素——按钮必须可见且未禁用）
    //   2) 失败则 Enter 兜底（需要先 focus 输入框 + isComposing:false）
    let sent = false
    let sendBtn: Element | null = null
    for (let i = 0; i < 8 && !sendBtn; i++) {
      sendBtn = findFirst(adapter.send, (el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        if ((el as HTMLElement).getAttribute('aria-disabled') === 'true') return false
        const b = el as HTMLButtonElement
        return !(b instanceof HTMLButtonElement && b.disabled)
      })
      if (!sendBtn) await new Promise((r) => setTimeout(r, 250))
    }
    if (sendBtn) {
      click(sendBtn)
      sent = true
    } else {
      // Enter 兜底：focus + 完整键序（cuckoo 做法）
      pressEnter(input)
      sent = true
    }
    if (!sent) throw new Error('发送动作未能完成')
    send({ type: 'send-result', ok: true })
    streaming = false
    everFlag = false
    lastSentText = text
    // 旧回复还在页面上：把它当基线，只有文本真的变化才视为新一轮回复。
    // 此前重置成空串会让旧气泡被当成新回复，触发伪 stream-start/end。
    lastText = baseline
  } catch (e) {
    send({ type: 'send-result', ok: false, error: String(e instanceof Error ? e.message : e) })
  }
}

function doNewChat(): void {
  const btn = adapter ? findFirst(adapter.newChat) : null
  if (btn) click(btn)
  else window.location.href = window.location.origin
}

function doStop(): void {
  const flag = adapter ? findFirst(adapter.streamingFlag) : null
  if (flag) click(flag)
  else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

// ---------- 悬浮球（三层停止） ----------

const MENU_ACTIONS: { id: string; label: string }[] = [
  { id: 'stop-generate', label: '停止生成' },
  { id: 'stop-tool', label: '停止工具' },
  { id: 'stop-loop', label: '停止自动循环' },
  { id: 'open-panel', label: '打开面板' }
]

function setupFloatingBall(): void {
  if (document.getElementById('lidow-ball')) return
  const style = new CSSStyleSheet()
  style.replaceSync(`
    #lidow-ball{position:fixed;z-index:2147483647;right:18px;bottom:96px;width:40px;height:40px;border-radius:50%;
      background:linear-gradient(135deg,#8dff4f,#59d915);box-shadow:0 4px 16px rgba(89,217,21,.35);cursor:grab;
      display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-weight:700;user-select:none;
      opacity:.45;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s,opacity .2s;}
    #lidow-ball:hover{opacity:1;transform:scale(1.08);box-shadow:0 6px 20px rgba(89,217,21,.45);}
    #lidow-ball:active{cursor:grabbing;}
    #lidow-menu{position:fixed;z-index:2147483647;background:rgba(24,24,30,.96);border:1px solid rgba(255,255,255,.1);
      border-radius:12px;padding:6px;box-shadow:0 8px 32px rgba(0,0,0,.4);display:none;min-width:148px;}
    #lidow-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:#e7e9ee;
      padding:8px 12px;border-radius:8px;font-size:13px;cursor:pointer;}
    #lidow-menu button:hover{background:rgba(255,255,255,.08);}
    #lidow-menu .danger{color:#ff7b7b;}
  `)
  void document.adoptedStyleSheets.push(style)

  const ball = document.createElement('div')
  ball.id = 'lidow-ball'
  ball.textContent = 'L'
  const menu = document.createElement('div')
  menu.id = 'lidow-menu'
  for (const a of MENU_ACTIONS) {
    const b = document.createElement('button')
    b.textContent = a.label
    if (a.id.startsWith('stop')) b.className = 'danger'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.style.display = 'none'
      send({ type: 'float-menu-action', action: a.id })
    })
    menu.appendChild(b)
  }

  // 拖拽
  let dragging = false
  let moved = false
  let sx = 0
  let sy = 0
  ball.addEventListener('mousedown', (e) => {
    dragging = true
    moved = false
    sx = e.clientX
    sy = e.clientY
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const dx = e.clientX - sx
    const dy = e.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
    if (moved) {
      ball.style.right = 'auto'
      ball.style.bottom = 'auto'
      ball.style.left = `${ball.offsetLeft + dx}px`
      ball.style.top = `${ball.offsetTop + dy}px`
      sx = e.clientX
      sy = e.clientY
    }
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })

  // 左键单击 = 面板；右键 = 三层停止菜单
  ball.addEventListener('click', () => {
    if (!moved) send({ type: 'float-menu-action', action: 'open-panel' })
  })
  ball.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    menu.style.display = 'block'
    menu.style.left = `${e.clientX - 160}px`
    menu.style.top = `${e.clientY - 10}px`
  })
  window.addEventListener('click', () => {
    menu.style.display = 'none'
  })

  document.body.appendChild(ball)
  document.body.appendChild(menu)
}

// ---------- 登录态轮询 + 导航上报 ----------

/** 上次上报的 URL：会话 ↔ 平台对话的映射靠它建立（换绑回原对话全靠它） */
let lastNavUrl = ''
/** 平台对话标题：网页版会按内容自动命名，Lidow 侧栏需要同步 */
let lastPageTitle = ''

// ---------- 网页侧删除会话 → 本地会话同步 ----------

/** 已知的本地会话网页地址（主进程下发） */
let watchedChatUrls = new Set<string>()
let chatDeleteWatchToken = 0

function chatUrlKey(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

function collectChatLinks(): Set<string> {
  const out = new Set<string>()
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    try {
      // 侧栏折叠/仅隐藏但未移除的行也按“已消失”处理
      if (!visible(a)) continue
      const u = new URL(a.href, location.href)
      if (u.origin !== location.origin) continue
      const key = chatUrlKey(u.href)
      if (key) out.add(key)
    } catch {
      /* ignore */
    }
  }
  return out
}

function setWatchedChats(urls: string[] | undefined): void {
  const next = new Set<string>()
  for (const raw of urls ?? []) {
    const key = chatUrlKey(raw)
    if (key) next.add(key)
  }
  watchedChatUrls = next
}

/**
 * 用户删网页对话时，侧栏里对应的链接会消失。
 * 只在明确点了「删除/确认」后比对该会话地址，且要求消失链接恰好一个，
 * 避免侧栏折叠、搜索过滤、虚拟滚动造成误删本地会话。
 */
function armChatDeleteWatch(): void {
  const watching = [...watchedChatUrls]
  if (watching.length === 0) return
  const before = collectChatLinks()
  const watchedBefore = watching.filter((u) => before.has(u))
  if (watchedBefore.length === 0) return
  const token = ++chatDeleteWatchToken
  let checks = 0
  const check = (): void => {
    if (token !== chatDeleteWatchToken) return
    checks++
    const now = collectChatLinks()
    const missing = watchedBefore.filter((u) => !now.has(u))
    if (missing.length === 1) {
      // 二次确认，避开 SPA 重渲染导致的短暂消失
      if (checks < 2) {
        window.setTimeout(check, 700)
        return
      }
      const url = missing[0]!
      watchedChatUrls.delete(url)
      send({ type: 'chat-deleted', url })
      return
    }
    if (checks < 3) window.setTimeout(check, 900)
  }
  window.setTimeout(check, 800)
}

function watchChatDeletion(): void {
  document.addEventListener(
    'click',
    (ev) => {
      try {
        if (watchedChatUrls.size === 0) return
        if ((ev as MouseEvent & { __lidowInternal?: boolean }).__lidowInternal) return
        // 主进程自动删除时页面里也会点「删除」，不要反过来再同步一次
        if (document.documentElement.hasAttribute('data-lidow-chat-delete-busy')) return
        let el = ev.target as HTMLElement | null
        for (let i = 0; i < 5 && el; i++) {
          if (el.closest?.('#lidow-first-run, #lidow-first-run-banner')) return
          const labels = [el.getAttribute?.('aria-label') ?? '', el.textContent ?? '']
            .map((s) => s.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
          if (
            labels.some(
              (label) =>
                label.length <= 24 &&
                /^(删除|移除|确认删除|确定删除|确认|确定|delete|remove|ok|okay|confirm)(\s*(对话|会话|chat|conversation))?$/i.test(
                  label
                )
            )
          ) {
            armChatDeleteWatch()
            return
          }
          el = el.parentElement
        }
      } catch {
        /* ignore */
      }
    },
    true
  )
}

/**
 * 立即求值一次登录态（不等 4 秒轮询）。
 *
 * 用户打开页面/登录成功那一刻必须马上弹初始化模态 —— 依赖轮询最多晚 4 秒，
 * 实测体验就是「等了一会儿才弹」。DOM 变化、页面加载、路由切换都主动调它。
 */
function evaluateLoginNow(): void {
  if (!adapter) return
  const url = String(location.href)
  const onLoginPage = /\/sign_?in\b|\/login\b|\/auth\b|accounts\.google\.com|\/i\/flow\/login/i.test(url)
  // 登录判据（按可靠性排序）：
  //  1) URL 在登录页 → 未登录
  //  2) 聊天输入框存在 → 已登录。这是最稳的信号：各平台登录后必然出现输入框，
  //     而头像 class 名平台改版就变 —— 实测 DeepSeek 首页已登录却没有任何 avatar 元素，
  //     只靠 loginFlag 会永远判成未登录，初始化模态因此永不出现
  //  3) loginFlag 命中 → 已登录（兜底）
  // 页面上有「登录 / 立即登录 / 注册」这样的按钮 → 明确未登录。
  // 这条优先于输入框判断：豆包等平台的登录页也有 textarea（搜索框），
  // 只看输入框会误判成已登录，于是在没登录的平台上弹初始化（实测踩中）。
  const LOGIN_BTN_KWS = ['登录', '立即登录', '注册', 'Log in', 'Sign in', 'Sign up']
  const loginBtn = [...document.querySelectorAll<HTMLElement>('button, div[role="button"], a')].find((el) => {
    const t = (el.textContent ?? '').trim()
    if (!t || t.length > 8) return false
    if (el.closest('#lidow-first-run, #lidow-first-run-banner')) return false
    return LOGIN_BTN_KWS.includes(t)
  })
  const nowLoggedIn = onLoginPage
    ? false
    : loginBtn
      ? false
      : findFirst(adapter.input) !== null ||
        (adapter.loginFlag.length > 0 && findFirst(adapter.loginFlag) !== null)
  if (nowLoggedIn !== loggedIn) {
    loggedIn = nowLoggedIn
    renderFirstRun()
  }
}

setInterval(() => {
  const url = String(location.href)
  const pageTitle = (document.title ?? '').trim()
  const urlChanged = url !== lastNavUrl
  const titleChanged = pageTitle !== lastPageTitle
  if (urlChanged || titleChanged) {
    lastNavUrl = url
    lastPageTitle = pageTitle
    // 标题也要上报：平台会按内容自动命名/用户会重命名，侧栏必须对齐网页
    send({ type: 'nav', url, title: pageTitle })
  }
  if (urlChanged) {
    // 这里绝不重置 dismissed。
    // 反例（实测反复踩中）：初始化发完第一条消息后页面会从 / 跳到 /a/chat/s/<id>，
    // 这是同一次会话的正常跳转。任何基于「URL 变了」的重置都会导致
    // 用户刚点完确认又弹一遍。需要再弹时由显式路径触发（见 resetFirstRun）。
    evaluateLoginNow()
    renderFirstRun()
  }
  renderGoogleLoginNotice()
  if (!adapter) {
    exposeState({
      loggedIn,
      projectKnown,
      projectRoot,
      dismissed: firstRunDismissed,
      collapsed: firstRunCollapsed,
      shouldShow: false,
      reason: 'no-adapter'
    })
    return
  }
  evaluateLoginNow()
  // 状态快照：登录态误判时能直接看出是选择器问题还是页面结构变了
  exposeState({ loggedIn, projectKnown, projectRoot })
  send({ type: 'login-state', loggedIn })
  // 开关状态跟平台实际按钮保持同步（用户也可能在网页里自己点）
  reportToggleStates()
}, 1000)

// ---------- 平台环境提示弹窗自动关闭（仅处理已知警告文本，不触碰其它内容） ----------

const dismissedDialogs = new WeakSet<Element>()

function dismissEnvWarnings(): void {
  try {
    const candidates = document.querySelectorAll<HTMLElement>('div,section,dialog')
    for (const el of candidates) {
      const text = el.textContent ?? ''
      if (!text.includes('使用环境异常') || text.length > 220) continue
      if (dismissedDialogs.has(el)) continue
      // 最内层命中容器
      const inner = Array.from(el.querySelectorAll<HTMLElement>('div')).find((d) => d.textContent?.includes('使用环境异常'))
      const dialog = inner && inner.textContent!.length <= text.length ? inner : el
      if (dismissedDialogs.has(dialog)) continue
      dismissedDialogs.add(dialog)
      // 在弹窗容器及其近邻祖先中找关闭控件
      let scope: Element | null = dialog
      for (let up = 0; up < 3 && scope; up++) {
        const closer = scope.querySelector<HTMLElement>(
          'button, [class*="close" i], [aria-label*="关闭" i], [aria-label*="close" i], svg[class*="close" i]'
        )
        if (closer) {
          click(closer)
          return
        }
        scope = scope.parentElement
      }
    }
  } catch {
    /* 页面差异忽略 */
  }
}

setInterval(dismissEnvWarnings, 1500)

// ---------- 网络层 hook（主世界注入）----------
// 关键：必须在页面主世界执行，才能 hook 到页面自己的 fetch/XHR。
// preload 处于隔离世界，因此用 webFrame.executeJavaScript 注入。
/**
 * 网络 hook 上报桥：contextBridge 把 emit 暴露到主世界，
 * 主进程注入的 hook 直接调用 window.__lidowNet.emit(...)。
 * 这是 contextIsolation 下唯一可靠的跨世界通信方式（CustomEvent 不跨世界）。
 */
let netBridgeReady = false

function installNetBridge(): void {
  if (netBridgeReady) return
  netBridgeReady = true
  try {
    contextBridge.exposeInMainWorld('__lidowNet', {
      emit: (kind: string, detail: Record<string, unknown>) => {
        try {
          if (kind === 'stream') {
            send({
              type: 'net-stream',
              text: String(detail.text ?? ''),
              think: String(detail.think ?? ''),
              finished: Boolean(detail.finished)
            })
          } else if (kind === 'response') {
            const st = detail.status === 'stopped' ? 'stopped' : detail.status === 'finished' ? 'finished' : 'error'
            const tu = detail.tokenUsage as { accumulatedTokens?: number } | null | undefined
            send({
              type: 'net-response',
              text: String(detail.text ?? ''),
              status: st,
              reason: detail.reason === undefined ? undefined : String(detail.reason),
              tokens: typeof tu?.accumulatedTokens === 'number' ? tu.accumulatedTokens : undefined
            })
          } else if (kind === 'error') {
            send({ type: 'net-error', text: String(detail.text ?? ''), reason: String(detail.reason ?? 'unknown') })
          }
        } catch {
          /* 通道关闭 */
        }
      }
    })
  } catch {
    /* 已存在（重复 configure）忽略 */
  }
}

// 顶层立即建立跨世界桥（contextBridge 必须在 preload 同步阶段调用，
// 放到 configure 里会因 preload 已结束而失效 → hook 拿不到 __lidowNet）
installNetBridge()

// ---------- 首次引导（注入 AI 网页，对齐 cuckoo 的 first-time-dialog）----------
//
// 为什么必须注入到网页里而不是放在我们自己的侧栏：
// 用户第一眼看的是 AI 页面，准备说话的地方就是那个输入框。引导放在侧栏菜单里
// 等于没放 —— 点开产品的人不会先去读侧栏有没有菜单项。cuckoo 的
// #cuckoo-first-time-dialog 就是这个位置，这里照做。

/** 当前项目目录；null = 未初始化 */
let projectRoot: string | null = null
/** 用户手动关掉过引导：本次页面生命周期内不再弹（cuckoo 同款 close 按钮） */
let firstRunDismissed = false
/** 用户把引导卡片收起了：改为页面顶部的一行提示条，仍可一键初始化 */
let firstRunCollapsed = false
/** 登录态（由轮询更新）：引导必须等登录完成后才出现 */
let loggedIn = false
/** 是否已收到过主进程的明确 projectRoot 下发（区分"还没收到"与"确实没有项目"） */
let projectKnown = false
/** 主进程告知：当前会话/项目已有对话记录（已初始化，重载后不再弹引导） */
let projectInitialized = false

/**
 * 引导关闭状态持久化（按项目目录记在页面 localStorage）。
 *
 * 为什么需要：平台在发出第一条消息后常常整页导航（/ → /a/chat/s/<id>），
 * preload 随之重跑，内存里的 firstRunDismissed 被重置 —— 用户刚点完
 * 「新建对话」初始化完，弹窗立刻又出现（实测踩中）。
 * 用 localStorage 跨页面重载记住已初始化，同时保留显式「新建对话」重置入口。
 */
const FIRST_RUN_KEY_PREFIX = 'lidow:firstRunDismissed:'
/** 持久化只用于挡住「初始化后紧接着的页面跳转/重载」，不永久压制后续新会话的引导 */
const FIRST_RUN_TTL_MS = 5 * 60_000

function firstRunKey(root: string): string {
  return FIRST_RUN_KEY_PREFIX + root.toLowerCase()
}

function isFirstRunPersisted(root: string | null): boolean {
  if (!root) return false
  try {
    const raw = localStorage.getItem(firstRunKey(root))
    if (!raw) return false
    const ts = Number(raw)
    // 旧格式 '1' 视为过期：避免历史版本的一次初始化把引导永久压掉
    return Number.isFinite(ts) && Date.now() - ts < FIRST_RUN_TTL_MS
  } catch {
    return false
  }
}

function persistFirstRunDismissed(root: string | null): void {
  if (!root) return
  try {
    localStorage.setItem(firstRunKey(root), String(Date.now()))
  } catch {
    /* 隐私模式/无存储时忽略 */
  }
}

/** 显式开新对话时清除，让引导能在新对话里再次出现 */
function clearFirstRunPersisted(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(FIRST_RUN_KEY_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

/** 把引导状态写到 DOM 属性上（隔离世界的 window 主世界读不到，DOM 是共享的） */
function exposeState(state: Record<string, unknown>): void {
  try {
    document.documentElement.setAttribute('data-lidow-firstrun', JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function renderFirstRun(): void {
  const existing = document.getElementById('lidow-first-run')
  const banner = document.getElementById('lidow-first-run-banner')
  // 显示条件：
  //  1) 登录已完成 —— 登录页上没有输入框，此时弹引导毫无意义
  //  2) 用户本次没有手动关掉
  //  3) 当前目录此前没有初始化过（localStorage 持久化，跨页面重载有效）
  //  4) 主进程确认当前会话/项目还没有对话记录
  // 注意：不再以「是否已有项目」为前提。需求是登录成功后无条件强制初始化一次，
  // 已打开项目的用户也应看到当前目录并确认/更换（此前带着 !projectRoot 判断，
  // 项目一打开就永不弹，等于功能不存在）。
  const persisted = isFirstRunPersisted(projectRoot)
  const shouldShow = loggedIn && projectKnown && !firstRunDismissed && !persisted && !projectInitialized
  exposeState({
    loggedIn,
    projectKnown,
    projectRoot,
    initialized: projectInitialized,
    dismissed: firstRunDismissed,
    collapsed: firstRunCollapsed,
    shouldShow
  })
  if (!shouldShow) {
    existing?.remove()
    banner?.remove()
    return
  }
  // 收起态：不挡主界面，只在页面顶部挂一行提示，随时可以点「初始化项目」
  if (firstRunCollapsed) {
    existing?.remove()
    if (banner) {
      if ((banner.getAttribute('data-dir') ?? '') === (projectRoot ?? '')) return
      banner.remove()
    }
    renderFirstRunBanner()
    return
  }
  banner?.remove()
  // 已显示：只有「目录变了」才重建内容。
  // 直接 return 会导致选完新目录后弹窗仍显示旧路径（实测踩中）；
  // 无条件重建又会把正在点按钮的用户打断（DOM 被替换）。
  if (existing) {
    const shown = existing.getAttribute('data-dir') ?? ''
    if (shown === (projectRoot ?? '')) return
    existing.remove()
  }

  const style = new CSSStyleSheet()
  style.replaceSync(`
    /* 强制模态：全屏遮罩 + 居中卡片。之前是右上角浮动小卡片，
       用户根本不会注意到 —— 初始化是使用前的必要步骤，必须挡住主界面 */
    #lidow-first-run{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;
      justify-content:center;background:rgba(9,12,18,.42);backdrop-filter:blur(2px);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
    #lidow-first-run .fr-card{position:relative;width:min(420px,90vw);background:#fff;
      border:1px solid rgba(16,24,40,.08);border-radius:16px;padding:26px 24px 20px;
      box-shadow:0 18px 48px rgba(16,24,40,.22);color:#16181d;font-size:13px;line-height:1.6;
      text-align:center;animation:lidow-fr-in .24s cubic-bezier(.22,1,.36,1);}
    @keyframes lidow-fr-in{from{opacity:0;transform:translateY(10px) scale(.98);}
      to{opacity:1;transform:translateY(0) scale(1);}}
    #lidow-first-run .fr-close{position:absolute;top:10px;right:10px;width:26px;height:26px;
      display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;
      background:transparent;color:#8a8f9b;font-size:13px;line-height:1;cursor:pointer;transition:all .18s;}
    #lidow-first-run .fr-close:hover{background:rgba(16,24,40,.06);color:#2f3640;}
    #lidow-first-run .fr-icon{width:44px;height:44px;margin:0 auto 14px;border-radius:12px;
      display:flex;align-items:center;justify-content:center;font-size:20px;
      background:rgba(77,107,254,.12);color:#4d6bfe;}
    #lidow-first-run .fr-title{font-size:15px;font-weight:600;margin-bottom:8px;}
    #lidow-first-run .fr-text{margin-bottom:18px;color:#545a67;font-size:12.5px;}
    #lidow-first-run .fr-dir{margin:0 0 18px;padding:9px 12px;border-radius:9px;
      background:#f4f6fa;border:1px solid rgba(16,24,40,.06);font-family:Consolas,monospace;
      font-size:11.5px;color:#2b6a3f;word-break:break-all;text-align:left;}
    #lidow-first-run .fr-dir.empty{color:#a8661f;background:#fdf6ec;border-color:rgba(168,102,31,.16);}
    #lidow-first-run .fr-actions{display:flex;gap:9px;}
    #lidow-first-run .fr-btn{flex:1;padding:10px 16px;border-radius:10px;border:none;
      background:#4d6bfe;color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s;}
    #lidow-first-run .fr-btn:hover{background:#3b5bdb;box-shadow:0 4px 12px rgba(77,107,254,.32);}
    #lidow-first-run .fr-btn:disabled{opacity:.6;cursor:not-allowed;}
    #lidow-first-run .fr-btn.ghost{background:transparent;color:#545a67;border:1px solid rgba(16,24,40,.14);font-weight:500;}
    #lidow-first-run .fr-continue{margin-top:12px;width:100%;padding:10px 14px;border-radius:10px;
      border:1px dashed rgba(16,24,40,.18);background:transparent;cursor:pointer;text-align:left;transition:all .18s;}
    #lidow-first-run .fr-continue:hover{background:rgba(77,107,254,.06);border-color:rgba(77,107,254,.4);}
    #lidow-first-run .fr-continue-title{display:block;font-size:12.5px;font-weight:600;color:#2f3640;}
    #lidow-first-run .fr-continue-desc{display:block;margin-top:2px;font-size:11px;color:#8a8f9b;}
    #lidow-first-run .fr-btn.ghost:hover{background:rgba(16,24,40,.04);box-shadow:none;}
    @media (prefers-color-scheme: dark){
      #lidow-first-run .fr-card{background:#1a1a1a;border-color:rgba(255,255,255,.08);color:#e4e6eb;
        box-shadow:0 18px 48px rgba(0,0,0,.55);}
      #lidow-first-run .fr-text{color:#a8adba;}
      #lidow-first-run .fr-icon{background:rgba(107,131,255,.18);color:#8b9dff;}
      #lidow-first-run .fr-dir{background:#232323;border-color:rgba(255,255,255,.07);color:#7fd99a;}
      #lidow-first-run .fr-dir.empty{background:#2a2118;border-color:rgba(200,150,80,.2);color:#e0b070;}
      #lidow-first-run .fr-btn{background:#6b83ff;}
      #lidow-first-run .fr-btn:hover{background:#8b9dff;}
      #lidow-first-run .fr-btn.ghost{background:transparent;color:#a8adba;border-color:rgba(255,255,255,.14);}
      #lidow-first-run .fr-btn.ghost:hover{background:rgba(255,255,255,.06);}
      #lidow-first-run .fr-close{color:#8a8f9b;}
      #lidow-first-run .fr-close:hover{background:rgba(255,255,255,.08);color:#e4e6eb;}
    }
  `)
  try {
    void document.adoptedStyleSheets.push(style)
  } catch {
    /* 老内核不支持构造式样式表 */
  }

  const hasDir = Boolean(projectRoot)
  const box = document.createElement('div')
  box.id = 'lidow-first-run'
  // 记录当前展示的目录：目录变化时据此判断要不要重建内容
  box.setAttribute('data-dir', projectRoot ?? '')
  box.innerHTML =
    '<div class="fr-card">' +
    '<button class="fr-close" data-act="close" title="收起，稍后再初始化" aria-label="收起">✕</button>' +
    '<div class="fr-icon">📁</div>' +
    '<div class="fr-title">第一步：初始化项目</div>' +
    '<div class="fr-text">AI 需要一个工作目录才能读写你的文件。<br/>选定目录后再开始对话。</div>' +
    `<div class="fr-dir${hasDir ? '' : ' empty'}">${hasDir ? escapeHtml(projectRoot ?? '') : '尚未选择目录'}</div>` +
    '<div class="fr-actions">' +
    `<button class="fr-btn ghost" data-act="pick">${hasDir ? '更换目录' : '选择目录'}</button>` +
    (hasDir ? '<button class="fr-btn" data-act="confirm">新建对话</button>' : '') +
    '</div>' +
    // 继续上一个对话：把当前项目的对话摘要带进新窗口（相当于同一项目的延续）
    (hasDir
      ? '<button class="fr-continue" data-act="continue">' +
        '<span class="fr-continue-title">延续上个对话</span>' +
        '<span class="fr-continue-desc">把当前项目的对话摘要带进新窗口，接着做</span>' +
        '</button>'
      : '') +
    '</div>'

  // 已有目录：确认即关闭，并让主进程发一轮初始化提示词
  // （把系统提示词 + 工作目录登记进这个对话，AI 才知道自己能操作本地文件）
  box.querySelector<HTMLButtonElement>('[data-act="confirm"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    btn.textContent = '初始化中…'
    firstRunDismissed = true
    projectInitialized = true
    // 关键：持久化本次初始化，页面随后整页导航/重载时 preload 重跑也不会再弹
    persistFirstRunDismissed(projectRoot)
    box.remove()
    send({ type: 'float-menu-action', action: 'confirm-project' })
  })
  // 延续上个对话：压缩旧会话 → 摘要发进新对话（同一项目的上下文不丢）
  box.querySelector<HTMLButtonElement>('[data-act="continue"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    btn.style.opacity = '0.6'
    firstRunDismissed = true
    projectInitialized = true
    persistFirstRunDismissed(projectRoot)
    box.remove()
    send({ type: 'float-menu-action', action: 'continue-project' })
  })
  // 收起：不挡主界面，改成页面顶部一行提示（仍可随时初始化）
  box.querySelector<HTMLButtonElement>('[data-act="close"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    firstRunCollapsed = true
    box.remove()
    renderFirstRun()
  })
  box.querySelector<HTMLButtonElement>('[data-act="pick"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const btn = e.currentTarget as HTMLButtonElement
    const original = btn.textContent ?? '选择目录'
    btn.disabled = true
    btn.textContent = '选择目录中…'
    // 目录选择必须走主进程的对话框：网页侧的 <input type=file> 拿不到真实路径。
    // 选完后主进程会重新下发 set-project，本浮窗随之消失。
    send({ type: 'float-menu-action', action: 'init-project' })
    window.setTimeout(() => {
      btn.disabled = false
      btn.textContent = original
    }, 8000)
  })

  document.body.appendChild(box)
}

/**
 * 引导收起态：页面顶部一条紧凑提示。
 * 用户点了模态右上角的 × 后，初始化仍是必须步骤，但不能一直挡着主界面，
 * 于是降级为一条常驻横幅（可再关闭，可一键初始化）。
 */
function renderFirstRunBanner(): void {
  if (!document.getElementById('lidow-first-run-banner-style')) {
    const st = document.createElement('style')
    st.id = 'lidow-first-run-banner-style'
    st.textContent = `
      #lidow-first-run-banner{position:fixed;top:14px;left:50%;transform:translateX(-50%);
        z-index:2147483645;display:flex;align-items:center;gap:12px;padding:8px 10px 8px 16px;
        width:max-content;max-width:min(680px,calc(100vw - 32px));border-radius:12px;
        background:rgba(255,255,255,.97);border:1px solid rgba(16,24,40,.1);
        box-shadow:0 10px 30px rgba(16,24,40,.16);backdrop-filter:blur(8px);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        font-size:12.5px;line-height:1.45;color:#16181d;
        animation:lidow-frb-in .22s cubic-bezier(.22,1,.36,1);}
      @keyframes lidow-frb-in{from{opacity:0;transform:translate(-50%,-8px);}
        to{opacity:1;transform:translate(-50%,0);}}
      #lidow-first-run-banner .frb-text{min-width:0;color:#3d4350;}
      #lidow-first-run-banner .frb-btn{flex-shrink:0;padding:6px 14px;border-radius:8px;border:none;
        background:#4d6bfe;color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .18s;}
      #lidow-first-run-banner .frb-btn:hover{background:#3b5bdb;box-shadow:0 4px 12px rgba(77,107,254,.3);}
      #lidow-first-run-banner .frb-btn:disabled{opacity:.6;cursor:not-allowed;box-shadow:none;}
      #lidow-first-run-banner .frb-close{flex-shrink:0;width:24px;height:24px;display:flex;
        align-items:center;justify-content:center;border:none;border-radius:7px;background:transparent;
        color:#8a8f9b;font-size:13px;line-height:1;cursor:pointer;transition:all .18s;}
      #lidow-first-run-banner .frb-close:hover{background:rgba(16,24,40,.07);color:#2f3640;}
      @media (prefers-color-scheme: dark){
        #lidow-first-run-banner{background:rgba(26,26,26,.97);border-color:rgba(255,255,255,.09);
          color:#e4e6eb;box-shadow:0 12px 32px rgba(0,0,0,.5);}
        #lidow-first-run-banner .frb-text{color:#c9cdd6;}
        #lidow-first-run-banner .frb-btn{background:#6b83ff;}
        #lidow-first-run-banner .frb-btn:hover{background:#8b9dff;}
        #lidow-first-run-banner .frb-close:hover{background:rgba(255,255,255,.09);color:#e4e6eb;}
      }
    `
    document.head.appendChild(st)
  }

  const bar = document.createElement('div')
  bar.id = 'lidow-first-run-banner'
  bar.setAttribute('data-dir', projectRoot ?? '')
  bar.innerHTML =
    '<span class="frb-text">首次创建对话时，需要初始化项目，并选择一个项目目录，不然无法使用</span>' +
    '<button class="frb-btn" data-act="init">初始化项目</button>' +
    '<button class="frb-close" data-act="dismiss" title="关闭" aria-label="关闭">✕</button>'

  // 横幅只是收缩入口：点击必须还原完整弹窗，让用户能选/换目录。
  // 之前这里直接发 confirm-project，跳过了目录选择（用户反馈：没法选文件夹）。
  bar.querySelector<HTMLButtonElement>('[data-act="init"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    firstRunCollapsed = false
    bar.remove()
    renderFirstRun()
  })
  bar.querySelector<HTMLButtonElement>('[data-act="dismiss"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    firstRunDismissed = true
    firstRunCollapsed = false
    bar.remove()
  })

  document.body.appendChild(bar)
}

/**
 * Google 明确禁止在嵌入式 webview 里完成 OAuth 登录（disallowed_useragent）。
 * 识别到它的报错页时给用户可执行的出口：返回用邮箱登录，或在系统浏览器打开。
 */
function renderGoogleLoginNotice(): void {
  const id = 'lidow-google-block'
  const existing = document.getElementById(id)
  const onGoogle = /(^|\.)accounts\.google\./i.test(location.hostname)
  const pageText = (document.body?.innerText ?? '').slice(0, 5000)
  const blocked =
    onGoogle && /此浏览器或应用可能不安全|browser or app may not be secure|无法登录|disallowed_useragent/i.test(pageText)
  if (!blocked) {
    existing?.remove()
    return
  }
  if (existing) return

  const style = document.createElement('style')
  style.id = 'lidow-google-block-style'
  style.textContent = `
    #lidow-google-block{position:fixed;top:14px;left:50%;transform:translateX(-50%);
      z-index:2147483647;width:min(560px,calc(100vw - 32px));box-sizing:border-box;
      display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:14px;
      background:rgba(255,255,255,.98);border:1px solid rgba(16,24,40,.12);
      box-shadow:0 12px 36px rgba(16,24,40,.2);font-family:-apple-system,BlinkMacSystemFont,
      "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#16181d;}
    #lidow-google-block .gb-badge{width:26px;height:26px;border-radius:8px;flex-shrink:0;
      display:flex;align-items:center;justify-content:center;background:#fff4e6;color:#b26a00;
      font-size:14px;font-weight:700;}
    #lidow-google-block .gb-body{min-width:0;flex:1;}
    #lidow-google-block .gb-title{font-size:13px;font-weight:600;}
    #lidow-google-block .gb-text{margin-top:3px;font-size:12px;line-height:1.55;color:#545a67;}
    #lidow-google-block .gb-actions{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;}
    #lidow-google-block .gb-btn{border:none;border-radius:8px;padding:6px 12px;font-size:11.5px;
      font-weight:600;cursor:pointer;transition:all .18s;}
    #lidow-google-block .gb-btn.primary{background:#4d6bfe;color:#fff;}
    #lidow-google-block .gb-btn.primary:hover{background:#3b5bdb;}
    #lidow-google-block .gb-btn.ghost{background:transparent;color:#545a67;border:1px solid rgba(16,24,40,.16);}
    #lidow-google-block .gb-btn.ghost:hover{background:rgba(16,24,40,.04);}
    #lidow-google-block .gb-close{border:none;background:transparent;color:#8a8f9b;cursor:pointer;
      font-size:15px;line-height:1;padding:2px 4px;border-radius:6px;}
    #lidow-google-block .gb-close:hover{background:rgba(16,24,40,.06);color:#2f3640;}
    @media (prefers-color-scheme: dark){
      #lidow-google-block{background:rgba(26,26,26,.98);border-color:rgba(255,255,255,.1);color:#e4e6eb;}
      #lidow-google-block .gb-text{color:#a8adba;}
      #lidow-google-block .gb-badge{background:#2a2118;color:#e0b070;}
      #lidow-google-block .gb-btn.ghost{color:#a8adba;border-color:rgba(255,255,255,.16);}
      #lidow-google-block .gb-close:hover{background:rgba(255,255,255,.08);color:#e4e6eb;}
    }
  `
  if (!document.getElementById('lidow-google-block-style')) document.head.appendChild(style)

  const box = document.createElement('div')
  box.id = id
  box.innerHTML =
    '<div class="gb-badge">!</div>' +
    '<div class="gb-body">' +
    '<div class="gb-title">Google 登录被阻止</div>' +
    '<div class="gb-text">Google 不允许在应用内浏览器完成登录。请返回后改用邮箱/密码登录，或在系统浏览器中打开登录页。</div>' +
    '<div class="gb-actions">' +
    '<button class="gb-btn ghost" data-act="back">返回上一页</button>' +
    '<button class="gb-btn primary" data-act="external">在系统浏览器打开</button>' +
    '</div>' +
    '</div>' +
    '<button class="gb-close" data-act="close" title="关闭">✕</button>'
  box.querySelector<HTMLButtonElement>('[data-act="back"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (history.length > 1) history.back()
    else location.reload()
  })
  box.querySelector<HTMLButtonElement>('[data-act="external"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    send({ type: 'float-menu-action', action: 'open-external', url: location.href })
  })
  box.querySelector<HTMLButtonElement>('[data-act="close"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    box.remove()
  })
  document.body.appendChild(box)
}

/**
 * 找平台自己的「深度思考 / 智能搜索」开关按钮。
 * 平台可能用 button、div[role=button]，文案也可能带括号后缀。
 */
function findToggleButton(keywords: string[]): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('button, div[role="button"], [class*="button"]')
  for (const kw of keywords) {
    for (const el of candidates) {
      const t = (el.textContent ?? '').trim()
      if (t === kw || t.startsWith(kw)) return el
    }
  }
  return null
}

/** 平台按钮是否处于「已激活」态：查常见标记（选中类、aria-pressed、高亮背景） */
function isToggleActive(el: HTMLElement | null): boolean {
  if (!el) return false
  const cls = el.className || ''
  if (/active|selected|checked|on/i.test(cls)) return true
  if (el.getAttribute('aria-pressed') === 'true') return true
  const bg = getComputedStyle(el).backgroundColor
  // 激活态通常带浅色底（非透明、非纯白）
  return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)'
}

/** 上报两个开关的真实状态（渲染层据此给 chip 上色） */
function reportToggleStates(): void {
  try {
    const think = isToggleActive(findToggleButton(['深度思考', '深度思考（R1）']))
    const search = isToggleActive(findToggleButton(['智能搜索', '联网搜索']))
    send({ type: 'toggle-state', think, search })
  } catch {
    /* ignore */
  }
}

/**
 * 监听「用户自己点了平台的新对话按钮」。
 *
 * 此前只有主进程下发 new-chat 命令才会重置初始化模态 —— 但用户直接点网页里的
 * 「开启新对话」按钮时走的是平台自己的逻辑，我们收不到任何信号，
 * 于是新对话里没有初始化引导（实测：新对话窗口缺少入口）。
 * 用捕获阶段的全局点击代理来补：命中新对话按钮文案就重置。
 */
function watchNativeNewChat(): void {
  const NEW_CHAT_KWS = ['开启新对话', '新建对话', '新对话', '开始新对话', 'New chat']
  document.addEventListener(
    'click',
    (ev) => {
      try {
        // lidow 自己发起的程序化点击（new-chat 命令、初始化发送等）不算用户开新对话
        if ((ev as MouseEvent & { __lidowInternal?: boolean }).__lidowInternal) return
        let el = ev.target as HTMLElement | null
        // 我们自己弹窗里的按钮不算「平台的新对话」——否则点「新建对话」会命中
        // 这里的 '新对话' 关键字，把 dismissed 重置、弹窗立刻重现（实测踩中）
        if (el && el.closest('#lidow-first-run, #lidow-first-run-banner')) return
        for (let i = 0; i < 4 && el; i++) {
          if (el.closest?.('#lidow-first-run, #lidow-first-run-banner')) return
          const t = (el.textContent ?? '').trim()
          if (t && NEW_CHAT_KWS.some((k) => t === k || t.startsWith(k))) {
            // 等平台自己完成路由跳转后再弹，避免被它随后的渲染覆盖。
            // 显式开新对话要解除「已初始化」标记，否则新对话里引导永远不再出现。
            firstRunDismissed = true // 先压住，等 URL 真变了再放开
            projectInitialized = false
            clearFirstRunPersisted()
            window.setTimeout(() => {
              firstRunDismissed = false
              firstRunCollapsed = false
              renderFirstRun()
            }, 900)
            return
          }
          el = el.parentElement
        }
      } catch {
        /* ignore */
      }
    },
    true
  )
}

// ---------- 工具执行遮罩（cuckoo tool-mask 同款）----------
//
// 本地工具执行期间在页面顶部盖一条「执行中」横幅 + 停止按钮：
// 一是明确告知当前状态（此前执行工具页面毫无反馈，用户以为卡了），
// 二是防误操作（执行中途改输入框会把下一轮上下文搅乱）。

function setupToolMask(): { show: (text: string) => void; hide: () => void } {
  const existing = document.getElementById('lidow-tool-mask')
  if (existing) return { show: () => existing.classList.remove('lidow-hidden'), hide: () => existing.classList.add('lidow-hidden') }

  const style = new CSSStyleSheet()
  style.replaceSync(`
    #lidow-tool-mask{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;
      display:flex;align-items:center;gap:12px;padding:9px 16px;border-radius:12px;
      background:rgba(24,24,30,.92);border:1px solid rgba(255,255,255,.12);
      box-shadow:0 8px 28px rgba(0,0,0,.4);font-family:system-ui,sans-serif;font-size:12.5px;color:#e7e9ee;}
    #lidow-tool-mask.lidow-hidden{display:none;}
    #lidow-tool-mask .tm-spin{width:13px;height:13px;border-radius:50%;flex-shrink:0;
      border:2px solid rgba(141,255,79,.25);border-top-color:#8dff4f;animation:lidow-spin .8s linear infinite;}
    @keyframes lidow-spin{to{transform:rotate(360deg);}}
    #lidow-tool-mask .tm-stop{border:none;border-radius:999px;padding:4px 12px;font-size:11.5px;font-weight:600;
      cursor:pointer;background:transparent;color:#ff7b7b;border:1px solid rgba(255,123,123,.4);transition:all .18s;}
    #lidow-tool-mask .tm-stop:hover{background:#e5484d;color:#fff;}
  `)
  try {
    void document.adoptedStyleSheets.push(style)
  } catch {
    /* ignore */
  }
  const box = document.createElement('div')
  box.id = 'lidow-tool-mask'
  box.className = 'lidow-hidden'
  box.innerHTML = '<span class="tm-spin"></span><span id="lidow-tool-mask-text">工具执行中…</span><button class="tm-stop">停止</button>'
  box.querySelector<HTMLButtonElement>('.tm-stop')?.addEventListener('click', (e) => {
    e.stopPropagation()
    send({ type: 'float-menu-action', action: 'stop-loop' })
  })
  document.body.appendChild(box)
  return {
    show: (text: string) => {
      const t = box.querySelector('#lidow-tool-mask-text')
      if (t) t.textContent = text
      box.classList.remove('lidow-hidden')
    },
    hide: () => box.classList.add('lidow-hidden')
  }
}

let toolMaskCtl: { show: (text: string) => void; hide: () => void } | null = null

// ---------- 命令接收 ----------

ipcRenderer.on('lidow:overlay-cmd', (_e, cmd: OverlayCommand) => {
  switch (cmd.kind) {
    case 'configure':
      if (cmd.adapter) {
        adapter = cmd.adapter
        watchMessages()
        setupFloatingBall()
        watchNativeNewChat()
      }
      break
    case 'tool-mask':
      if (!toolMaskCtl) toolMaskCtl = setupToolMask()
      if (cmd.show) toolMaskCtl.show(cmd.text || '工具执行中…')
      else toolMaskCtl.hide()
      break
    case 'reset-first-run':
      // 显式重置：主进程在「新建对话/切换会话」时下发。
      // 只有这条路径能让初始化模态再弹 —— URL 变化一律不重置（防刚确认又弹）。
      firstRunDismissed = false
      firstRunCollapsed = false
      projectInitialized = false
      clearFirstRunPersisted()
      renderFirstRun()
      break
    case 'set-project':
      projectRoot = cmd.projectRoot || null
      projectKnown = true
      projectInitialized = Boolean(cmd.initialized)
      // 注意：这里不能重置 firstRunDismissed —— set-project 会在每次 configure
      // （切会话/重载页面）时下发，重置会让用户关掉的模态反复弹出来。
      // 只有「刚完成初始化」才需要重新评估，那由主进程在选完目录后单独通知。
      renderFirstRun()
      break
    case 'watch-chats':
      setWatchedChats(cmd.urls)
      break
    case 'send':
      void doSend(cmd.text ?? '')
      break
    case 'new-chat':
      // 这里只是把网页切到一个新对话（切换会话/换绑载体时的技术动作），
      // 不是用户要重新初始化项目：不能重置引导状态。
      // 用户自己点平台「新对话」按钮的场景由 watchNativeNewChat 负责。
      doNewChat()
      break
    case 'toggle-think':
    case 'toggle-search': {
      // 深度思考 / 智能搜索是平台自己的按钮：直接点它，比自己维护状态可靠
      // （平台会在请求体里带 thinking_enabled / search_enabled，我们改不了那些字段）
      const isThink = cmd.kind === 'toggle-think'
      const kws = isThink ? ['深度思考', '深度思考（R1）'] : ['智能搜索', '联网搜索']
      const hit = findToggleButton(kws)
      if (hit) {
        click(hit)
        // 点击后回读一次真实激活态，让 UI 的 chip 变蓝（否则用户看不出开关状态）
        window.setTimeout(() => reportToggleStates(), 120)
      }
      break
    }
    case 'click-keywords': {
      // 通用：按文案候选点击平台自带按钮（底部 chip 转发）
      const kws = cmd.keywords ?? []
      if (kws.length > 0) {
        const hit = findToggleButton(kws)
        if (hit) click(hit)
      }
      break
    }
    case 'upload-file':
      // 触发平台自己的文件选择器（页面内 input[type=file] 由平台逻辑处理）
      document.querySelector<HTMLInputElement>('input[type="file"]')?.click()
      break
    case 'stop':
      doStop()
      break
    case 'extract':
      send({ type: 'stream-end', text: lastBubbleText() })
      break
    default:
      break
  }
})

// 页面内路由变化（首页 ↔ 会话页）：cuckoo 的 updateHomeMode 同款，
// 只是这里不区分首页 —— 没项目时任何页面都该提示，否则用户不知道缺什么。
window.addEventListener('popstate', () => renderFirstRun())
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderFirstRun()
})
watchChatDeletion()

// 注意：不在这里主动渲染。无项目时由主进程「按 webview」下发 set-project，
// 避免有项目时先闪一下引导再被 configure 收起。

send({ type: 'ready' })
