import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'

export function WebTabs(): React.JSX.Element {
  const { tabs, activeTabId, setActiveTab, closeTab } = useStore()
  if (tabs.length === 0) return <HomeEmpty />
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className="group flex items-center gap-1.5 rounded-t-xl px-3.5 py-1.5 text-[12.5px] transition-panel"
            style={{
              background: t.id === activeTabId ? 'var(--bg-panel)' : 'transparent',
              color: t.id === activeTabId ? 'var(--text)' : 'var(--text-dim)'
            }}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.loggedIn ? '#4caf7d' : '#d0a23c' }} />
            {t.providerName}
            <span
              className="ml-1 hidden opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </span>
          </button>
        ))}
      </div>
      <div className="relative flex-1">
        {tabs.map((t) => (
          <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeTabId ? 'block' : 'none' }}>
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
    const onAttached = (): void => {
      try {
        const wcId = wv.getWebContentsId()
        void (async () => {
          let sid = tab.sessionId
          if (!sid) {
            const project = useStore.getState().projects[0]
            if (project) {
              const s = await api.createSession(project.id, tab.providerId)
              sid = s.id
            }
          }
          if (sid) await useStore.getState().bindTabSession(tab.id, sid, wcId)
        })()
      } catch {
        /* webview 未就绪 */
      }
    }
    wv.addEventListener('did-attach', onAttached)
    return () => wv.removeEventListener('did-attach', onAttached)
  }, [tab])

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
  const { providers, projects, openProject, createSession, setView } = useStore()
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string }[]>([])

  useEffect(() => {
    void api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  if (projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <div className="text-2xl font-semibold">欢迎使用 Lidow</div>
        <div style={{ color: 'var(--text-dim)' }}>零 Token 成本的内嵌网页版 AI Agent — 选择一个工作目录开始</div>
        <div className="flex gap-3">
          <button
            className="rounded-xl px-5 py-2.5 text-[13px] text-white"
            style={{ background: 'var(--accent)', boxShadow: 'var(--shadow)' }}
            onClick={() => {
              void api.pickDirectory().then((dir) => dir && void openProject(dir))
            }}
          >
            打开项目目录
          </button>
        </div>
        {templates.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {templates.map((t) => (
              <div key={t.id} className="w-56 rounded-2xl p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                <div className="text-[13px] font-semibold">{t.name}</div>
                <div className="mb-2 text-[11.5px]" style={{ color: 'var(--text-dim)' }}>{t.description}</div>
                <button
                  className="w-full rounded-lg py-1.5 text-[12px]"
                  style={{ background: 'var(--bg-hover)' }}
                  onClick={() => {
                    void api.pickDirectory().then(async (dir) => {
                      if (!dir) return
                      await api.applyTemplate(t.id, dir)
                      await openProject(dir)
                    })
                  }}
                >
                  一键初始化
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <div className="text-2xl font-semibold">选择一个平台开始</div>
      <div className="flex flex-wrap justify-center gap-3">
        {providers.map((p) => (
          <button
            key={p.id}
            className="w-44 rounded-2xl px-4 py-4 text-[13.5px] font-medium transition-panel hover:scale-[1.03]"
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}
            onClick={() => void createSession(p.id)}
          >
            {p.name}
            <div className="mt-1 text-[11.5px] font-normal" style={{ color: 'var(--text-dim)' }}>
              {p.accounts.length > 0 ? `${p.accounts.length} 个账号` : '未登录 — 打开后登录'}
            </div>
          </button>
        ))}
        <button
          className="w-44 rounded-2xl px-4 py-4 text-[13.5px]"
          style={{ background: 'var(--bg-hover)' }}
          onClick={() => setView('settings')}
        >
          + 添加平台
        </button>
      </div>
    </div>
  )
}
