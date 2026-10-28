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

/** 填入后读回校验（≥期望长度 90% 视为成功，防 ProseMirror/受控组件静默丢字） */
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
  return current.length >= Math.floor(text.length * 0.9)
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
  el.dispatchEvent(new MouseEvent('click', base))
}

// ---------- 消息/流式监听 ----------

let observer: MutationObserver | null = null
let lastText = ''
let streaming = false
let everFlag = false // 平台是否出现过流式标志（决定是否启用文本稳定兜底判定）
let endTimer: ReturnType<typeof setTimeout> | null = null
let chunkTimer: ReturnType<typeof setTimeout> | null = null

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
  if (bubble) return (bubble as HTMLElement).innerText ?? ''
  if (!container) return ''
  return (container as HTMLElement).innerText ?? ''
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
  send({ type: 'stream-end', text: finalText })
}

function watchMessages(): void {
  observer?.disconnect()
  observer = new MutationObserver(() => {
    const flag = isStreaming()
    const text = lastBubbleText()

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
    lastText = ''
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

// ---------- 登录态轮询 ----------

setInterval(() => {
  if (!adapter) return
  const loggedIn = adapter.loginFlag.length === 0 ? true : findFirst(adapter.loginFlag) !== null
  send({ type: 'login-state', loggedIn })
}, 4000)

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

// ---------- 命令接收 ----------

ipcRenderer.on('lidow:overlay-cmd', (_e, cmd: OverlayCommand) => {
  switch (cmd.kind) {
    case 'configure':
      if (cmd.adapter) {
        adapter = cmd.adapter
        watchMessages()
        setupFloatingBall()
      }
      break
    case 'send':
      void doSend(cmd.text ?? '')
      break
    case 'new-chat':
      doNewChat()
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

send({ type: 'ready' })
