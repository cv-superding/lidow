import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IconPlus, IconClose, IconFolder } from './icons'

/** 选目录并打开项目；入口在网页浮窗，这里只作为工作台空态的手动入口 */
async function pickAndOpen(): Promise<void> {
  const dir = await api.pickDirectory()
  if (dir) await useStore.getState().openProject(dir)
}

export function WebTabs(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  if (tabs.length === 0) return <HomeEmpty />
  return (
    <div className="flex h-full flex-col">
      {/* 标签栏 */}
      <div className="flex h-10 shrink-0 items-end gap-1 px-2" style={{ borderBottom: '1px solid var(--border)' }}>
        {tabs.map((t) => {
          const active = t.id === activeTabId
          return (
            <button
              key={t.id}
              className="group relative flex h-8 items-center gap-2 rounded-t-[var(--r-md)] px-3 text-[12.5px] transition-colors duration-[130ms]"
              style={{
                background: active ? 'var(--surface)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-dim)',
                fontWeight: active ? 500 : 400
              }}
              onClick={() => setActiveTab(t.id)}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: t.loggedIn ? 'var(--success)' : 'var(--warning)' }}
                title={t.loggedIn ? '已登录' : '未登录'}
              />
              <span className="truncate">{t.providerName}</span>
              <span
                className="flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity duration-[130ms] hover:bg-[var(--bg-active)] group-hover:opacity-100"
                style={{ color: 'var(--text-hint)' }}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <IconClose size={10} />
              </span>
              {active && (
                <span
                  className="absolute inset-x-2 bottom-0 h-[2px] rounded-t"
                  style={{ background: 'var(--accent)' }}
                />
              )}
            </button>
          )
        })}
      </div>
      {/* webview 容器 */}
      <div className="relative flex-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className="anim-fade absolute inset-0"
            style={{ display: t.id === activeTabId ? 'block' : 'none' }}
          >
            <WebviewTab tabId={t.id} />
          </div>
        ))}
      </div>
    </div>
  )
}

function WebviewTab({ tabId }: { tabId: string }): React.JSX.Element {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId))
  const ref = useRef<Electron.WebviewTag | null>(null)

  useEffect(() => {
    const wv = ref.current
    if (!wv || !tab) return
    let wcId = -1
    try {
      wcId = wv.getWebContentsId()
    } catch {
      /* 尚未 attach */
    }
    const bindNow = async (): Promise<void> => {
      if (wcId <= 0) return
      const st = useStore.getState()
      const cur = st.tabs.find((t) => t.id === tab.id)
      if (!cur) return
      // 顺序是生死攸关的：必须先 bindTabSession（真正调 api.bindSession 通知主进程）
      // 再 setTabWcId。反过来时 setTabWcId 先把 wcId 写进 store，
      // bindTabSession 的幂等守卫会误判为“已绑定”直接 return —— 首绑静默丢失，
      // 主进程收不到 bindSession → configure/hook/网页脚本全部不发（实测稳定复现）。
      if (tab.sessionId) {
        if (cur.sessionId !== tab.sessionId || cur.wcId !== wcId) {
          await st.bindTabSession(tab.id, tab.sessionId, wcId)
        }
        if (cur.wcId !== wcId) st.setTabWcId(tab.id, wcId)
      } else {
        // 只在有变化时写 store：无条件 setTabWcId 会 new 出 tab 对象 →
        // effect 依赖 tab 再跑 → 无限循环（点会话行即卡死的根因）
        if (cur.wcId !== wcId) st.setTabWcId(tab.id, wcId)
        // 没有会话（还没初始化项目就先打开了 AI 页面）：
        // 下发 adapter（登录态轮询依赖它）+ 项目目录（决定是否弹引导）
        void api.syncProjectToWebview(wcId, tab.adapter, tab.providerId).catch(() => undefined)
      }
    }
    const onAttached = (): void => {
      try {
        wcId = wv.getWebContentsId()
      } catch {
        return
      }
      void bindNow()
    }
    wv.addEventListener('did-attach', onAttached)
    if (wcId > 0) {
      void bindNow()
    } else {
      // did-attach 可能早于本 effect 触发（webview 在上一轮就已经 attach 完），
      // 此时监听器永远等不到事件 → 无会话场景下引导永远不弹。
      // 轮询兜底：拿到 wcId 就同步一次。
      let tries = 0
      const timer = window.setInterval(() => {
        tries++
        try {
          wcId = wv.getWebContentsId()
        } catch {
          wcId = -1
        }
        if (wcId > 0) {
          window.clearInterval(timer)
          void bindNow()
        } else if (tries > 40) {
          window.clearInterval(timer)
        }
      }, 250)
      return () => {
        window.clearInterval(timer)
        wv.removeEventListener('did-attach', onAttached)
      }
    }
    return () => wv.removeEventListener('did-attach', onAttached)
  }, [tab?.id, tab?.sessionId])

  if (!tab) return <div />
  return (
    <webview
      ref={ref}
      src={tab.home}
      partition={tab.partition}
      preload={`file://${tab.overlayPath.replace(/\\/g, '/')}`}
      className="h-full w-full"
    />
  )
}

function HomeEmpty(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const openProject = useStore((s) => s.openProject)
  const createSession = useStore((s) => s.createSession)
  const setView = useStore((s) => s.setView)
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string }[]>([])

  useEffect(() => {
    void api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  // ---- 无项目：引导初始化 ----
  if (projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6" style={{ background: 'var(--bg)' }}>
        <div className="flex w-full max-w-[440px] flex-col items-center text-center">
          <span
            className="mb-5 flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px] font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', boxShadow: 'var(--shadow)' }}
          >
            L
          </span>
          <h1 className="text-[19px] font-semibold tracking-tight">欢迎使用 Lidow</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            零 Token 成本的内嵌网页版 AI Agent。
            <br />
            先选一个工作目录，AI 才能真正读写你的文件。
          </p>

          <div className="mt-6 flex w-full flex-col gap-2">
            <button className="btn btn-primary h-9 w-full text-[13px]" onClick={() => void pickAndOpen()}>
              <IconFolder size={14} /> 初始化项目
            </button>
            <button
              className="btn btn-outline h-9 w-full text-[13px]"
              onClick={() => void api.pickDirectory().then((dir) => dir && void openProject(dir))}
            >
              打开已有目录
            </button>
          </div>

          {/* 也可以先进 AI 页面再初始化（cuckoo 的做法）：
              引导浮窗由 overlay 注入在网页里，位置就在输入框上方，
              比在这块空态里放按钮更容易被看到 */}
          <div className="mt-6 w-full">
            <div className="text-label mb-2 text-left">或先进 AI 页面，在那里初始化</div>
            <div className="grid w-full grid-cols-3 gap-2">
              {providers.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  className="card card-interactive p-2 text-left text-[12px]"
                  // 无项目时没有会话可建，只打开网页：初始化引导由 overlay
                  // 注入在页面里（cuckoo 同款），不需要先有会话
                  onClick={() => void useStore.getState().openProviderTab(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          {templates.length > 0 && (
            <div className="mt-7 w-full">
              <div className="text-label mb-2 text-left">从模板开始</div>
              <div className="grid grid-cols-2 gap-2">
                {templates.map((t) => (
                  <div key={t.id} className="card p-2.5 text-left">
                    <div className="truncate text-[12px] font-medium">{t.name}</div>
                    <div className="mb-2 line-clamp-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                      {t.description}
                    </div>
                    <button
                      className="btn btn-sm btn-outline w-full"
                      onClick={() => {
                        void api.pickDirectory().then(async (dir) => {
                          if (!dir) return
                          await api.applyTemplate(t.id, dir)
                          await openProject(dir)
                        })
                      }}
                    >
                      使用模板
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }
  // ---- 已有项目：选择平台 ----
  return (
    <div className="flex h-full items-center justify-center px-6" style={{ background: 'var(--bg)' }}>
      <div className="flex w-full max-w-[620px] flex-col items-center text-center">
        <h1 className="text-[17px] font-semibold tracking-tight">选择一个平台开始</h1>
        <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-hint)' }}>
          页面加载后用下方「新建任务」发送，AI 才能驱动本地工具
        </p>

        <div className="mt-6 grid w-full grid-cols-3 gap-2.5">
          {providers.map((p) => (
            <button
              key={p.id}
              className="card card-interactive flex flex-col items-start gap-1 p-3 text-left"
              onClick={() => void createSession(p.id)}
            >
              <span className="text-[12.5px] font-medium">{p.name}</span>
              <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: p.accounts.length > 0 ? 'var(--success)' : 'var(--border-strong)' }}
                />
                {p.accounts.length > 0 ? `${p.accounts.length} 个账号` : '未登录'}
              </span>
            </button>
          ))}
          <button
            className="flex flex-col items-start gap-1 rounded-[var(--r-xl)] p-3 text-left transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px dashed var(--border-strong)' }}
            onClick={() => setView('settings')}
          >
            <span className="flex items-center gap-1 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
              <IconPlus size={12} /> 添加平台
            </span>
          </button>
        </div>

      </div>
    </div>
  )
}
