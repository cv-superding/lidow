import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'

function Page({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 pb-3 pt-4">
        <span className="text-[15px] font-semibold">{title}</span>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-6">{children}</div>
    </div>
  )
}

const card = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 16 } as const
const dim = { color: 'var(--text-dim)' } as const

export function SessionsView(): React.JSX.Element {
  const { sessions, openSession, createSession, providers } = useStore()
  return (
    <Page
      title="会话"
      actions={
        providers.map((p) => (
          <button key={p.id} className="rounded-lg px-3 py-1.5 text-[12px]" style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => void createSession(p.id)}>
            + {p.name}
          </button>
        )) ?? null
      }
    >
      {sessions.length === 0 && <div style={dim}>暂无会话 — 到工作台选择平台开始</div>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {sessions.map((s) => (
          <button key={s.id} className="rounded-2xl p-3.5 text-left transition-panel hover:scale-[1.01]" style={card} onClick={() => void openSession(s.id)}>
            <div className="mb-1 truncate text-[13px] font-medium">{s.title}</div>
            <div className="text-[11.5px]" style={dim}>
              {s.providerId} · {new Date(s.updatedAt).toLocaleString()} · {s.compactedTurns > 0 ? `已压缩${s.compactedTurns}轮` : '未压缩'}
              {s.parentSessionId ? ' · 分叉' : ''}
            </div>
          </button>
        ))}
      </div>
    </Page>
  )
}

function TreeNodes({ nodes, depth, onOpen }: { nodes: Awaited<ReturnType<typeof api.readFileTree>>; depth: number; onOpen: (p: string) => void }): React.JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <button
            className="w-full truncate rounded-lg px-2 py-1 text-left text-[12.5px] hover:bg-current/5"
            style={{ paddingLeft: 8 + depth * 16, color: n.type === 'dir' ? 'var(--text)' : 'var(--text-dim)' }}
            onClick={() => n.type === 'file' && onOpen(n.path)}
          >
            {n.type === 'dir' ? '▸' : '·'} {n.name}
          </button>
          {n.children && <TreeNodes nodes={n.children} depth={depth + 1} onOpen={onOpen} />}
        </div>
      ))}
    </>
  )
}

export function FilesView(): React.JSX.Element {
  const { projects, fileTree, selectedFile } = useStore()
  const project = projects[0]
  useEffect(() => {
    if (project) void api.readFileTree(project.id, '', 3).then((tree) => useStore.setState({ fileTree: tree }))
  }, [project])
  return (
    <Page title={`文件 — ${project?.name ?? '未打开项目'}`}>
      {!project ? (
        <div style={dim}>未打开项目</div>
      ) : (
        <div className="flex h-full gap-4">
          <div className="w-72 shrink-0 overflow-y-auto rounded-2xl p-2" style={card}>
            <TreeNodes nodes={fileTree} depth={0} onOpen={(p) => void api.readFileContent(project.id, p).then((content) => useStore.setState({ selectedFile: { path: p, content } }))} />
          </div>
          <div className="min-w-0 flex-1 overflow-auto rounded-2xl p-4" style={card}>
            {selectedFile ? (
              <>
                <div className="mb-2 font-mono text-[12px]" style={dim}>{selectedFile.path}</div>
                <pre className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{selectedFile.content}</pre>
              </>
            ) : (
              <div style={dim}>点击左侧文件预览</div>
            )}
          </div>
        </div>
      )}
    </Page>
  )
}

export function PluginsView(): React.JSX.Element {
  const { installedPlugins, marketResults } = useStore()
  const [query, setQuery] = useState('')
  const [coverage, setCoverage] = useState<{ total: number; implemented: string[] } | null>(null)
  const refresh = (): void => {
    void api.listInstalledPlugins().then((p) => useStore.setState({ installedPlugins: p }))
    void api.dshCoverage().then(setCoverage)
  }
  useEffect(refresh, [])
  return (
    <Page
      title="插件与 DSH"
      actions={
        <>
          {coverage && (
            <span className="text-[11.5px]" style={dim}>
              DSH 兼容 {coverage.implemented.length}/{coverage.total}
            </span>
          )}
          <input
            className="w-56 rounded-xl px-3 py-1.5 text-[12.5px] outline-none"
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
            placeholder="搜索市场（GitHub + Gitee）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void api.searchMarket(query).then((r) => useStore.setState({ marketResults: r }))}
          />
        </>
      }
    >
      <div className="mb-5 text-[12.5px] font-semibold" style={dim}>已安装</div>
      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-3">
        {installedPlugins.length === 0 && <div style={dim}>暂无插件 — 从下方市场安装</div>}
        {installedPlugins.map((p) => (
          <div key={p.id} className="rounded-2xl p-3.5" style={card}>
            <div className="mb-1 flex items-center gap-2 text-[13px] font-medium">
              {p.name}
              <span className="text-[10.5px]" style={dim}>v{p.version}</span>
            </div>
            <div className="mb-2 text-[11.5px]" style={dim}>{p.description}</div>
            <div className="flex gap-2">
              <button className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.togglePlugin(p.id, false).then(refresh)}>
                停用
              </button>
              <button className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: '#5a2a2a', color: '#ffb4b4' }} onClick={() => void api.uninstallPlugin(p.id).then(refresh)}>
                卸载
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mb-3 text-[12.5px] font-semibold" style={dim}>市场</div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {marketResults.map((m) => (
          <div key={m.repoUrl} className="rounded-2xl p-3.5" style={card}>
            <div className="mb-1 flex items-center gap-2 text-[13px] font-medium">
              {m.name}
              <span className="text-[10.5px]" style={dim}>{m.source} · ★{m.stars ?? 0}</span>
            </div>
            <div className="mb-2 text-[11.5px]" style={dim}>{m.description.slice(0, 90)}</div>
            {m.installed ? (
              <span className="text-[11.5px]" style={{ color: '#4caf7d' }}>已安装</span>
            ) : (
              <button className="rounded-lg px-3 py-1 text-[11.5px] text-white" style={{ background: 'var(--accent)' }} onClick={() => void api.installPlugin(`${m.source}:${m.id}`).then(refresh)}>
                安装
              </button>
            )}
          </div>
        ))}
      </div>
    </Page>
  )
}

export function MemoryView(): React.JSX.Element {
  const { memoryList } = useStore()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  return (
    <Page
      title="用户记忆"
      actions={
        <button
          className="rounded-lg px-3 py-1.5 text-[12px] text-white"
          style={{ background: 'var(--accent)' }}
          onClick={() => {
            if (!title || !content) return
            void api.addMemory(title, content, []).then(() => {
              setTitle('')
              setContent('')
              void api.listMemory().then((m) => useStore.setState({ memoryList: m }))
            })
          }}
        >
          + 新增
        </button>
      }
    >
      <div className="mb-4 flex gap-2">
        <input className="w-56 rounded-xl px-3 py-2 text-[12.5px] outline-none" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="flex-1 rounded-xl px-3 py-2 text-[12.5px] outline-none" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} placeholder="内容（AI 也可通过 remember 工具写入）" value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div className="space-y-2">
        {memoryList.map((m) => (
          <div key={m.id} className="flex items-start gap-3 rounded-2xl p-3.5" style={card}>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{m.title}</div>
              <div className="text-[12px]" style={dim}>{m.content}</div>
            </div>
            <button className="text-[11.5px]" style={{ color: '#e06c6c' }} onClick={() => void api.deleteMemory(m.id).then(() => api.listMemory().then((x) => useStore.setState({ memoryList: x })))}>
              删除
            </button>
          </div>
        ))}
      </div>
    </Page>
  )
}

export function KnowledgeView(): React.JSX.Element {
  const { kbs } = useStore()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ path: string; score: number; snippet: string }[]>([])
  const refresh = (): void => void api.listKnowledgeBases().then((k) => useStore.setState({ kbs: k }))
  useEffect(refresh, [])
  return (
    <Page
      title="本地知识库"
      actions={
        <button
          className="rounded-lg px-3 py-1.5 text-[12px] text-white"
          style={{ background: 'var(--accent)' }}
          onClick={() => {
            void api.pickDirectory().then((dir) => {
              if (!dir) return
              const name = dir.split(/[\\/]/).pop() ?? '知识库'
              void api.addKnowledgeBase(name, dir).then(refresh)
            })
          }}
        >
          + 挂载目录
        </button>
      }
    >
      <div className="mb-4 flex gap-2">
        <select className="rounded-xl px-3 py-2 text-[12.5px]" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} onChange={(e) => { if (e.target.value) void api.searchKnowledge(e.target.value, query).then(setHits) }}>
          <option value="">选择知识库检索…</option>
          {kbs.map((k) => (
            <option key={k.id} value={k.id}>{k.name}（{k.fileCount} 文档）</option>
          ))}
        </select>
        <input className="flex-1 rounded-xl px-3 py-2 text-[12.5px] outline-none" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} placeholder="查询内容（AI 也可用 kbSearch 工具）" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="space-y-2">
        {hits.map((h) => (
          <div key={h.path} className="rounded-2xl p-3.5" style={card}>
            <div className="mb-1 font-mono text-[11.5px]" style={dim}>{h.path} · 相关度 {h.score}</div>
            <div className="text-[12.5px]">{h.snippet}</div>
          </div>
        ))}
      </div>
    </Page>
  )
}

export function AuditView(): React.JSX.Element {
  const { audits } = useStore()
  const refresh = (): void => void api.listAudit(undefined, 200).then((a) => useStore.setState({ audits: a }))
  useEffect(refresh, [])
  return (
    <Page title="执行审计" actions={<button className="rounded-lg px-3 py-1.5 text-[12px]" style={{ background: 'var(--bg-hover)' }} onClick={refresh}>刷新</button>}>
      <div className="space-y-2">
        {audits.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-2xl p-3" style={card}>
            <span className="rounded-md px-1.5 py-0.5 text-[10.5px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }}>{a.kind}</span>
            <div className="min-w-0 flex-1 truncate text-[12.5px]">{a.summary}</div>
            <span className="text-[11px]" style={dim}>{new Date(a.ts).toLocaleTimeString()}</span>
            {a.reverted ? (
              <span className="text-[11.5px]" style={{ color: '#d0a23c' }}>已回滚</span>
            ) : a.backupPath ? (
              <button className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.revertAudit(a.id).then(refresh)}>
                回滚
              </button>
            ) : null}
          </div>
        ))}
        {audits.length === 0 && <div style={dim}>暂无记录</div>}
      </div>
    </Page>
  )
}

export function SettingsView(): React.JSX.Element {
  const { settings, providers, projects, mcpServers, mcpTools } = useStore()
  const s = settings
  const patch = (p: Parameters<typeof api.updateSettings>[0]): void => {
    void api.updateSettings(p).then((next) => {
      useStore.setState({ settings: next })
      useStore.getState().applyTheme(next)
    })
  }
  const project = projects[0]
  const refreshProviders = (): void => {
    if (project) void api.listProviders(project.id).then((p) => useStore.setState({ providers: p }))
  }
  return (
    <Page title="设置">
      <div className="grid max-w-3xl grid-cols-1 gap-4">
        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">外观</div>
          <div className="flex items-center gap-3 text-[12.5px]">
            主题
            <select className="rounded-lg px-2 py-1" style={{ background: 'var(--bg-hover)' }} value={s.theme} onChange={(e) => patch({ theme: e.target.value as 'dark' | 'light' | 'system' })}>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
            主色
            <input type="color" value={s.accent} onChange={(e) => patch({ accent: e.target.value })} className="h-7 w-10 rounded" />
          </div>
        </div>

        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">安全</div>
          <label className="flex items-center gap-2 py-1 text-[12.5px]">
            <input type="checkbox" checked={s.dangerConfirm} onChange={(e) => patch({ dangerConfirm: e.target.checked })} /> 危险命令需确认
          </label>
          <label className="flex items-center gap-2 py-1 text-[12.5px]">
            <input type="checkbox" checked={s.ssrfProtection} onChange={(e) => patch({ ssrfProtection: e.target.checked })} /> SSRF 防护
          </label>
          <label className="flex items-center gap-2 py-1 text-[12.5px]">
            <input type="checkbox" checked={s.securityMod.enabled} onChange={(e) => patch({ securityMod: { ...s.securityMod, enabled: e.target.checked } })} /> 安全 MOD（拒绝提示注入）
          </label>
          <label className="flex items-center gap-2 py-1 text-[12.5px]">
            <input type="checkbox" checked={s.securityMod.ctfInject} onChange={(e) => patch({ securityMod: { ...s.securityMod, ctfInject: e.target.checked } })} /> CTF/安全研究模式提示词
          </label>
          <div className="py-1 text-[12.5px]">
            AI 回复拦截（每行一条正则，命中即阻止工具执行）：
            <textarea
              className="mt-1 min-h-[64px] w-full rounded-xl px-2.5 py-2 font-mono text-[11.5px] outline-none"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
              placeholder={'如：\n请提供.*支付凭证'}
              defaultValue={(s.securityMod.customPatterns ?? []).join('\n')}
              onBlur={(e) =>
                patch({
                  securityMod: {
                    ...s.securityMod,
                    customPatterns: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
                  }
                })
              }
            />
          </div>
          <div className="flex items-center gap-2 py-1 text-[12.5px]">
            命令超时(s)
            <input className="w-20 rounded-lg px-2 py-1" style={{ background: 'var(--bg-hover)' }} type="number" value={s.commandTimeoutMs / 1000} onChange={(e) => patch({ commandTimeoutMs: Number(e.target.value) * 1000 })} />
            自动压缩
            <input type="checkbox" checked={s.autoCompact} onChange={(e) => patch({ autoCompact: e.target.checked })} />
          </div>
        </div>

        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">平台与账号（多账号切换）</div>
          {project ? (
            providers.map((p) => (
              <div key={p.id} className="mb-3 rounded-xl p-3" style={{ background: 'var(--bg-hover)' }}>
                <div className="mb-2 flex items-center gap-2 text-[13px]">
                  {p.name}
                  <span className="text-[11px]" style={dim}>{p.home}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {p.accounts.map((a) => (
                    <button
                      key={a.id}
                      className="rounded-lg px-2.5 py-1 text-[11.5px]"
                      style={{ background: p.activeAccountId === a.id ? 'var(--accent)' : 'var(--bg-panel)', color: p.activeAccountId === a.id ? '#fff' : 'var(--text)' }}
                      onClick={() => void api.switchAccount(project.id, p.id, a.id).then(refreshProviders)}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button className="rounded-lg px-2.5 py-1 text-[11.5px]" style={{ background: 'var(--bg-panel)' }} onClick={() => void api.addAccount(project.id, p.id, '').then(refreshProviders)}>
                    + 添加账号
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div style={dim}>先打开项目</div>
          )}
        </div>

        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">MCP 服务器（Claude Desktop 配置格式兼容）</div>
          <div className="flex gap-2">
            <input id="mcp-name" className="w-32 rounded-lg px-2 py-1.5 text-[12px]" style={{ background: 'var(--bg-hover)' }} placeholder="名称" />
            <input id="mcp-cmd" className="flex-1 rounded-lg px-2 py-1.5 text-[12px]" style={{ background: 'var(--bg-hover)' }} placeholder="command（如 npx）" />
            <input id="mcp-args" className="w-48 rounded-lg px-2 py-1.5 text-[12px]" style={{ background: 'var(--bg-hover)' }} placeholder="args 逗号分隔" />
            <button
              className="rounded-lg px-3 py-1.5 text-[12px] text-white"
              style={{ background: 'var(--accent)' }}
              onClick={() => {
                const name = (document.getElementById('mcp-name') as HTMLInputElement).value
                const command = (document.getElementById('mcp-cmd') as HTMLInputElement).value
                const args = (document.getElementById('mcp-args') as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean)
                if (!name || !command) return
                void api.addMcpServer({ name, command, args, enabled: true }).then(() => api.listMcpTools().then((t) => useStore.setState({ mcpTools: t })))
              }}
            >
              添加
            </button>
          </div>
          <div className="mt-2 space-y-1">
            {mcpServers.map((srv) => (
              <div key={srv.name} className="flex items-center gap-2 text-[12px]">
                <span className="font-mono">{srv.name}</span>
                <span style={dim}>{srv.command} {srv.args?.join(' ')}</span>
                <button className="ml-auto" style={{ color: '#e06c6c' }} onClick={() => void api.removeMcpServer(srv.name).then(() => api.listMcpServers().then((s2) => useStore.setState({ mcpServers: s2 })))}>
                  移除
                </button>
              </div>
            ))}
            {mcpTools.length > 0 && (
              <div className="text-[11.5px]" style={dim}>
                可用工具：{mcpTools.map((t) => `${t.server}/${t.name}`).join('、')}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">多端同步（群机器人 Webhook）</div>
          {(['feishu', 'wecom', 'dingtalk'] as const).map((ch) => (
            <div key={ch} className="mb-2 flex items-center gap-2 text-[12.5px]">
              <span className="w-16">{ch}</span>
              <input
                className="flex-1 rounded-lg px-2 py-1.5 text-[12px]"
                style={{ background: 'var(--bg-hover)' }}
                placeholder="webhook URL"
                defaultValue={s.sync[ch]?.webhookUrl ?? ''}
                onBlur={(e) => patch({ sync: { ...s.sync, [ch]: { webhookUrl: e.target.value, enabled: Boolean(e.target.value) } } })}
              />
            </div>
          ))}
          <div className="mt-1 text-[11.5px]" style={dim}>会话事件将推送到已配置的群；入站方向需企业自建应用，见 docs</div>
        </div>

        <div className="rounded-2xl p-4" style={card}>
          <div className="mb-3 text-[13px] font-semibold">更新</div>
          <button className="rounded-lg px-3 py-1.5 text-[12px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.checkUpdate().then((u) => alert(u.hasUpdate ? `新版本 ${u.version}` : '已是最新'))}>
            检查更新
          </button>
        </div>
      </div>
    </Page>
  )
}
