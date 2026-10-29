import { nanoid } from 'nanoid'
import { join } from 'node:path'
import { JsonStore } from '@main/infra/store'
import type { DomAdapter, ProviderAccount, ProviderDescriptor } from '@shared/types'

/**
 * Provider 注册表：内置三平台（选择器取自 cuckoo-code 实测值）+ 用户自定义模板 + 多账号。
 * 每个账号一个 Electron partition（session），登录态互不干扰。
 */

const GENERIC_ADAPTER: DomAdapter = {
  input: ['textarea[placeholder*="输入"]', 'textarea[placeholder*="message" i]', 'textarea', 'div[contenteditable="true"]', '[role="textbox"]'],
  send: ['button[type="submit"]', 'button[aria-label*="send" i]', 'button[aria-label*="发送"]', '[data-testid="send-button"]', 'button:has(svg[data-icon="send"])'],
  messages: ['[class*="message-list"]', '[class*="chat-list"]', 'main'],
  bubble: ['[class*="message"]', '[class*="bubble"]', '[data-message]'],
  streamingFlag: ['button[aria-label*="停止" i]', 'button[aria-label*="stop" i]', '[class*="stop-button"]'],
  newChat: ['a[href*="/chat/new"]', 'button[aria-label*="新" i]', '[class*="new-chat"]'],
  loginFlag: ['[class*="user-avatar"]', 'img[class*="avatar"]']
}

const DEEPSEEK: ProviderDescriptor = {
  id: 'deepseek',
  name: 'DeepSeek',
  home: 'https://chat.deepseek.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: [
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="ask" i]',
      'textarea[placeholder*="send" i]',
      'textarea[placeholder*="DeepSeek" i]',
      'textarea.chat-input',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]'
    ],
    // DeepSeek 用 <div role="button" class="ds-button ds-button--primary ..."> 而非 <button>，
    // 因此必须匹配 div[role=button]；旧选择器只能命中 <button> 元素 → 发送永远点不到。
    send: [
      // DeepSeek：圆形主色按钮（div[role=button]，无 <button> 元素）
      'div[role="button"].ds-button--primary.ds-button--circle',
      'div[role="button"].ds-button--primary.ds-button--filled',
      'div[role="button"][class*="ds-button--primary"]',
      'button[type="submit"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="发送"]',
      '[data-testid="send-button"]'
      // 注意：不要再加 button:has(>svg) 之类宽匹配——会命中顶部工具栏图标，点错
    ],
    messages: ['div.ds-markdown', 'div[class*="ds-markdown"]', 'main'],
    bubble: [
      'div.ds-markdown--block',
      'div[class*="ds-markdown--block"]',
      'div[class*="markdown"]',
      '[class*="message-item"]'
    ],
    // 停止按钮同为 div[role=button]；命中"停止/stop"文案或 danger 变体
    streamingFlag: [
      'div[role="button"][class*="ds-button"][class*="danger"]',
      'div[class*="stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="stop" i]'
    ],
    newChat: ['a[class*="new-chat"]', 'button[aria-label*="开始新对话"]', 'a[href="https://chat.deepseek.com/"]'],
    composerActions: [
      { label: '深度思考', keywords: ['深度思考', '深度思考（R1）'] },
      { label: '智能搜索', keywords: ['智能搜索', '联网搜索'] }
    ],
    // 登录标志：DeepSeek 登录后左侧栏顶部出现用户头像块。
    // 不能用带哈希的类名（._9d8da05 之类）—— 平台每次发版都会变。
    // 未登录时页面是 /sign_in，直接看有没有输入框更稳。
    loginFlag: ['[class*="user-avatar"]', 'img[class*="avatar"]', '[class*="avatar"]']
  }
}

const CLAUDE: ProviderDescriptor = {
  id: 'claude',
  name: 'Claude',
  home: 'https://claude.ai/new',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['div[role="textbox"].tiptap', 'div[role="textbox"]', 'div.ProseMirror', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[aria-label="Send message"]', '[data-testid="chat-input-send"]', 'button[aria-label*="send" i]', 'button[aria-label*="Send"]'],
    messages: ['[data-testid="chat-messages"]', 'main'],
    bubble: ['[data-testid="user-message"]', 'div.font-claude-message', '[data-is-streaming]'],
    streamingFlag: ['button[aria-label*="Stop"]', '[data-is-streaming="true"]'],
    newChat: ['a[href="/new"]', 'button[aria-label*="New chat" i]'],
    loginFlag: ['.df-user-menu-btn', 'img[class*="avatar"]']
  }
}

const CHATGPT: ProviderDescriptor = {
  id: 'chatgpt',
  name: 'ChatGPT',
  home: 'https://chatgpt.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['div[contenteditable="true"].ProseMirror', 'div[role="textbox"]', 'div.ProseMirror', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
    messages: ['main [class*="react-scroll-to-bottom"]', 'main'],
    bubble: ['[data-message-author-role]', 'div[class*="agent-turn"]'],
    streamingFlag: ['button[data-testid="stop-button"]', 'button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    newChat: ['a[href="/"]', 'button[aria-label*="New chat" i]'],
    loginFlag: ['img[alt*="Profile"]', '[data-testid="profile-button"]']
  }
}

const DOUBAO: ProviderDescriptor = {
  id: 'doubao',
  name: '豆包',
  home: 'https://www.doubao.com/chat/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['textarea[placeholder*="输入"]', 'textarea[data-testid="chat_input_input"]', 'textarea', 'div[contenteditable="true"]', '[role="textbox"]'],
    send: ['button[data-testid="chat_input_send_button"]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
    messages: ['[data-testid="conversation_container"]', 'main'],
    bubble: ['[data-testid="receive_message"]', '[data-testid="message_item_content"]'],
    streamingFlag: ['button[data-testid="chat_input_stop_button"]', 'button[aria-label*="停止"]'],
    newChat: ['button[data-testid="new_session"]', 'button[aria-label*="新会话"]'],
    composerActions: [
      { label: '对话', keywords: ['对话'] },
      { label: '项目', keywords: ['项目'] },
      { label: '技能', keywords: ['技能'] },
      { label: '快速', keywords: ['快速'] }
    ],
    loginFlag: ['img[class*="avatar"]', '[class*="user-info"]']
  }
}

const QWEN: ProviderDescriptor = {
  id: 'qwen',
  name: '通义千问',
  home: 'https://www.tongyi.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['textarea[placeholder*="问题"]', 'textarea[placeholder*="输入"]', 'textarea', 'div[contenteditable="true"]'],
    send: ['button[class*="send"]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
    messages: ['[class*="answerContainer"]', '[class*="chat-window"]', 'main'],
    bubble: ['[class*="answerItem"]', '[class*="tongyi-markdown"]'],
    streamingFlag: ['button[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['button[class*="new"]', 'a[href*="chat"]'],
    loginFlag: ['img[class*="avatar"]']
  }
}

const ERNIE: ProviderDescriptor = {
  id: 'wenxin',
  name: '文心一言',
  home: 'https://yiyan.baidu.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['textarea[placeholder*="和文心"]', 'textarea[placeholder*="输入"]', 'textarea', 'div[contenteditable="true"]'],
    send: ['button[class*="send-btn"]', 'button[aria-label*="发送"]', '#sendBtn'],
    messages: ['[class*="answer-item"]', '#app'],
    bubble: ['[class*="answer-item"]', '[class*="markdown-body"]'],
    streamingFlag: ['button[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['button[aria-label*="新对话"]', 'a[class*="new"]'],
    loginFlag: ['img[class*="avatar"]', '[class*="username"]']
  }
}

const KIMI: ProviderDescriptor = {
  id: 'kimi',
  name: 'Kimi',
  home: 'https://www.kimi.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['textarea[placeholder*="发消息"]', 'textarea', 'div[contenteditable="true"]'],
    send: ['button[class*="send"]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
    messages: ['[class*="message-list"]', 'main'],
    bubble: ['[class*="bubble"]', '[class*="markdown"]'],
    streamingFlag: ['button[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['button[aria-label*="新会话"]', 'a[class*="new"]'],
    loginFlag: ['img[class*="avatar"]']
  }
}

const GLM: ProviderDescriptor = {
  id: 'chatglm',
  name: '智谱清言',
  home: 'https://chatglm.cn/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: ['textarea[placeholder*="输入"]', 'textarea', 'div[contenteditable="true"]'],
    send: ['button[class*="send"]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
    messages: ['[class*="message"]', 'main'],
    bubble: ['[class*="answer"]', '[class*="markdown"]'],
    streamingFlag: ['button[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['button[aria-label*="新对话"]'],
    loginFlag: ['img[class*="avatar"]']
  }
}

/** 内置平台表：无项目时也要能打开 AI 页面（首次引导注入在里面） */
export const BUILT_IN_PROVIDERS: ProviderDescriptor[] = [DEEPSEEK, CLAUDE, CHATGPT, DOUBAO, QWEN, ERNIE, KIMI, GLM]

interface ProviderStoreData {
  providers: ProviderDescriptor[]
}

/** projectStoreDir: 每个项目独立 provider 配置（含账号） */
export class ProviderRegistry {
  private store: JsonStore<ProviderStoreData>

  constructor(storeDir: string) {
    this.store = new JsonStore<ProviderStoreData>(join(storeDir, 'providers.json'), {
      providers: structuredClone(BUILT_IN_PROVIDERS)
    })
  }

  list(): ProviderDescriptor[] {
    return this.store.get().providers
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.list().find((p) => p.id === id)
  }

  add(desc: { id: string; name: string; home: string; adapter?: Partial<DomAdapter> }): ProviderDescriptor {
    if (this.get(desc.id)) throw new Error(`Provider 已存在: ${desc.id}`)
    const provider: ProviderDescriptor = {
      id: desc.id,
      name: desc.name,
      home: desc.home,
      builtIn: false,
      enabled: true,
      accounts: [],
      adapter: { ...GENERIC_ADAPTER, ...desc.adapter }
    }
    this.store.update((d) => ({ providers: [...d.providers, provider] }))
    return provider
  }

  remove(id: string): void {
    this.store.update((d) => ({ providers: d.providers.filter((p) => p.id !== id || p.builtIn) }))
  }

  update(id: string, patch: Partial<ProviderDescriptor>): ProviderDescriptor {
    this.store.update((d) => ({
      providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch, id: p.id, builtIn: p.builtIn } : p))
    }))
    const p = this.get(id)
    if (!p) throw new Error(`Provider 不存在: ${id}`)
    return p
  }

  /** 新增账号：一个账号一个 partition，登录态隔离 */
  addAccount(providerId: string, label: string): ProviderAccount {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`Provider 不存在: ${providerId}`)
    const account: ProviderAccount = {
      id: `acc_${nanoid(6)}`,
      label: label || `账号 ${provider.accounts.length + 1}`,
      partition: `persist:lidow-${providerId}-${nanoid(6)}`
    }
    this.update(providerId, { accounts: [...provider.accounts, account] })
    return account
  }

  removeAccount(providerId: string, accountId: string): void {
    const provider = this.get(providerId)
    if (!provider) return
    this.update(providerId, { accounts: provider.accounts.filter((a) => a.id !== accountId) })
  }

  switchAccount(providerId: string, accountId: string): void {
    this.update(providerId, { activeAccountId: accountId })
  }

  partitionOf(providerId: string, accountId?: string): string {
    const provider = this.get(providerId)
    const acc = provider?.accounts.find((a) => a.id === accountId) ?? provider?.accounts[0]
    return acc?.partition ?? `persist:lidow-${providerId}-default`
  }
}
