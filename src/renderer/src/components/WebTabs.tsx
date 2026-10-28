import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { InitProjectModal } from './InitProjectModal'
import { IconPlus, IconClose, IconFolder } from './icons'

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
      // 只在有变化时写 store：无条件 setTabWcId 会 new 出 tab 对象 →
      // effect 依赖 tab 再跑 → 无限循环（点会话行即卡死的根因）
      if (cur.wcId !== wcId) st.setTabWcId(tab.id, wcId)
      if (tab.sessionId && (cur.sessionId !== tab.sessionId || cur.wcId !== wcId)) {
        await st.bindTabSession(tab.id, tab.sessionId, wcId)
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
    if (wcId > 0) void bindNow()
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
  const [initOpen, setInitOpen] = useState(false)

  useEffect(() => {
    void api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  const initModal = initOpen && (
    <InitProjectModal
      onClose={() => setInitOpen(false)}
      onSend={(text) => {
        setInitOpen(false)
        void useStore
          .getState()
          .sendPrompt(text)
          .then(() => useStore.getState().setPure(true))
      }}
    />
  )

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
            <button className="btn btn-primary h-9 w-full text-[13px]" onClick={() => setInitOpen(true)}>
              <IconFolder size={14} /> 初始化项目
            </button>
            <button
              className="btn btn-outline h-9 w-full text-[13px]"
              onClick={() => void api.pickDirectory().then((dir) => dir && void openProject(dir))}
            >
              打开已有目录
            </button>
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
          {initModal}
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

        <button className="btn btn-ghost mt-5" onClick={() => setInitOpen(true)}>
          <IconFolder size={13} /> 初始化新项目
        </button>
        {initModal}
      </div>
    </div>
  )
}
