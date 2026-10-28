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
import { IconArrowUp, IconStop, IconChevronRight } from './icons'

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

/** ZCode 式可折叠思考过程块：流式时自动展开，完成后默认收起 */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  if (!text) return <></>
  return (
    <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--bg-panel)' }}>
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
        style={{ color: 'var(--text-hint)' }}
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-1.5" style={{ color: streaming ? 'var(--accent)' : 'var(--text-hint)' }}>
          {streaming ? <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--border-strong)' }} />}
          {streaming ? '思考中…' : '思考过程'}
        </span>
        <span className="flex-1" />
        <IconChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t px-3.5 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
          {text}
        </div>
      )}
    </div>
  )
}

function TurnItem({ turn }: { turn: ChatTurn }): React.JSX.Element {
  const isUser = turn.role === 'user'
  const isSystem = turn.role === 'system'
  if (isSystem) {
    return (
      <div className="mx-auto max-w-[560px] rounded-lg px-3 py-1.5 text-center text-[11.5px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-hint)' }}>
        {turn.text}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {isUser ? (
        // 用户消息：右对齐气泡
        <div className="flex justify-end">
          <div
            className="max-w-[76%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] leading-relaxed"
            style={{ background: 'var(--bubble-user-bg)', border: '1px solid var(--bubble-user-border)', color: 'var(--text)' }}
          >
            {turn.text}
          </div>
        </div>
      ) : (
        // AI 回复：占满宽度，无气泡框（ZCode 式纯文本流）
        <div className="w-full">
          {turn.text ? (
            <TurnBody text={turn.text} />
          ) : (
            <span className="text-[12.5px]" style={{ color: 'var(--text-hint)' }}>（本轮无文本，仅工具调用）</span>
          )}
        </div>
      )}
      {turn.toolResults?.map((r) => (
        <ToolCard key={r.callId} result={r} />
      ))}
    </div>
  )
}

export function ChatPanel({ mode = 'pure' }: { mode?: 'pure' | 'workbench' }): React.JSX.Element {
  const { activeSession, streamingText, streamingTps, thinkingText, sendPrompt, stop, confirmRequest, answerConfirm, plan, quickCmds } = useStore()
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)

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

  // 滚屏跟随：rAF 节流 + 用户上翻时不抢滚动条
  useEffect(() => {
    if (!scrollRef.current) return
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollRef.current
      if (!el) return
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      if (nearBottom) el.scrollTo({ top: el.scrollHeight })
    })
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-5 py-6">
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
        {thinkingText && mode === 'pure' && streamingText && (
          <ThinkingBlock text={thinkingText} streaming />
        )}
        {streamingText && mode === 'pure' && (
          <div className="flex flex-col gap-1.5">
            {/* 流式期间只渲染纯文本：ReactMarkdown+hljs 全量解析长文本会卡死 UI（每 80ms 一次） */}
            <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{streamingText}</div>
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
              <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              {streamingTps > 0 ? `${streamingTps} tok/s` : '生成中…'}
            </div>
          </div>
        )}
        </div>
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

      <div className="relative px-5 pb-4 pt-2">
        {slashOpen && (
          <div className="absolute bottom-full left-4 mb-1 w-72 rounded-xl p-1.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow)' }}>
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
        <div
          className="mx-auto flex max-w-[760px] items-end gap-2 rounded-2xl px-3 py-2.5 transition-colors"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow)' }}
        >
          <textarea
            className="max-h-44 min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed outline-none"
            style={{ color: 'var(--text)' }}
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
              title="停止生成"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px]"
              style={{ background: 'var(--danger)', color: 'var(--on-accent)' }}
              onClick={() => void stop('generate')}
            >
              <IconStop size={12} />
              停止
            </button>
          ) : (
            <button
              title="发送 (Enter)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              disabled={!input.trim()}
              onClick={() => void submit()}
            >
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        <div className="mx-auto mt-1.5 flex max-w-[760px] items-center justify-center text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
          Enter 发送 · Shift+Enter 换行 · / 唤起指令
        </div>
      </div>
    </div>
  )
}
