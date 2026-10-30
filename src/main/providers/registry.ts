import { nanoid } from 'nanoid'
import { join } from 'node:path'
import { JsonStore } from '@main/infra/store'
import type { DomAdapter, ProviderAccount, ProviderDescriptor } from '@shared/types'

/**
 * Provider 注册表：内置三平台（选择器取自 cuckoo-code 实测值）+ 用户自定义模板 + 多账号。
 * 每个账号一个 Electron partition（session），登录态互不干扰。
 */

const GENERIC_ADAPTER: DomAdapter = {
  input: [
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="message" i]',
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]'
  ],
  send: [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="发送"]',
    '[data-testid="send-button"]',
    'button:has(svg[data-icon="send"])'
  ],
  messages: ['[class*="message-list"]', '[class*="chat-list"]', 'main'],
  bubble: ['[class*="message"]', '[class*="bubble"]', '[data-message]'],
  streamingFlag: [
    'button[aria-label*="停止" i]',
    'button[aria-label*="stop" i]',
    '[class*="stop-button"]'
  ],
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
    newChat: [
      'a[class*="new-chat"]',
      'button[aria-label*="开始新对话"]',
      'a[href="https://chat.deepseek.com/"]'
    ],
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
    input: [
      'div[role="textbox"].tiptap',
      'div[role="textbox"]',
      'div.ProseMirror',
      'div[contenteditable="true"]',
      'textarea'
    ],
    send: [
      'button[aria-label="Send message"]',
      '[data-testid="chat-input-send"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="Send"]'
    ],
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
    input: [
      'div[contenteditable="true"].ProseMirror',
      'div[role="textbox"]',
      'div.ProseMirror',
      'div[contenteditable="true"]',
      'textarea'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]'
    ],
    messages: ['main [class*="react-scroll-to-bottom"]', 'main'],
    bubble: [
      '[data-message-author-role]',
      'div[class*="agent-turn"]',
      // 新版 Workspace / 分享页不再用 data-message-author-role，回复正文在 markdown 容器里
      '[class*="markdown" i]',
      '[data-testid*="conversation-turn"]',
      'article'
    ],
    streamingFlag: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]'
    ],
    composerActions: [{ label: '思考', keywords: ['思考', 'Thinking'] }],
    newChat: ['a[href="/"]', 'button[aria-label*="New chat" i]'],
    loginFlag: ['img[alt*="Profile"]', '[data-testid="profile-button"]'],
    profileName: [
      'div.absolute.inset-x-0.bottom-0 button',
      'button[aria-label*="profile" i]',
      '[data-testid="profile-button"]'
    ]
  }
}

const GEMINI: ProviderDescriptor = {
  id: 'gemini',
  name: 'Gemini',
  home: 'https://gemini.google.com/app',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea'
    ],
    send: [
      'button[aria-label*="Send message"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Submit"]',
      'button.send-button'
    ],
    messages: ['chat-window', 'infinite-scroller', 'main'],
    bubble: ['model-response', 'user-query', 'message-content', '[class*="markdown"]'],
    streamingFlag: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'mat-icon[fonticon="stop"]'
    ],
    newChat: ['button[aria-label*="New chat"]', 'button[aria-label*="新对话"]', 'a[href="/app"]'],
    loginFlag: [
      'img[alt*="个人资料"]',
      'a[href*="accounts.google.com"]',
      'button[aria-label*="Google Account"]'
    ],
    profileName: [
      'button[aria-label*="Google Account"]',
      'a[aria-label*="Google Account"]',
      'button[aria-label*="Google 账号"]',
      'a[href*="accounts.google.com"]'
    ],
    model: {
      button: [
        'button.input-area-switch',
        'button[aria-label*="模式选择器"]',
        'button[aria-label*="model selector" i]'
      ],
      items: ['[role="menuitem"]']
    }
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
    input: [
      'textarea[placeholder*="输入"]',
      'textarea[data-testid="chat_input_input"]',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]'
    ],
    send: [
      'button[data-testid="chat_input_send_button"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]'
    ],
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
    model: {
      button: ['[data-testid="chat_input_action_model"]'],
      items: ['[role="menu"] [data-slot="dropdown-menu-item"]']
    },
    profileName: ['[data-sidebar-footer-account-menu] span', '[data-sidebar-footer-account-menu] button span'],
    loginFlag: ['img[class*="avatar"]', '[class*="user-info"]']
  }
}

const QWEN: ProviderDescriptor = {
  id: 'qwen',
  name: '通义千问',
  home: 'https://www.qianwen.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: [
      'textarea[placeholder*="问题"]',
      'textarea[placeholder*="输入"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    send: ['button[class*="send"]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
    messages: ['[class*="answerContainer"]', '[class*="chat-window"]', 'main'],
    bubble: ['[class*="answerItem"]', '[class*="tongyi-markdown"]'],
    streamingFlag: ['button[class*="stop"]', 'button[aria-label*="停止"]'],
    newChat: ['button[class*="new"]', 'a[href*="chat"]'],
    model: {
      button: ['[class*="hover:bg-tag"][class~="rounded-lg"]'],
      items: ['[class~="mb-3"][class~="scrollbar-thin"] > div > div[class*="cursor-pointer"]']
    },
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
    input: [
      'textarea[placeholder*="和文心"]',
      'textarea[placeholder*="输入"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
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
    loginFlag: ['img[class*="avatar"]'],
    profileName: ['.user-profile-trigger .user-name', '.user-name'],
    model: {
      button: ['[data-testid="model-select-trigger"]', '.current-model'],
      items: ['.kimi-menu-positioner .model-item', '.model-item']
    }
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
    model: {
      button: ['.think-mode-trigger'],
      items: ['.think-mode-list .think-mode-item:not(.has-submenu)']
    },
    loginFlag: ['img[class*="avatar"]']
  }
}

const YUANBAO: ProviderDescriptor = {
  id: 'yuanbao',
  name: '腾讯元宝',
  home: 'https://yuanbao.tencent.com/',
  builtIn: true,
  enabled: true,
  accounts: [],
  adapter: {
    input: [
      'div.ql-editor[contenteditable="true"]',
      '[data-input-editor-area] [contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    send: [
      '[aria-label="发送"]',
      '[class*="SendButton_sendButton"]',
      'button[class*="send"]',
      'button[aria-label*="发送"]'
    ],
    messages: [
      '[class*="agent-chat__conv"]',
      '[class*="agent-dialogue__content--common__content"]',
      'main'
    ],
    bubble: [
      '[class*="hyc-content-md"]',
      '.hyc-common-markdown-style',
      '[class*="agent-chat__bubble"]'
    ],
    streamingFlag: [
      '[class*="SendButton_sendStop"]',
      '[aria-label="停止生成"]',
      '[class*="sendStop"]'
    ],
    newChat: ['.agent-dialogue__tool__new-chat', '.yb-new-chat-entry', '[class*="new-chat"]'],
    loginFlag: ['[class*="user-avatar"]', 'img[class*="avatar"]', '.t-avatar img'],
    profileName: [
      '[class*="user-name"]',
      '[class*="userName"]',
      '[class*="user-info"] span'
    ],
    model: {
      button: ['button[aria-label="切换模型"]'],
      items: ['[role="menu"] [role="menuitemradio"]']
    },
    composerActions: [
      { label: '深度研究', keywords: ['深度研究'] },
      { label: 'AI 生图', keywords: ['AI 生图'] },
      { label: 'PPT 生成', keywords: ['PPT 生成'] },
      { label: '数据分析', keywords: ['数据分析'] },
      { label: '写作', keywords: ['写作'] },
      { label: '解题', keywords: ['解题'] }
    ]
  }
}

/** 内置平台表：无项目时也要能打开 AI 页面（首次引导注入在里面） */
export const BUILT_IN_PROVIDERS: ProviderDescriptor[] = [
  DEEPSEEK,
  CLAUDE,
  CHATGPT,
  GEMINI,
  DOUBAO,
  QWEN,
  ERNIE,
  KIMI,
  YUANBAO,
  GLM
]

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
    const current = this.store.get().providers
    const byId = new Map(current.map((p) => [p.id, p]))
    let changed = false
    // 内置平台的选择器必须跟着版本更新：旧项目 providers.json 里存的是旧 adapter，
    // 平台改版后新选择器（如 ChatGPT 新 UI/账号名）永远进不去。账号/登录态保留。
    const merged: ProviderDescriptor[] = [
      ...BUILT_IN_PROVIDERS.map((b) => {
        const existing = byId.get(b.id)
        if (!existing) {
          changed = true
          return structuredClone(b)
        }
        const adapter = { ...existing.adapter, ...b.adapter }
        if (JSON.stringify(adapter) !== JSON.stringify(existing.adapter)) changed = true
        return { ...existing, name: b.name, home: b.home, adapter }
      }),
      ...current.filter((p) => !BUILT_IN_PROVIDERS.some((b) => b.id === p.id))
    ]
    if (changed) this.store.set({ providers: merged })
    return merged
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.list().find((p) => p.id === id)
  }

  add(desc: {
    id: string
    name: string
    home: string
    adapter?: Partial<DomAdapter>
  }): ProviderDescriptor {
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
      providers: d.providers.map((p) =>
        p.id === id ? { ...p, ...patch, id: p.id, builtIn: p.builtIn } : p
      )
    }))
    const p = this.get(id)
    if (!p) throw new Error(`Provider 不存在: ${id}`)
    return p
  }

  /** 新增账号：一个账号一个 partition，登录态隔离 */
  /** 用户选定默认账号：null = 隐式默认分区 */
  setDefaultAccount(providerId: string, accountId: string | null): void {
    const provider = this.get(providerId)
    if (!provider) return
    const id =
      accountId && accountId !== '__default__' && provider.accounts.some((a) => a.id === accountId)
          ? accountId
          : undefined
    this.update(providerId, { defaultAccountId: id, activeAccountId: id })
  }

  /** 默认分区（未显式建账号）的登录态/账号名 */
  setDefaultAccountMeta(
    providerId: string,
    patch: { label?: string; loggedIn?: boolean }
  ): void {
    const provider = this.get(providerId)
    if (!provider) return
    const next: Partial<ProviderDescriptor> = {}
    if (patch.label !== undefined && patch.label !== provider.defaultAccountLabel) {
      next.defaultAccountLabel = patch.label
    }
    if (patch.loggedIn !== undefined && patch.loggedIn !== provider.defaultLoggedIn) {
      next.defaultLoggedIn = patch.loggedIn
    }
    if (Object.keys(next).length === 0) return
    this.update(providerId, next)
  }

  /** 显式账号的显示名/登录态（自动命名只覆盖“账号 N”这类占位名） */
  setAccountMeta(
    providerId: string,
    accountId: string,
    patch: { label?: string; loggedIn?: boolean }
  ): void {
    const provider = this.get(providerId)
    if (!provider) return
    const account = provider.accounts.find((a) => a.id === accountId)
    if (!account) return
    const label =
      patch.label !== undefined && account.labelAuto !== false ? patch.label : account.label
    const loggedIn = patch.loggedIn !== undefined ? patch.loggedIn : account.loggedIn
    if (label === account.label && loggedIn === account.loggedIn) return
    this.update(providerId, {
      accounts: provider.accounts.map((a) =>
        a.id === accountId ? { ...a, label, loggedIn, labelAuto: true } : a
      )
    })
  }

  addAccount(providerId: string, label: string): ProviderAccount {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`Provider 不存在: ${providerId}`)
    const account: ProviderAccount = {
      id: `acc_${nanoid(6)}`,
      label: label || `账号 ${provider.accounts.length + 1}`,
      partition: `persist:lidow-${providerId}-${nanoid(6)}`,
      labelAuto: true
    }
    this.update(providerId, { accounts: [...provider.accounts, account] })
    return account
  }

  removeAccount(providerId: string, accountId: string): void {
    const provider = this.get(providerId)
    if (!provider) return
    const remaining = provider.accounts.filter((a) => a.id !== accountId)
    // 移除的是当前账号时，回退到隐式默认分区，而不是随便选另一个未登录账号
    this.update(providerId, {
      accounts: remaining,
      ...(provider.activeAccountId === accountId ? { activeAccountId: undefined } : {})
    })
  }

  switchAccount(providerId: string, accountId: string): void {
    this.update(providerId, { activeAccountId: accountId })
  }

  partitionOf(providerId: string, accountId?: string): string {
    const provider = this.get(providerId)
    const fallback = `persist:lidow-${providerId}-default`
    // 没有明确指定账号（旧会话/默认标签）时用隐式默认分区，绝不能回退到
    // accounts[0]：新添加的账号通常是全新分区，会把老会话切到未登录页。
    if (!accountId || accountId === '__default__') return fallback
    const acc = provider?.accounts.find((a) => a.id === accountId)
    return acc?.partition ?? fallback
  }
}
