/**
 * Lidow Overlay — 注入 AI 网页 webview 的 preload。
 * 职责：DOM 适配（找输入/发送/消息/流式标志）、发送指令、流式监听、
 *       悬浮球（拖拽 + 右键三层停止菜单）、登录态上报。
 * 与 main 的通信：ipcRenderer 直连（沙箱 shim），页面脚本无法访问。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DomAdapter, OverlayCommand, OverlayEvent, ProjectFolderData } from '@shared/types'

let adapter: DomAdapter | null = null
/**
 * 主进程可能在本 preload 真正就绪前就下发 configure/set-project（页面加载中），
 * 命令会静默丢失 —— 用户看到的就是「进了 ChatGPT 十几秒都没有初始化入口/悬浮球」。
 * 就绪后主动上报 ready，并在收到 configure 前每 2 秒重试一次（最多 60 次），
 * 让主进程在会话完成绑定后能把配置补发进来。
 */
let overlayConfigured = false
let readyAttempts = 0
let readyTimer: ReturnType<typeof setInterval> | null = null

// ---------- 环境硬化（preload 先于页面脚本执行） ----------
// 补全嵌入式 webview 缺失的浏览器特征，缓解平台"使用环境异常"误判
try {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
  Object.defineProperty(Navigator.prototype, 'languages', {
    get: () => ['zh-CN', 'zh', 'en'],
    configurable: true
  })
  Object.defineProperty(Navigator.prototype, 'plugins', {
    get: () => [{ name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
    configurable: true
  })
  type ChromeStub = { runtime?: { connect?: () => void; sendMessage?: () => void } }
  const w = window as unknown as { chrome?: ChromeStub }
  if (!w.chrome) w.chrome = {}
  if (!w.chrome.runtime)
    w.chrome.runtime = { connect: () => undefined, sendMessage: () => undefined }
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
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c)
}

function findFirst(
  selectors: string[],
  filter?: (el: Element, index: number) => boolean
): Element | null {
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
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
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
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    isComposing: false
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
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0
  }
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
/** 本轮是否真的出现过新的回复文本：只有流式标志、文本还停在上一轮时不能结束 */
let sawReplyText = false
/** 发送前的回复条数：新回复文字可能与上一轮完全相同，只能按条数判断 */
let baselineReplyCount = 0
/** 发送前最后一条回复的文本（DOM 重渲染后节点全变时用它排除上一轮） */
let baselineReplyText = ''
/** 发送前已有的回复节点：只有发送后新建的节点才算本轮回复 */
let baselineReplyNodes: Element[] = []
/** 发送前气泡数量：连续两次相同回答时靠条数增长识别（非 ChatGPT） */
let baselineBubbleCount = 0
/**
 * 即将/刚刚由 lidow 发进网页的文本：主世界的网络 hook 用它区分
 * 「用户亲手在网页里发的」与「lidow 自己发的（工具观察/重试/初始化）」，
 * 只有前者需要同步回纯净模式。
 */
let lastOutgoing: { text: string; ts: number } = { text: '', ts: 0 }

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function markOutgoing(text: string): void {
  lastOutgoing = { text: normalizePromptText(text), ts: Date.now() }
}

/** 把渲染后的 markdown DOM 还原成可解析文本（代码块补围栏、去掉思考/按钮） */
function cleanRenderedText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  // 思考区不属于回复正文：DOM 兜底时若把 .ds-think-content 一起抓进去，
  // 本地转录里就会「思考整段漏进气泡」（DeepSeek 分享页 DOM 已证实）
  clone
    .querySelectorAll('[class*="think" i], [class*="reasoning" i], [data-testid*="think" i]')
    .forEach((t) => t.remove())
  // 「已思考（用时 1 秒）」这类折叠条不在思考内容块里，按文案单独剔除：
  // 带进快照会让整段回答不以原文本开头，去重/前缀比对失效，回答被重复追加一遍
  clone.querySelectorAll('div, span, button').forEach((n) => {
    const t = (n.textContent ?? '').trim()
    if (t.length <= 32 && /^已(?:深度)?思考[（(]用时[^）)]*[）)]$/.test(t)) n.remove()
  })
  clone
    .querySelectorAll('pre, code[class*="language"], [class*="code-block"]')
    .forEach((codeEl) => {
      const lang = (codeEl.className || '').match(/language-(\w+)/)?.[1] ?? ''
      const text = codeEl.textContent ?? ''
      const wrap = document.createElement('div')
      wrap.textContent = '\n```' + lang + '\n' + text + '\n```\n'
      codeEl.replaceWith(wrap)
    })
  // 移除 UI 按钮文字污染（复制/下载等）
  clone.querySelectorAll('button, [class*="copy"], [class*="download"]').forEach((b) => b.remove())
  let text = clone.innerText ?? ''
  // 兜底：折叠条文字不一定是独立节点，从整段开头再剥一次
  text = text.replace(/^\s*已(?:深度)?思考[（(]用时[^）)]*[）)]\s*/, '')
  // 补未闭合围栏：奇数个 ``` 说明尾部代码块未渲染完/被截
  const fences = (text.match(/```/g) ?? []).length
  if (fences % 2 === 1) text += '\n```'
  return text
}

function isChatGptPage(): boolean {
  return /(^|.)chatgpt.com$/i.test(location.hostname)
}

/** ChatGPT 分享页/新版 UI 的兜底：按「ChatGPT 说：」标记截取最后一条回答 */
function chatGptReplyFromText(): string {
  const root = (document.querySelector('main') as HTMLElement | null) ?? document.body
  const text = root?.innerText ?? ''
  const marker = 'ChatGPT 说：'
  const idx = text.lastIndexOf(marker)
  if (idx < 0) return ''
  let tail = text.slice(idx + marker.length)
  for (const cut of [
    '你说：',
    'ChatGPT 可能会出错',
    '最新一条回复',
    '你正在使用',
    '升级至',
    '分享',
    '免费版',
    '回答已完成'
  ]) {
    const i = tail.indexOf(cut)
    if (i >= 0) tail = tail.slice(0, i)
  }
  return tail.trim()
}

/**
 * 新版 Workspace 的回复正文节点：MarkdownRoot（class 含 markdown，大小写不敏感）。
 * 退回旧 UI 的 author-role / turn / article 结构。
 */
function outermost(list: HTMLElement[]): HTMLElement[] {
  const set = new Set(list)
  return list.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false
    return true
  })
}

function chatGptReplyNodes(): HTMLElement[] {
  if (!isChatGptPage()) return []
  const marks = [...document.querySelectorAll<HTMLElement>('[class*="markdown" i]')].filter(visible)
  const outer = outermost(marks)
  if (outer.length > 0) return outer
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="assistant"], article, [data-testid*="conversation-turn"]'
    )
  ].filter(visible)
}

/** 页面上最后一条回复的文本（节点优先，标记文本兜底） */
function chatGptLastReplyText(): string {
  const nodes = chatGptReplyNodes()
  if (nodes.length > 0) return cleanRenderedText(nodes[nodes.length - 1]!).trim()
  return chatGptReplyFromText()
}

/**
 * 发送后新建的回复节点文本。发送后新回合会先出现空占位，
 * 这里没有新节点/新节点没出字时必须返回空，不能用上一轮回答顶替。
 */
function chatGptFreshReplyText(): string {
  if (!isChatGptPage()) return ''
  const nodes = chatGptReplyNodes()
  const fresh = nodes.filter((n) => !baselineReplyNodes.includes(n))
  if (fresh.length > 0) return cleanRenderedText(fresh[fresh.length - 1]!).trim()
  return ''
}

function countChatGptReplies(): number {
  if (!isChatGptPage()) return 0
  const text = (document.querySelector('main') as HTMLElement | null)?.innerText ?? ''
  const markers = (text.match(/ChatGPT 说：/g) ?? []).length
  const roles = document.querySelectorAll('[data-message-author-role="assistant"]').length
  const marks = [...document.querySelectorAll<HTMLElement>('[class*="markdown" i]')].filter(visible)
  const outer = outermost(marks).length
  return Math.max(markers, roles, outer)
}

/**
 * 最后一个气泡：每个选择器只取自己的最后一个可见匹配，再按文档顺序选最靠后的。
 * 不能枚举所有匹配再过滤最外层——长会话里 [class*=markdown] 会命中上千个
 * 嵌套节点，去重是 O(n²)，会把发送/观察线程卡住十几秒（实测首条消息发送超时）。
 */
function findLastBubble(): HTMLElement | null {
  if (!adapter) return null
  let best: HTMLElement | null = null
  for (const sel of adapter.bubble) {
    try {
      const list = document.querySelectorAll<HTMLElement>(sel)
      for (let i = list.length - 1; i >= 0; i--) {
        const el = list[i]
        if (!el || !visible(el)) continue
        if (!best || (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          best = el
        }
        break
      }
    } catch {
      /* 无效选择器跳过 */
    }
  }
  return best
}

/**
 * 当前气泡节点数（含嵌套）：只在「文本和上一轮完全相同」时用于识别新回复。
 * 用 Set 去重，避免 O(n²) 的 includes；计数偏大不影响增长判断。
 */
function countBubbles(): number {
  if (!adapter) return 0
  const set = new Set<Element>()
  for (const sel of adapter.bubble) {
    try {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) set.add(el)
    } catch {
      /* 无效选择器跳过 */
    }
  }
  return set.size
}

function lastBubbleText(): string {
  const container = findFirst(adapter?.messages ?? [])
  // 优先取最后一个气泡（AI 回复在文档流末尾）；退化到整个容器
  const bubble = findLastBubble()
  if (isChatGptPage()) {
    // 新版 Workspace：MarkdownRoot 节点优先；旧 UI 退回「ChatGPT 说：」标记
    const nodeText = chatGptLastReplyText()
    if (nodeText) return nodeText
  }
  if (!bubble) {
    if (!container) return ''
    return (container as HTMLElement).innerText ?? ''
  }
  return cleanRenderedText(bubble as HTMLElement)
}

/**
 * 最后一条 AI 消息的完整文本（不是最后一个 markdown block）。
 * DeepSeek 会把一条长回答拆成多个 .ds-markdown--block；快照必须取整条消息，
 * 否则重启恢复时只能补上最后一小段。
 */
function lastMessageText(): string {
  if (isChatGptPage()) return lastBubbleText().trim()
  const msgs = [...document.querySelectorAll<HTMLElement>('.ds-message')].filter(visible)
  const blocks = [...document.querySelectorAll<HTMLElement>('div.ds-markdown--block')].filter(
    visible
  )
  const candidates = msgs.length > 0 ? msgs : blocks
  const hasMarkdown = (el: HTMLElement): boolean =>
    Boolean(el.querySelector('div.ds-markdown--block, div.ds-markdown, div[class*="ds-markdown"]'))
  let el = candidates[candidates.length - 1]
  if (el && !hasMarkdown(el)) {
    for (let i = candidates.length - 2; i >= 0; i--) {
      if (hasMarkdown(candidates[i]!)) {
        el = candidates[i]
        break
      }
    }
  }
  const text = el ? cleanRenderedText(el).trim() : ''
  return text || lastBubbleText().trim()
}

function isStreaming(): boolean {
  if (!adapter) return false
  if (adapter.streamingFlag.length === 0) return false
  return findFirst(adapter.streamingFlag) !== null
}

/**
 * 最后一条 AI 消息里最完整的思考内容。
 * 网络层思考流往往只覆盖前半段；DeepSeek 页面上的思考块（含搜索步骤）才是
 * 用户在网页版看到的完整过程，快照时一并同步给纯净模式。
 */
function lastThinkText(): string {
  const msgs = [...document.querySelectorAll<HTMLElement>('.ds-message')].filter(visible)
  const scopes = msgs.length > 0 ? [msgs[msgs.length - 1]!] : [document.body]
  let best = ''
  for (const scope of scopes) {
    const blocks = [
      ...scope.querySelectorAll<HTMLElement>(
        '[class*="think" i], [class*="reasoning" i], [data-testid*="think" i]'
      )
    ].filter(visible)
    for (const el of blocks) {
      const clone = el.cloneNode(true) as HTMLElement
      clone
        .querySelectorAll('button, [class*="copy"], [class*="download"]')
        .forEach((b) => b.remove())
      const text = (clone.innerText || '').trim()
      if (!text) continue
      if (/^已(?:深度)?思考[（(]用时[^）)]*[）)]$/.test(text)) continue
      if (text.length > best.length) best = text
    }
  }
  return best.slice(0, 20_000)
}

function scheduleChunk(nextText?: string): void {
  if (chunkTimer) return
  chunkTimer = setTimeout(() => {
    chunkTimer = null
    const text = nextText ?? lastBubbleText()
    if (text && text !== lastText) {
      lastText = text
      send({ type: 'stream-chunk', text })
    }
  }, 300)
}

function finishStream(): void {
  // 只有流式标志消失、文本仍是上一轮回答：不能把旧回答当成本轮回复（会重复落盘）
  if (!sawReplyText) {
    streaming = false
    return
  }
  streaming = false
  // ChatGPT 用「发送后新建节点」的文本，严禁回落到上一轮页面文本
  const finalText = isChatGptPage() ? chatGptFreshReplyText() || lastText : lastBubbleText()
  if (!finalText.trim()) {
    // 正文没同步到（节点重渲染/平台延迟）：让网络层或等待器兜底，绝不发空结束触发重试
    return
  }
  lastText = finalText
  lastSentText = ''
  sawReplyText = false
  send({ type: 'stream-end', text: finalText })
}

function watchMessages(): void {
  observer?.disconnect()
  // 观察器挂载时页面可能已经渲染了历史对话：把它当基线，不能当成「新回复」。
  // 否则一进入会话就会误发 stream-start/end，发送逻辑还会等这个假流结束（首条超时）。
  lastText = lastBubbleText()
  baselineReplyText = lastText
  baselineReplyNodes = isChatGptPage() ? chatGptReplyNodes() : []
  baselineReplyCount = isChatGptPage() ? countChatGptReplies() : 0
  baselineBubbleCount = isChatGptPage() ? 0 : countBubbles()
  streaming = false
  sawReplyText = false
  everFlag = false
  if (endTimer) {
    clearTimeout(endTimer)
    endTimer = null
  }
  if (chunkTimer) {
    clearTimeout(chunkTimer)
    chunkTimer = null
  }
  observer = new MutationObserver(() => {
    const flag = isStreaming()
    const chatgpt = isChatGptPage()

    // ChatGPT 新版 Workspace：发送后立刻出现空 assistant 回合，
    // 不能用「最后一条 ChatGPT 说：」的整页文本（那是上一轮）。
    // 只认发送后新建的回复节点；连续两次相同回答靠回复条数增长识别。
    if (chatgpt) {
      const text = chatGptFreshReplyText()
      const grew = countChatGptReplies() > baselineReplyCount
      if (!text) return
      // 与发送前相同的文字：新开对话时页面会整页跳转，网络 hook 可能晚于请求
      // 注入而漏掉这一轮，DOM 必须能兜住「又问了一次同样问题、回答也相同」。
      // 只认回复条数增长（真的多了一个 assistant 回合）；React 重建旧节点时
      // 条数不会变，重放上一轮回答会被这里挡掉。
      if (text === baselineReplyText && !grew) return
      if (text === lastText && !grew) return
      if (!streaming) {
        streaming = true
        everFlag = true
        lastPageSnapshot = ''
        send({ type: 'stream-start' })
      }
      sawReplyText = true
      if (text !== lastText) {
        lastText = text
        scheduleChunk(text)
      }
      if (endTimer) clearTimeout(endTimer)
      const scheduled = text
      endTimer = setTimeout(() => {
        // 静默期内文本没再变化 → 本轮结束
        if (lastText === scheduled) finishStream()
      }, 1500)
      return
    }

    const text = lastBubbleText()

    // 部分平台的 bubble 选择器同时命中用户消息：刚经由 lidow 发出的那段文本
    // 不是 AI 回复，直接当基线吞掉，否则会触发一次假的流式开始/结束。
    // 用去空白比较：气泡渲染会改写换行/空行。
    if (text && lastSentText && text.replace(/\s+/g, '') === lastSentText.replace(/\s+/g, '')) {
      lastText = text
      return
    }

    // 只有「还没开始流式、文本和上一轮完全相同」时才需要数气泡（连续两次回答相同）。
    // 每次流式 token 都做选择器查询会拖慢长会话。
    const sameAsBaseline = Boolean(text) && text === baselineReplyText
    const bubbleGrew =
      !streaming && sameAsBaseline && text === lastText
        ? countBubbles() > baselineBubbleCount
        : false
    const accepted = Boolean(text) && (text !== lastText || (bubbleGrew && sameAsBaseline))

    // 只看流式标志不够：思考阶段可能短暂出现停止按钮，文本仍是上一轮回答
    if (flag && accepted) {
      everFlag = true
      if (!streaming) {
        streaming = true
        sawReplyText = true
        lastPageSnapshot = ''
        send({ type: 'stream-start' })
      }
    }

    if (streaming) {
      // 流式中：上报增量；停止标志消失且文本不再变化 → 延迟确认结束
      if (accepted) {
        lastText = text
        sawReplyText = true
        scheduleChunk()
      }
      if (endTimer) clearTimeout(endTimer)
      if (!flag) {
        const scheduled = lastText
        endTimer = setTimeout(() => {
          if (!isStreaming() && lastText === scheduled) finishStream()
        }, 900)
      }
      return
    }

    // 未进入流式状态（平台无停止标志或标志闪现太快）：
    // 文本一旦出现就当作回复开始，并以"文本静默 1.5s"作为结束判据。
    if (accepted) {
      lastText = text
      sawReplyText = true
      if (!everFlag) {
        streaming = true
        lastPageSnapshot = ''
        send({ type: 'stream-start' })
      }
      scheduleChunk()
      if (endTimer) clearTimeout(endTimer)
      const scheduled = text
      endTimer = setTimeout(() => {
        // 静默期内没有新文本 → 这一轮结束
        if (lastText === scheduled) finishStream()
      }, 1500)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

// ---------- 发送 ----------

async function doSend(text: string): Promise<void> {
  try {
    if (!adapter) throw new Error('未配置 DOM 适配器')
    // 页面还在生成时不要抢发：新消息会被平台排成「中途插话」，
    // 用户看到的就是回复还没停、Lidow 却自动冒出一条重试提示。
    // 等 DOM 停止标志/流式状态消失再发；超时则让上层稍后重试。
    const idleDeadline = Date.now() + 20_000
    while ((isStreaming() || streaming) && Date.now() < idleDeadline) {
      await new Promise((r) => setTimeout(r, 400))
    }
    if (isStreaming() || streaming) throw new Error('页面仍在生成回复，已暂缓发送')
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

    // 发送前记下最后一个 AI 气泡的文本/节点/条数（旧回复仍在页面上，不能当新回复处理）。
    // 必须在点击发送之前取：新版 UI 会在点击后立刻插入空的 assistant 回合，
    // 点完再计数会把新回合算进基线，导致回复永远不被识别。
    const baseline = isChatGptPage() ? chatGptLastReplyText() : lastBubbleText()
    baselineReplyText = baseline
    baselineReplyNodes = isChatGptPage() ? chatGptReplyNodes() : []
    baselineReplyCount = isChatGptPage() ? countChatGptReplies() : 0
    baselineBubbleCount = isChatGptPage() ? 0 : countBubbles()
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
    // 点击可能在同一个事件循环里发出请求：标记必须在 click 之前
    markOutgoing(text)
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
    sawReplyText = false
    // 旧回复还在页面上：把它当基线，只有新节点/新气泡出现才视为新一轮回复。
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
  { id: 'show-init', label: '初始化项目 / 切换目录' },
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
      // 常驻入口：初始化弹窗被关掉/新对话没有触发时，用户始终能从这里重新打开
      if (a.id === 'show-init') {
        firstRunDismissed = false
        firstRunCollapsed = false
        // 手动入口必须能覆盖「项目已初始化」的缓存，否则点了什么都不弹。
        // markNativeNewChat 提供 2 分钟窗口，即使主进程随后重发 initialized=true
        // 也不会把刚打开的引导压回去。
        projectInitialized = false
        clearFirstRunPersisted()
        markNativeNewChat()
        renderFirstRun()
        return
      }
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

let pageSnapshotTimer: number | undefined
let lastPageSnapshot = ''
let pageSnapshotTries = 0

/**
 * 页面重新挂载（重启/重载/切回会话）时，把网页里最后一条 AI 回答补同步给
 * 主进程：重启会中断在途的流，之后页面上已生成的最终回答不会再有网络事件。
 */
function schedulePageSnapshot(delay = 2200): void {
  if (!isDeepSeekPage()) return
  if (pageSnapshotTimer !== undefined) window.clearTimeout(pageSnapshotTimer)
  pageSnapshotTimer = window.setTimeout(() => {
    pageSnapshotTimer = undefined
    if (!isDeepSeekPage()) return
    // 还在生成/搜索时先等，避免把中间态当最终回答
    if (isStreaming() || streaming) {
      schedulePageSnapshot(1200)
      return
    }
    const text = lastMessageText().trim()
    if (!text) {
      // 页面可能还没渲染完历史消息：有限次重试
      if (pageSnapshotTries++ < 5) schedulePageSnapshot(1500)
      return
    }
    const think = lastThinkText()
    const sig = text + '\n---lidow-think---\n' + think
    if (sig === lastPageSnapshot) return
    lastPageSnapshot = sig
    send({ type: 'page-snapshot', text, think })
  }, delay)
}

// ---------- DeepSeek 网页侧：项目文件夹 + 长会话时间线 ----------

let projectFolders: ProjectFolderData | null = null
let projectFoldersSig = ''
let projectFoldersCollapsed = false
const projectFoldersExpanded = new Set<string>()
const projectFoldersShowAll = new Set<string>()
let projectFoldersSeeded = false
let projectFoldersActiveSeen = ''
let projectFolderTimer: number | undefined
/** 点击后先本地高亮，不等主进程/网页导航完成 */
let pendingFolderProject = ''
let pendingFolderUrl = ''
let pendingFolderTimer: number | undefined
/** 程序化点击侧栏链接时，短暂放行 capture 拦截（只放行目标对话） */
let suppressActivateUntil = 0
let suppressChatKey = ''

function isDeepSeekPage(): boolean {
  return /(^|\.)deepseek\.com$/i.test(location.hostname)
}

// ---------- 长会话自动折叠（参考 Voyager collapse-long-messages） ----------
const FOLD_MIN_TOTAL = 6_000
const FOLD_MIN_HEIGHT = 360
const FOLD_MIN_TEXT = 400
let foldExpanded = false
let foldHref = ''
let foldBarEl: HTMLButtonElement | null = null

function ensureFoldStyles(): void {
  if (document.getElementById('lidow-fold-styles')) return
  const style = document.createElement('style')
  style.id = 'lidow-fold-styles'
  style.textContent = `
#lidow-fold-bar{position:fixed;right:24px;bottom:112px;z-index:2147483000;display:none;align-items:center;gap:6px;max-width:340px;padding:8px 14px;border-radius:999px;font:500 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 8px 24px rgba(0,0,0,.12)}
#lidow-fold-bar:hover{filter:brightness(.98)}
.lpf-msg-fold{max-height:340px!important;overflow:hidden!important;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 48px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 48px),transparent)}
`
  document.head.appendChild(style)
}

function ensureFoldBar(): HTMLButtonElement {
  if (foldBarEl && foldBarEl.isConnected) return foldBarEl
  const btn = document.createElement('button')
  btn.id = 'lidow-fold-bar'
  btn.type = 'button'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    foldExpanded = !foldExpanded
    scanMessageFold()
  })
  document.body.appendChild(btn)
  foldBarEl = btn
  return btn
}

/**
 * 上下文变长后，把较早的长消息折叠到 340px（保留最新一条不折）。
 * 纯展示折叠，不修改平台真正发给模型的上下文；用户可一键展开。
 */
function scanMessageFold(): void {
  if (!isDeepSeekPage()) return
  ensureFoldStyles()
  const list = document.querySelector<HTMLElement>('.ds-virtual-list-visible-items')
  if (!list) {
    foldBarEl?.remove()
    foldBarEl = null
    return
  }
  if (location.href !== foldHref) {
    foldHref = location.href
    foldExpanded = false
  }
  const items = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement)
  if (items.length === 0) {
    foldBarEl?.remove()
    foldBarEl = null
    return
  }
  const total = items.reduce((n, el) => n + (el.innerText || '').length, 0)
  const older = items.slice(0, -1)
  const long = older.filter(
    (el) =>
      (el.innerText || '').length >= FOLD_MIN_TEXT &&
      el.getBoundingClientRect().height > FOLD_MIN_HEIGHT
  )
  const active = total >= FOLD_MIN_TOTAL && long.length > 0
  if (!active) {
    for (const el of items) el.classList.remove('lpf-msg-fold')
    foldBarEl?.remove()
    foldBarEl = null
    return
  }
  const longSet = new Set(long)
  for (const el of items) el.classList.toggle('lpf-msg-fold', !foldExpanded && longSet.has(el))
  const bar = ensureFoldBar()
  bar.textContent = foldExpanded
    ? `已展开 ${long.length} 条长消息 · 收起`
    : `已折叠 ${long.length} 条长消息 · 展开`
  bar.style.display = 'flex'
}

function ensureDeepSeekStyles(): void {
  if (document.getElementById('lidow-deepseek-style')) return
  const style = document.createElement('style')
  style.id = 'lidow-deepseek-style'
  style.textContent = `
    #lidow-project-folders{
      --lpf-text:#0f1115;
      --lpf-muted:color-mix(in srgb, var(--lpf-text) 52%, transparent);
      --lpf-hover:#f5f9ff;
      --lpf-hover-text:#0b1220;
      --lpf-active-bg:#e8f2ff;
      --lpf-active-text:#0b3fa8;
      --lpf-active-bar:#165dff;
      --lpf-brand:#165dff;
      --lpf-pill-bg:rgba(15,17,21,.055);
      --lpf-pill-text:#8b939f;
      --lpf-ease:cubic-bezier(.4,0,.2,1);
      margin:2px 0 6px;padding-right:30px;color:var(--lpf-text);font-size:14px;line-height:1.5;
      font-family:var(--lpf-font,inherit)}
    #lidow-project-folders.lpf-dark{
      --lpf-hover:rgba(255,255,255,.06);
      --lpf-hover-text:#fff;
      --lpf-active-bg:rgba(88,115,255,.18);
      --lpf-active-text:#c9d6ff;
      --lpf-active-bar:#7f9cff;
      --lpf-brand:#8ba4ff;
      --lpf-pill-bg:rgba(255,255,255,.09);
      --lpf-pill-text:#a8b1bf}
    #lidow-project-folders button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
    .lpf-head{display:flex;align-items:center;gap:7px;width:100%;height:36px;padding:0 12px;border-radius:6px;
      font-size:13px;font-weight:500;color:var(--lpf-muted);
      transition:background .15s var(--lpf-ease),color .15s var(--lpf-ease)}
    .lpf-head:hover{background:var(--lpf-hover);color:var(--lpf-hover-text)}
    .lpf-badge{box-sizing:border-box;min-width:20px;height:18px;padding:0 5px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;
      background:var(--lpf-pill-bg);color:var(--lpf-pill-text);font-size:11.5px;font-weight:400;line-height:1;
      font-variant-numeric:tabular-nums;text-align:center}
    .lpf-chevron{display:inline-flex;width:12px;justify-content:center;font-size:11px;opacity:.55;transform:rotate(0);
      transition:transform .2s var(--lpf-ease)}
    .lpf-chevron.open{transform:rotate(90deg)}
    .lpf-collapse{display:grid;grid-template-rows:0fr;opacity:0;
      transition:grid-template-rows .2s var(--lpf-ease),opacity .2s var(--lpf-ease)}
    .lpf-collapse.open{grid-template-rows:1fr;opacity:1}
    .lpf-collapse>div{overflow:hidden;min-height:0}
    .lpf-project-head{position:relative;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 12px;border-radius:6px;
      color:var(--lpf-text);cursor:pointer;transition:background .15s var(--lpf-ease),color .15s var(--lpf-ease)}
    .lpf-project-head:hover{background:var(--lpf-hover);color:var(--lpf-hover-text)}
    .lpf-project-head.active{background:var(--lpf-active-bg);color:var(--lpf-active-text)}
    .lpf-project-head.active::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;
      background:var(--lpf-active-bar)}
    .lpf-project-head.active .lpf-name{font-weight:500}
    .lpf-chev{display:inline-flex;width:12px;justify-content:center;font-size:11px;opacity:.5;flex-shrink:0;transform:rotate(0);
      transition:transform .2s var(--lpf-ease)}
    .lpf-chev.open{transform:rotate(90deg)}
    .lpf-folder{display:inline-flex;flex-shrink:0;color:var(--lpf-muted);transition:color .2s var(--lpf-ease)}
    .lpf-project-head:hover .lpf-folder{color:var(--lpf-hover-text)}
    .lpf-project-head.open .lpf-folder,.lpf-project-head.active .lpf-folder{color:var(--lpf-brand)}
    .lpf-folder-open{display:none}
    .lpf-project-head.open .lpf-folder-closed{display:none}
    .lpf-project-head.open .lpf-folder-open{display:block}
    .lpf-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:14px}
    .lpf-count{flex-shrink:0;box-sizing:border-box;min-width:20px;height:18px;padding:0 5px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;
      background:var(--lpf-pill-bg);color:var(--lpf-pill-text);font-size:11.5px;font-weight:400;line-height:1;
      font-variant-numeric:tabular-nums;text-align:center}
    .lpf-chats{padding:1px 0 3px 20px}
    .lpf-chat{position:relative;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 12px;border-radius:6px;
      font-size:14px;color:var(--lpf-text);cursor:pointer;transition:background .15s var(--lpf-ease),color .15s var(--lpf-ease)}
    .lpf-chat:hover{background:var(--lpf-hover);color:var(--lpf-hover-text)}
    .lpf-chat.active{background:var(--lpf-active-bg);color:var(--lpf-active-text)}
    .lpf-chat.active::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;
      background:var(--lpf-active-bar)}
    .lpf-chat.active .lpf-chat-title{font-weight:500}
    .lpf-doc{display:inline-flex;flex-shrink:0;color:var(--lpf-muted);transition:color .15s var(--lpf-ease)}
    .lpf-chat:hover .lpf-doc,.lpf-chat.active .lpf-doc{color:inherit}
    .lpf-chat-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .lpf-more-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;flex-shrink:0;
      color:var(--lpf-muted);opacity:0;pointer-events:none;transition:opacity .15s var(--lpf-ease),background .15s var(--lpf-ease)}
    .lpf-chat:hover .lpf-more-icon,.lpf-project-head:hover .lpf-more-icon{opacity:1;pointer-events:auto;
      color:color-mix(in srgb,var(--lpf-text) 62%,transparent)}
    .lpf-more-icon:hover{background:color-mix(in srgb,var(--lpf-text) 8%,transparent)}
    .lpf-more{display:flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;font-size:12.5px;
      color:var(--lpf-muted);transition:background .15s var(--lpf-ease),color .15s var(--lpf-ease)}
    .lpf-more:hover{background:var(--lpf-hover);color:var(--lpf-hover-text)}
    .lpf-empty{padding:4px 12px 10px;font-size:12px;color:var(--lpf-muted);line-height:1.6}
    /* 侧栏滚动条：细窄、半透明，悬浮加深（只作用于承载本面板的滚动区） */
    .ds-scroll-area:has(#lidow-project-folders)::-webkit-scrollbar{width:6px;height:6px}
    .ds-scroll-area:has(#lidow-project-folders)::-webkit-scrollbar-track{background:transparent}
    .ds-scroll-area:has(#lidow-project-folders)::-webkit-scrollbar-thumb{border-radius:99px;
      background:color-mix(in srgb,currentColor 16%,transparent)}
    .ds-scroll-area:has(#lidow-project-folders):hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 32%,transparent)}
    #lidow-timeline{position:fixed;right:2px;top:92px;bottom:96px;width:7px;z-index:2147483000;
      border-radius:99px;background:transparent;transition:width .16s,background .16s;cursor:pointer}
    #lidow-timeline:hover{width:34px;background:rgba(127,127,127,.13)}
    #lidow-timeline .lt-node{position:absolute;right:1px;height:2px;width:5px;border-radius:2px;
      background:rgba(127,127,127,.5);transition:width .12s,background .12s}
    #lidow-timeline:hover .lt-node{width:24px;background:rgba(127,127,127,.55)}
    #lidow-timeline .lt-node.active{background:#5b8cff;width:7px;height:3px}
    #lidow-timeline:hover .lt-node.active{width:28px}
    #lidow-timeline .lt-node:hover{background:#8fa8ff;width:28px}
    html.lidow-timeline-on div[style*='--scroll-nav-page-padding']{display:none!important}
  `
  document.head.appendChild(style)
}

function findProjectFolderMount(): HTMLElement | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]')].filter(
    visible
  )
  if (links.length === 0) return null
  const scroll = links[0]!.closest('.ds-scroll-area')
  if (!scroll) return null
  const candidate = [...scroll.children].find((child) =>
    child.querySelector('a[href*="/a/chat/s/"]')
  )
  return (candidate as HTMLElement | undefined) ?? null
}

function projectFolderChats(): { chat: { url: string }; project: string }[] {
  return (projectFolders?.projects ?? []).flatMap((p) =>
    p.chats.map((chat) => ({ chat, project: p.id }))
  )
}

/** 结构签名：数据 + 折叠/展开/显示全部，状态没变时轮询不重建 DOM（否则展开动画会被打断） */
function folderSig(): string {
  return JSON.stringify({
    data: projectFolders,
    collapsed: projectFoldersCollapsed,
    expanded: [...projectFoldersExpanded],
    showAll: [...projectFoldersShowAll]
  })
}

/** 深色网页用暗色令牌；浅色网页保持规范里的浅白主题 */
function sidebarIsDark(textColor: string): boolean {
  const parse = (c: string): { lum: number; alpha: number } | null => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(c)
    if (!m) return null
    const lum = Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114
    return { lum, alpha: m[4] === undefined ? 1 : Number(m[4]) }
  }
  const bg = parse(getComputedStyle(document.body).backgroundColor)
  if (bg && bg.alpha > 0.1) return bg.lum < 128
  const text = parse(textColor)
  return Boolean(text && text.lum > 160)
}

function setPendingFolder(projectId: string, urlKey: string): void {
  pendingFolderProject = projectId
  pendingFolderUrl = urlKey
  if (pendingFolderTimer !== undefined) window.clearTimeout(pendingFolderTimer)
  pendingFolderTimer = window.setTimeout(() => {
    pendingFolderTimer = undefined
    pendingFolderProject = ''
    pendingFolderUrl = ''
    paintProjectFolderActive()
  }, 12_000)
  paintProjectFolderActive()
}

function paintProjectFolderActive(): void {
  if (!projectFolders) return
  const activeProject = pendingFolderProject || projectFolders.activeProjectId || ''
  const activeUrl = pendingFolderUrl || chatUrlKey(location.href)
  for (const el of document.querySelectorAll<HTMLElement>(
    '#lidow-project-folders .lpf-project-head'
  )) {
    el.classList.toggle('active', el.dataset.id === activeProject)
  }
  for (const el of document.querySelectorAll<HTMLElement>('#lidow-project-folders .lpf-chat')) {
    el.classList.toggle('active', chatUrlKey(el.dataset.url ?? '') === activeUrl)
  }
}

/** 优先点击侧栏里已有的对话链接（SPA 切换），避免整页 reload 导致面板消失 3 秒 */
function openChatInPage(url: string): boolean {
  let target: URL
  try {
    target = new URL(url, location.href)
  } catch {
    return false
  }
  const path = target.pathname.replace(/\/+$/, '')
  const id = path.split('/').filter(Boolean).pop() ?? ''
  if (!id) return false
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]')].filter(
    visible
  )
  const match =
    links.find((a) => {
      try {
        const u = new URL(a.href, location.href)
        return u.origin === target.origin && u.pathname.replace(/\/+$/, '') === path
      } catch {
        return false
      }
    }) ?? links.find((a) => String(a.href).includes(id))
  if (!match) return false
  suppressActivateUntil = Date.now() + 1500
  suppressChatKey = chatUrlKey(url)
  match.setAttribute('data-lidow-suppress', '1')
  window.setTimeout(() => match.removeAttribute('data-lidow-suppress'), 2000)
  match.click()
  return true
}

function renderProjectFolders(): void {
  if (!isDeepSeekPage()) return
  ensureDeepSeekStyles()
  const existing = document.getElementById('lidow-project-folders')
  if (!projectFolders || projectFolders.projects.length === 0) {
    existing?.remove()
    projectFoldersSig = ''
    return
  }
  if (!projectFoldersSeeded) {
    projectFoldersSeeded = true
    projectFoldersActiveSeen = projectFolders.activeProjectId ?? ''
    if (projectFoldersActiveSeen) projectFoldersExpanded.add(projectFoldersActiveSeen)
  } else if (
    projectFolders.activeProjectId &&
    projectFoldersActiveSeen !== projectFolders.activeProjectId
  ) {
    projectFoldersActiveSeen = projectFolders.activeProjectId
    projectFoldersExpanded.add(projectFoldersActiveSeen)
  }
  // 主进程/网页导航确认后清掉乐观高亮
  if (pendingFolderProject && projectFolders.activeProjectId === pendingFolderProject)
    pendingFolderProject = ''
  if (pendingFolderUrl && chatUrlKey(location.href) === pendingFolderUrl) pendingFolderUrl = ''
  if (!pendingFolderProject && !pendingFolderUrl && pendingFolderTimer !== undefined) {
    window.clearTimeout(pendingFolderTimer)
    pendingFolderTimer = undefined
  }
  const activeProjectForUi = pendingFolderProject || projectFolders.activeProjectId || ''
  const sig = folderSig()
  if (existing && existing.isConnected && sig === projectFoldersSig) {
    paintProjectFolderActive()
    return
  }
  const mount = findProjectFolderMount()
  if (!mount) return
  // 用一条“非当前选中”的原生聊天链接取样，避免把激活态的蓝色当成正文色
  const nativeLinks = [...mount.querySelectorAll<HTMLElement>('a[href*="/a/chat/s/"]')]
  const nativeLink =
    nativeLinks.find(
      (a) =>
        a.getAttribute('aria-current') !== 'page' &&
        !/(^|[-_ ])(active|selected|current)([-_ ]|$)/i.test(String(a.className))
    ) ?? nativeLinks[0]
  const nativeStyle = nativeLink ? getComputedStyle(nativeLink) : getComputedStyle(mount)
  const total = projectFolders.projects.reduce((n, p) => n + p.chats.length, 0)
  const folderClosedSvg =
    '<svg class="lpf-folder-closed" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
  const folderOpenSvg =
    '<svg class="lpf-folder-open" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>'
  const docSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>'
  const moreSvg =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.8" cy="8" r="1.15"/></svg>'
  const body = projectFolders.projects
    .map((project) => {
      const open = projectFoldersExpanded.has(project.id)
      const showAll = projectFoldersShowAll.has(project.id)
      const visibleChats = showAll ? project.chats : project.chats.slice(0, 8)
      const chats =
        visibleChats
          .map(
            (chat) =>
              `<div class="lpf-chat" data-lpf="chat" data-url="${escapeHtml(chat.url)}" title="${escapeHtml(chat.title)}">` +
              `<span class="lpf-doc">${docSvg}</span>` +
              `<span class="lpf-chat-title">${escapeHtml(chat.title)}</span>` +
              `<span class="lpf-more-icon" data-lpf="chat-more" data-url="${escapeHtml(chat.url)}" title="在浏览器中打开">${moreSvg}</span>` +
              `</div>`
          )
          .join('') +
        (project.chats.length > 8
          ? `<button class="lpf-more" data-lpf="more" data-id="${escapeHtml(project.id)}">${
              showAll ? '收起' : `显示全部 ${project.chats.length} 条`
            }</button>`
          : '')
      return (
        `<div class="lpf-project">` +
        `<div class="lpf-project-head${activeProjectForUi === project.id ? ' active' : ''}${open ? ' open' : ''}" data-lpf="project" data-id="${escapeHtml(project.id)}">` +
        `<span class="lpf-chev${open ? ' open' : ''}">›</span>` +
        `<span class="lpf-folder">${folderClosedSvg}${folderOpenSvg}</span>` +
        `<span class="lpf-name" title="${escapeHtml(project.root)}">${escapeHtml(project.name)}</span>` +
        // 0 条会话不显示计数药丸，否则空文件夹右侧会多出一列灰色空块
        (project.chats.length > 0 ? `<span class="lpf-count">${project.chats.length}</span>` : '') +
        `</div>` +
        `<div class="lpf-collapse${open ? ' open' : ''}"><div><div class="lpf-chats">${chats}</div></div></div>` +
        `</div>`
      )
    })
    .join('')
  const html =
    `<button class="lpf-head" data-lpf="toggle">` +
    `<span class="lpf-chevron${projectFoldersCollapsed ? '' : ' open'}">›</span>` +
    `<span>项目文件夹</span>` +
    `<span class="lpf-badge">${total}</span>` +
    `</button>` +
    `<div class="lpf-collapse${projectFoldersCollapsed ? '' : ' open'}"><div>${body}</div></div>`
  let panel = existing as HTMLElement | null
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'lidow-project-folders'
    panel.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-lpf]')
      if (!target) return
      const action = target.dataset.lpf
      if (action === 'toggle') {
        projectFoldersCollapsed = !projectFoldersCollapsed
        const panelEl = document.getElementById('lidow-project-folders')
        panelEl
          ?.querySelector('.lpf-head .lpf-chevron')
          ?.classList.toggle('open', !projectFoldersCollapsed)
        panelEl
          ?.querySelector(':scope > .lpf-collapse')
          ?.classList.toggle('open', !projectFoldersCollapsed)
        projectFoldersSig = folderSig()
      } else if (action === 'project') {
        const id = target.dataset.id ?? ''
        const openNow = !projectFoldersExpanded.has(id)
        if (openNow) projectFoldersExpanded.add(id)
        else projectFoldersExpanded.delete(id)
        // 直接切换 class 而不是整块重绘：重绘会把 0.2s 展开动画打断
        const head = target.closest<HTMLElement>('.lpf-project-head')
        head?.classList.toggle('open', openNow)
        head?.querySelector('.lpf-chev')?.classList.toggle('open', openNow)
        head?.parentElement
          ?.querySelector<HTMLElement>(':scope > .lpf-collapse')
          ?.classList.toggle('open', openNow)
        projectFoldersSig = folderSig()
      } else if (action === 'more') {
        const id = target.dataset.id ?? ''
        if (projectFoldersShowAll.has(id)) projectFoldersShowAll.delete(id)
        else projectFoldersShowAll.add(id)
        projectFoldersSig = ''
        renderProjectFolders()
      } else if (action === 'chat-more') {
        const url = target.dataset.url
        if (url) send({ type: 'float-menu-action', action: 'open-external', url })
      } else if (action === 'chat') {
        const url = target.dataset.url
        if (url) {
          const key = chatUrlKey(url)
          const found = projectFolderChats().find((x) => chatUrlKey(x.chat.url) === key)
          setPendingFolder(found?.project ?? '', key)
          clearNativeNewChat()
          firstRunCollapsed = false
          if (found) {
            projectFoldersExpanded.add(found.project)
            projectFoldersSig = ''
            renderProjectFolders()
          }
          renderFirstRun()
          send({ type: 'activate-chat', url, reload: true })
        }
      }
    })
  }
  panel.innerHTML = html
  panel.classList.toggle('lpf-dark', sidebarIsDark(nativeStyle?.color ?? ''))
  if (nativeStyle) {
    panel.style.setProperty('--lpf-text', nativeStyle.color)
    panel.style.setProperty('--lpf-font', nativeStyle.fontFamily)
  }
  if (panel.parentElement !== mount.parentElement || panel.nextElementSibling !== mount) {
    mount.insertAdjacentElement('beforebegin', panel)
  }
  projectFoldersSig = sig
  paintProjectFolderActive()
}

function setupProjectFolderClicks(): void {
  document.addEventListener(
    'click',
    (ev) => {
      if (!isDeepSeekPage() || !projectFolders) return
      if (ev.button !== 0) return
      const target = ev.target as HTMLElement | null
      if (
        !target ||
        target.closest('#lidow-project-folders, #lidow-first-run, #lidow-first-run-banner')
      )
        return
      const link = target.closest<HTMLAnchorElement>('a[href*="/a/chat/s/"]')
      if (!link) return
      // 程序化 SPA 切换自己点的那一条：不要再当成用户切项目
      if (link.getAttribute('data-lidow-suppress') === '1') return
      const key = chatUrlKey(link.href)
      if (!key) return
      // 只放行程序化点击的那一个对话；用户随后点别的对话仍然要正常切项目
      if (Date.now() < suppressActivateUntil && key === suppressChatKey) {
        suppressActivateUntil = 0
        suppressChatKey = ''
        return
      }
      const found = projectFolderChats().find((x) => chatUrlKey(x.chat.url) === key)
      if (!found) return
      const action = target.closest('button,[role="button"],[aria-haspopup]')
      if (action && action !== link) return
      setPendingFolder(found.project, key)
      projectFoldersExpanded.add(found.project)
      projectFoldersSig = ''
      renderProjectFolders()
      clearNativeNewChat()
      firstRunCollapsed = false
      renderFirstRun()
      ev.preventDefault()
      ev.stopPropagation()
      send({ type: 'activate-chat', url: link.href })
    },
    true
  )
}

function startProjectFolderWatch(): void {
  if (projectFolderTimer !== undefined) return
  let timelineTick = 0
  projectFolderTimer = window.setInterval(() => {
    if (!isDeepSeekPage()) return
    renderProjectFolders()
    // 时间线要扫全部消息，成本高一些；保持 ~2.4s 刷新
    if (timelineTick++ % 3 === 0) renderTimeline()
  }, 800)
}

// ---------- 长会话时间线 ----------

function timelineMessages(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.ds-message')].filter(visible)
}

function renderTimeline(): void {
  if (!isDeepSeekPage()) return
  ensureDeepSeekStyles()
  const messages = timelineMessages()
  const existing = document.getElementById('lidow-timeline')
  if (messages.length < 8) {
    existing?.remove()
    document.documentElement.classList.remove('lidow-timeline-on')
    return
  }
  document.documentElement.classList.add('lidow-timeline-on')
  const rail =
    existing ??
    (() => {
      const el = document.createElement('div')
      el.id = 'lidow-timeline'
      el.addEventListener('click', (ev) => {
        const node = (ev.target as HTMLElement).closest<HTMLElement>('[data-lt-index]')
        if (!node) return
        const index = Number(node.dataset.ltIndex)
        timelineMessages()[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      document.body.appendChild(el)
      return el
    })()
  const nodes = messages.map((el) => ({
    label: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '消息'
  }))
  const target = window.innerHeight * 0.25
  let activeIndex = -1
  let best = Infinity
  messages.forEach((el, index) => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return
    const distance = Math.abs(rect.top - target)
    if (distance < best) {
      best = distance
      activeIndex = index
    }
  })
  rail.innerHTML = nodes
    .map((node, index) => {
      const pct = nodes.length === 1 ? 50 : (index / (nodes.length - 1)) * 100
      return `<div class="lt-node${index === activeIndex ? ' active' : ''}" data-lt-index="${index}" title="${escapeHtml(node.label)}" style="top:calc(${pct}% - 1px)"></div>`
    })
    .join('')
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
  const onLoginPage =
    /\/sign_?in\b|\/login\b|\/auth\b|accounts\.google\.com|\/i\/flow\/login/i.test(url)
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
  const loginBtn = [
    ...document.querySelectorAll<HTMLElement>('button, div[role="button"], a')
  ].find((el) => {
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
  const previousUrl = lastNavUrl
  const urlChanged = url !== lastNavUrl
  const titleChanged = pageTitle !== lastPageTitle
  if (urlChanged || titleChanged) {
    lastNavUrl = url
    lastPageTitle = pageTitle
    // 标题也要上报：平台会按内容自动命名/用户会重命名，侧栏必须对齐网页
    send({ type: 'nav', url, title: pageTitle })
  }
  if (urlChanged) {
    // 这里绝不因普通 URL 变化重置 dismissed。
    // 反例（实测反复踩中）：初始化发完第一条消息后页面会从 / 跳到 /a/chat/s/<id>，
    // 这是同一次会话的正常跳转。任何基于「URL 变了」的重置都会导致
    // 用户刚点完确认又弹一遍。只有「旧对话 → 新对话页」才解绑并重新给初始化入口
    //（ChatGPT 新 UI 的按钮叫“新聊天”，只靠文案会漏）。
    evaluateLoginNow()
    if (isConversationUrl(previousUrl) && isNewChatUrl(url)) {
      firstRunDismissed = false
      firstRunCollapsed = false
      projectInitialized = false
      markNativeNewChat()
      clearFirstRunPersisted()
      window.setTimeout(renderFirstRun, 700)
    } else {
      renderFirstRun()
    }
  }
  renderGoogleLoginNotice()
  // 平台首屏渲染/路由切换可能把挂到 body 的悬浮球冲掉（配置只下发一次），
  // 每秒补一次，保证「初始化项目 / 切换目录」入口始终可用。
  if (adapter && !document.getElementById('lidow-ball')) setupFloatingBall()
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
      const inner = Array.from(el.querySelectorAll<HTMLElement>('div')).find((d) =>
        d.textContent?.includes('使用环境异常')
      )
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
window.setInterval(scanMessageFold, 1600)

// 平台还在生成、但暂时没有新文本（长思考/停顿）时发心跳：
// 主进程据此重置看门狗与截断宽限，不能把“AI 正在想”误判成卡死并插话。
setInterval(() => {
  if (isStreaming() || streaming) send({ type: 'stream-heartbeat' })
}, 2000)

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
      /** 主世界 hook 用它判断这条请求是不是 lidow 自己发的（消费一次标记） */
      isOutgoing: (text: string): boolean => {
        const t = normalizePromptText(String(text ?? ''))
        if (lastOutgoing.text && t === lastOutgoing.text && Date.now() - lastOutgoing.ts < 60_000) {
          lastOutgoing = { text: '', ts: 0 }
          return true
        }
        return false
      },
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
            const st =
              detail.status === 'stopped'
                ? 'stopped'
                : detail.status === 'finished'
                  ? 'finished'
                  : 'error'
            const tu = detail.tokenUsage as { accumulatedTokens?: number } | null | undefined
            send({
              type: 'net-response',
              text: String(detail.text ?? ''),
              status: st,
              reason: detail.reason === undefined ? undefined : String(detail.reason),
              tokens: typeof tu?.accumulatedTokens === 'number' ? tu.accumulatedTokens : undefined
            })
          } else if (kind === 'error') {
            send({
              type: 'net-error',
              text: String(detail.text ?? ''),
              reason: String(detail.reason ?? 'unknown')
            })
          } else if (kind === 'prompt') {
            // 用户在网页输入框里亲手发送的消息：同步回纯净模式会话
            send({ type: 'user-message', text: String(detail.text ?? '') })
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
 * 用户点了平台自己的「开启新对话」。
 * 这个动作可能触发平台整页导航，preload 重跑后 projectInitialized 会被主进程
 * 按旧会话重新置为 true，引导又被压掉。用 sessionStorage 跨重载标记“这是新对话”，
 * 在 2 分钟内强制显示初始化入口，直到用户确认/关闭。
 */
const NATIVE_NEW_CHAT_KEY = 'lidow:nativeNewChatAt'
const NATIVE_NEW_CHAT_TTL_MS = 2 * 60_000
let nativeNewChatAt = 0

function markNativeNewChat(): void {
  nativeNewChatAt = Date.now()
  try {
    sessionStorage.setItem(NATIVE_NEW_CHAT_KEY, String(nativeNewChatAt))
  } catch {
    /* 隐私模式/无存储时内存标记仍有效 */
  }
}

function isNativeNewChatPending(): boolean {
  if (!nativeNewChatAt) {
    try {
      nativeNewChatAt = Number(sessionStorage.getItem(NATIVE_NEW_CHAT_KEY) ?? '') || 0
    } catch {
      nativeNewChatAt = 0
    }
  }
  return nativeNewChatAt > 0 && Date.now() - nativeNewChatAt < NATIVE_NEW_CHAT_TTL_MS
}

function clearNativeNewChat(): void {
  nativeNewChatAt = 0
  try {
    sessionStorage.removeItem(NATIVE_NEW_CHAT_KEY)
  } catch {
    /* ignore */
  }
}

/** 平台的新对话页：根路径、/new、/chat、/app；具体对话路径不算 */
function isNewChatUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.origin !== location.origin) return false
    const p = u.pathname.replace(/\/+$/, '')
    return p === '' || p === '/new' || p === '/chat' || p === '/app' || p.endsWith('/new')
  } catch {
    return false
  }
}

/** 具体的网页对话路径（用于识别「从旧对话切回新对话页」） */
function isConversationUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.origin !== location.origin) return false
    const p = u.pathname
    return (
      /\/c\/[a-z0-9-]{8,}/i.test(p) ||
      /\/(?:a\/)?chat\/s\/[a-z0-9-]+/i.test(p) ||
      /\/chat\/[a-z0-9-]{8,}/i.test(p)
    )
  } catch {
    return false
  }
}

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
  const nativeNewChat = isNativeNewChatPending()
  // 平台自己的「新对话」不受 projectInitialized 压制：旧会话还有历史，
  // 但这条新对话尚未绑定任何 Lidow 会话，必须先提供初始化入口。
  const shouldShow =
    loggedIn &&
    projectKnown &&
    !firstRunDismissed &&
    !persisted &&
    (nativeNewChat || !projectInitialized)
  exposeState({
    loggedIn,
    projectKnown,
    projectRoot,
    initialized: projectInitialized,
    nativeNewChat,
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
    clearNativeNewChat()
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
    clearNativeNewChat()
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
    clearNativeNewChat()
    persistFirstRunDismissed(projectRoot)
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
  // 报错页可能被平台承载在 chatgpt.com 等域名下，不能只依赖 hostname
  const blockedText =
    /此浏览器或应用可能不安全|browser or app may not be secure|disallowed_useragent/i.test(pageText)
  const blocked = blockedText || (onGoogle && /无法登录|sign in|登录/i.test(pageText))
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
    '<div class="gb-text">Google 不允许在应用内浏览器完成登录。请返回上一步，在平台登录页改用邮箱/验证码；系统浏览器只用于查看/登录，登录态不会自动同步回 Lidow。</div>' +
    '<div class="gb-actions">' +
    '<button class="gb-btn ghost" data-act="back">返回上一步（改用邮箱）</button>' +
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
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, div[role="button"], [class*="button"]'
  )
  for (const kw of keywords) {
    for (const el of candidates) {
      const t = [el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.title ?? '']
        .join(' ')
        .trim()
      if (t === kw || t.startsWith(kw) || t.includes(kw)) return el
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
    const thinkBtn = findToggleButton(['深度思考', '深度思考（R1）', '思考', 'Thinking'])
    const searchBtn = findToggleButton(['智能搜索', '联网搜索', '搜索', 'Search'])
    send({
      type: 'toggle-state',
      think: isToggleActive(thinkBtn),
      search: isToggleActive(searchBtn),
      // 页面上是否存在对应开关：纯净模式据此决定要不要显示 chip（适配所有平台）
      thinkAvailable: Boolean(thinkBtn),
      searchAvailable: Boolean(searchBtn)
    })
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
  const NEW_CHAT_KWS = [
    '开启新对话',
    '新建对话',
    '新对话',
    '新聊天',
    '新建聊天',
    '新会话',
    '开始新对话',
    'New chat'
  ]
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
          const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
          // 只认真实可点击元素，且文案必须完全匹配。之前用 startsWith + 祖先文本，
          // 点原生会话链接时会把整个侧栏（含“开启新对话”按钮）误判成新对话。
          const clickable =
            el.matches?.('button, a, [role="button"], [role="menuitem"]') ||
            getComputedStyle(el).cursor === 'pointer'
          const insideChatLink = Boolean(el.closest?.('a[href*="/a/chat/s/"]'))
          const isNewChat =
            clickable &&
            !insideChatLink &&
            t.length <= 16 &&
            NEW_CHAT_KWS.some((k) => t === k || t.toLowerCase() === k.toLowerCase())
          if (isNewChat) {
            // 等平台自己完成路由跳转后再弹，避免被它随后的渲染覆盖。
            // 显式开新对话要解除「已初始化」标记，否则新对话里引导永远不再出现。
            firstRunDismissed = true // 先压住，等 URL 真变了再放开
            projectInitialized = false
            markNativeNewChat()
            clearFirstRunPersisted()
            // 主进程据此解绑旧会话：否则新对话的消息仍会记到旧会话上
            send({ type: 'native-new-chat' })
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
  if (existing)
    return {
      show: () => existing.classList.remove('lidow-hidden'),
      hide: () => existing.classList.add('lidow-hidden')
    }

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
  box.innerHTML =
    '<span class="tm-spin"></span><span id="lidow-tool-mask-text">工具执行中…</span><button class="tm-stop">停止</button>'
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
        overlayConfigured = true
        if (readyTimer) {
          clearInterval(readyTimer)
          readyTimer = null
        }
        watchMessages()
        setupFloatingBall()
        watchNativeNewChat()
        lastPageSnapshot = ''
        pageSnapshotTries = 0
        schedulePageSnapshot()
        // 不等 1 秒轮询：适配器刚下发就按当前页面评估登录/初始化，尽早给出入口
        evaluateLoginNow()
        renderFirstRun()
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
      // 已初始化且页面落在具体对话上：之前“新对话”的 pending 已失效，
      // 不能再让它在切回历史会话时强制弹初始化。
      if (cmd.initialized && /\/chat\/s\/[a-f0-9-]+/i.test(location.pathname)) clearNativeNewChat()
      // 注意：这里不能重置 firstRunDismissed —— set-project 会在每次 configure
      // （切会话/重载页面）时下发，重置会让用户关掉的模态反复弹出来。
      // 只有「刚完成初始化」才需要重新评估，那由主进程在选完目录后单独通知。
      evaluateLoginNow()
      renderFirstRun()
      break
    case 'watch-chats':
      setWatchedChats(cmd.urls)
      break
    case 'project-folders':
      projectFolders = cmd.folders ?? null
      projectFoldersSig = ''
      renderProjectFolders()
      break
    case 'open-chat':
      send({ type: 'open-chat-result', ok: cmd.url ? openChatInPage(cmd.url) : false })
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
setupProjectFolderClicks()
startProjectFolderWatch()

// 注意：不在这里主动渲染。无项目时由主进程「按 webview」下发 set-project，
// 避免有项目时先闪一下引导再被 configure 收起。

function announceReady(): void {
  if (overlayConfigured) return
  send({ type: 'ready' })
  readyAttempts += 1
  if (readyAttempts >= 60 && readyTimer) {
    clearInterval(readyTimer)
    readyTimer = null
  }
}
announceReady()
readyTimer = setInterval(announceReady, 2000)
