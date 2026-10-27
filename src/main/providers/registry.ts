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
    send: [
      'button[type="submit"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="发送"]',
      'button[data-action="send"]',
      '[data-testid="send-button"]',
      'button svg[data-icon="send"]',
      'button:has(svg[data-icon="send"])',
      'button:has(> svg)'
    ],
    messages: ['div.ds-markdown', 'main'],
    bubble: ['div.ds-markdown--block', '[class*="message-item"]', 'div[class*="markdown"]'],
    streamingFlag: ['div[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['a[class*="new-chat"]', 'button[aria-label*="开始新对话"]', 'a[href="https://chat.deepseek.com/"]'],
    loginFlag: ['._9d8da05', 'img[class*="avatar"]', '[class*="user-info"]']
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

const BUILT_IN_PROVIDERS: ProviderDescriptor[] = [DEEPSEEK, CLAUDE, CHATGPT]

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
