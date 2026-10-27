/**
 * Lidow Overlay — 注入 AI 网页 webview 的 preload。
 * 职责：DOM 适配（找输入/发送/消息/流式标志）、发送指令、流式监听、
 *       悬浮球（拖拽 + 右键三层停止菜单）、登录态上报。
 * 与 main 的通信：ipcRenderer 直连（沙箱 shim），页面脚本无法访问。
 */
import { ipcRenderer } from 'electron'
import type { DomAdapter, OverlayCommand, OverlayEvent } from '@shared/types'

let adapter: DomAdapter | null = null

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
  const opts: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', opts))
  el.dispatchEvent(new KeyboardEvent('keypress', opts))
  el.dispatchEvent(new KeyboardEvent('keyup', opts))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// ---------- 消息/流式监听 ----------

let observer: MutationObserver | null = null
let lastText = ''
let streaming = false
let endTimer: ReturnType<typeof setTimeout> | null = null
let chunkTimer: ReturnType<typeof setTimeout> | null = null

function lastBubbleText(): string {
  const container = findFirst(adapter?.messages ?? [])
  if (!container) return ''
  // 取容器内文本最深一层：优先 bubble 选择器，否则整个容器
  const bubble = findFirst(adapter?.bubble ?? [])
  if (bubble && container.contains(bubble)) return (bubble as HTMLElement).innerText ?? ''
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

function watchMessages(): void {
  observer?.disconnect()
  observer = new MutationObserver(() => {
    const flag = isStreaming()
    const text = lastBubbleText()
    const count = document.querySelectorAll('*').length // 轻量变化信号
    void count

    if (flag && !streaming) {
      streaming = true
      send({ type: 'stream-start' })
    }
    if (streaming) {
      scheduleChunk()
      if (endTimer) clearTimeout(endTimer)
      if (!flag && text === lastText) {
        // 停止按钮消失且文本未再变化 → 延迟确认结束
        endTimer = setTimeout(() => {
          if (!isStreaming()) {
            streaming = false
            const finalText = lastBubbleText()
            lastText = finalText
            send({ type: 'stream-end', text: finalText })
          }
        }, 900)
      }
    } else if (text && text !== lastText) {
      // 页面加载历史消息等场景
      lastText = text
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
    await new Promise((r) => setTimeout(r, 120))

    // 发送按钮延迟就绪时循环重试：优先真实点击，交替 Enter 兜底，最多 10 次
    let sent = false
    for (let i = 0; i < 10 && !sent; i++) {
      const sendBtn = findFirst(adapter.send, (el) => {
        const b = el as HTMLButtonElement
        return !(b instanceof HTMLButtonElement && b.disabled) && (el as HTMLElement).getAttribute('aria-disabled') !== 'true'
      })
      if (sendBtn) {
        click(sendBtn)
        sent = true
      } else {
        pressEnter(input)
        sent = i >= 2 // 前 3 次仍继续尝试找按钮（页面刚填入按钮可能未亮起）
      }
      if (!sent) await new Promise((r) => setTimeout(r, 300))
    }
    if (!sent) throw new Error('发送动作未能完成（按钮持续未就绪）')
    send({ type: 'send-result', ok: true })
    streaming = false
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
      background:linear-gradient(135deg,#5b8cff,#7c5bff);box-shadow:0 4px 16px rgba(60,90,220,.45);cursor:grab;
      display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-weight:700;user-select:none;
      transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s;}
    #lidow-ball:hover{transform:scale(1.1);box-shadow:0 6px 22px rgba(60,90,220,.6);}
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
