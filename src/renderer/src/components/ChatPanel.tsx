import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import hljs from 'highlight.js'
import { useStore } from '../store'
import { api } from '../api'
import { ToolCard } from './ToolCard'
import type { ChatTurn } from '@shared/types'
import { IconArrowUp, IconStop } from './icons'

const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '手动压缩上下文' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/plan', desc: '要求 AI 先拆解任务计划' },
  { cmd: '/memory', desc: '让 AI 记住当前要点' }
]

function TurnBody({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown-body text-[13.5px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '')
            const raw = String(children)
            const isBlock = match || raw.includes('\n')
            if (!isBlock) {
              return (
                <code className="rounded px-1 py-0.5 text-[12.5px]" style={{ background: 'var(--bg-hover)' }} {...props}>
                  {children}
                </code>
              )
            }
            const html = match ? hljs.highlight(raw, { language: match[1]!, ignoreIllegals: true }).value : raw
            return (
              <pre className="my-2 overflow-auto rounded-xl p-3 text-[12.5px]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                {match ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{children}</code>}
              </pre>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function TurnItem({ turn }: { turn: ChatTurn }): React.JSX.Element {
  const isUser = turn.role === 'user'
  const isSystem = turn.role === 'system'
  if (isSystem) {
    return <div className="mx-auto max-w-[92%] rounded-xl px-3 py-2 text-center text-[12px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }}>{turn.text}</div>
  }
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[92%] px-4 py-2.5 ${isUser ? 'rounded-2xl rounded-br-md' : 'px-1'}`}
        style={
          isUser
            ? { background: 'var(--bubble-user-bg)', border: '1px solid var(--bubble-user-border)' }
            : { background: 'transparent', border: 'none', padding: '2px 0' }
        }
      >
        {turn.text ? <TurnBody text={turn.text} /> : <span style={{ color: 'var(--text-dim)' }}>（本轮无文本，仅工具调用）</span>}
      </div>
      {turn.toolResults?.map((r) => (
        <ToolCard key={r.callId} result={r} />
      ))}
    </div>
  )
}

export function ChatPanel({ mode = 'pure' }: { mode?: 'pure' | 'workbench' }): React.JSX.Element {
  const { activeSession, streamingText, streamingTps, sendPrompt, stop, confirmRequest, answerConfirm, plan, quickCmds } = useStore()
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // DSH 插件经 uiInput.set 下发的输入框内容
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'ui-input') setInput(e.text)
    })
  }, [])

  const allTurns = useMemo(() => activeSession?.turns ?? [], [activeSession])
  // workbench 模式只显示发生过工具调用的轮次——网页里已经有完整对话，这里不重复
  const turns = useMemo(
    () => (mode === 'workbench' ? allTurns.filter((t) => (t.toolResults?.length ?? 0) > 0) : allTurns),
    [allTurns, mode]
  )
  const running = activeSession ? turns[turns.length - 1]?.status === 'streaming' || streamingText.length > 0 : false

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns.length, streamingText])

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setSlashOpen(false)
    const session = activeSession
    if (text === '/new') {
      const providerId = session?.providerId ?? useStore.getState().providers[0]?.id
      if (providerId) await useStore.getState().createSession(providerId)
      return
    }
    // 没有活动会话时自动新建（纯净模式下直接打字发送的常见路径）
    if (!session) {
      const providerId = useStore.getState().providers[0]?.id
      if (!providerId) {
        useStore.getState().notice('请先在「工作台」选择一个 AI 平台', 'warn')
        setInput(text)
        return
      }
      await useStore.getState().createSession(providerId)
      const created = useStore.getState().activeSession
      if (!created) {
        setInput(text)
        return
      }
      await useStore.getState().openProviderTab(created.providerId, created.id)
      await useStore.getState().sendPrompt(text)
      return
    }
    if (text === '/compact') {
      const next = await api.compactSession(session.id)
      useStore.setState({ activeSession: next })
      return
    }
    if (text === '/memory') {
      await sendPrompt('请用 remember 工具保存本次会话的关键结论与用户偏好（若无可保存内容请直接说明）。')
      return
    }
    if (text === '/plan') {
      await sendPrompt('请先用 planSubmit 工具把这个需求拆解为分步计划，等待我确认后再执行。')
      return
    }
    await sendPrompt(text)
  }

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && !streamingText && (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center" style={{ color: 'var(--text-hint)' }}>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>L</div>
            {mode === 'workbench' ? (
              <>
                <div className="text-[12.5px]">Agent 活动面板</div>
                <div className="text-[11.5px] leading-relaxed">
                  这里只显示本地工具调用、文件改动与需要你确认的操作。
                  <br />
                  对话内容看左侧网页，不重复显示。
                </div>
              </>
            ) : (
              <div className="text-[12.5px]">开始你的第一个任务 — 网页中的 AI 将驱动本地工具</div>
            )}
          </div>
        )}
        {turns.map((t) => (
          <TurnItem key={t.id} turn={t} />
        ))}
        {streamingText && mode === 'pure' && (
          <div className="flex flex-col items-start gap-1">
            <div className="max-w-[92%] px-1 py-2.5">
              <TurnBody text={streamingText} />
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              {streamingTps > 0 ? `${streamingTps} tok/s` : '生成中…'}
            </div>
          </div>
        )}
      </div>

      {plan && plan.status === 'draft' && (
        <div className="anim-pop mx-4 mb-2 rounded-2xl p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
          <div className="mb-2 text-[13px] font-semibold">📋 任务计划待确认：{plan.goal}</div>
          <div className="space-y-1.5">
            {plan.items.map((it, i) => (
              <div key={it.id} className="flex items-start gap-2 text-[12.5px]">
                <span style={{ color: 'var(--text-dim)' }}>{i + 1}.</span>
                <div>
                  <div>{it.title}</div>
                  {it.detail && <div style={{ color: 'var(--text-dim)' }}>{it.detail}</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="rounded-lg px-3 py-1.5 text-[12.5px] " style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} onClick={() => void api.confirmPlan(plan.id, true)}>
              确认执行
            </button>
            <button className="rounded-lg px-3 py-1.5 text-[12.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void api.confirmPlan(plan.id, false)}>
              放弃
            </button>
          </div>
        </div>
      )}

      {confirmRequest && (
        <div className="anim-pop mx-4 mb-2 rounded-2xl p-3" style={{ background: 'rgba(255, 75, 117, 0.08)', border: '1px solid rgba(255, 75, 117, 0.35)' }}>
          <div className="mb-2 text-[13px] font-semibold" style={{ color: 'var(--danger)' }}>⚠️ 危险操作确认</div>
          <div className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>{confirmRequest.reason}</div>
          <div className="mt-2 flex gap-2">
            <button className="rounded-lg px-3 py-1.5 text-[12.5px]" style={{ background: 'var(--danger)', color: 'var(--on-accent)' }} onClick={() => void answerConfirm(true)}>
              允许
            </button>
            <button className="rounded-lg px-3 py-1.5 text-[12.5px]" style={{ background: 'var(--bg-hover)' }} onClick={() => void answerConfirm(false)}>
              拒绝
            </button>
          </div>
        </div>
      )}

      <div className="relative border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        {slashOpen && (
          <div className="absolute bottom-full left-4 mb-1 w-72 rounded-xl p-1.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
            {SLASH_COMMANDS.map((c) => (
              <button
                key={c.cmd}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:opacity-80"
                style={{ background: 'transparent' }}
                onClick={() => {
                  setInput(c.cmd)
                  setSlashOpen(false)
                }}
              >
                <span className="font-mono" style={{ color: 'var(--accent)' }}>{c.cmd}</span>
                <span style={{ color: 'var(--text-dim)' }}>{c.desc}</span>
              </button>
            ))}
            {quickCmds.filter((q) => q.enabled).map((q) => (
              <button
                key={q.id}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]"
                onClick={() => {
                  // {{input}} 占位：无内容时替换为空串，用户可续填；有占位则保留待编辑
                  setInput(q.template.includes('{{input}}') ? q.template : `${q.template} `)
                  setSlashOpen(false)
                }}
              >
                <span className="font-mono" style={{ color: 'var(--accent)' }}>/{q.trigger}</span>
                <span style={{ color: 'var(--text-dim)' }}>{q.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl px-4 py-2.5 text-[13.5px] outline-none focus:border-[var(--border-strong)]"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)' }}
            placeholder="输入任务…（/ 唤起指令，Enter 发送，Shift+Enter 换行）"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setSlashOpen(e.target.value === '/')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {running ? (
            <button
              className="h-[42px] rounded-2xl px-4 text-[13px]"
              style={{ background: 'var(--danger)', color: 'var(--on-accent)' }}
              onClick={() => void stop('generate')}
            >
              <span className="flex items-center gap-1.5"><IconStop size={13} /> 停止</span>
            </button>
          ) : (
            <button
              title="发送 (Enter)"
              className="h-[42px] w-[42px] shrink-0 rounded-full text-[16px] disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              disabled={!input.trim()}
              onClick={() => void submit()}
            >
              <span className="flex items-center justify-center"><IconArrowUp size={17} /></span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
