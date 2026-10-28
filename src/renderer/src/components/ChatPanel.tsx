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
import { IconArrowUp, IconStop, IconChevronRight, IconSpark, IconCheck } from './icons'

const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '手动压缩上下文' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/plan', desc: '要求 AI 先拆解任务计划' },
  { cmd: '/memory', desc: '让 AI 记住当前要点' }
]

/** 与主进程 parser 同款：识别 lidow 工具块围栏 */
const FENCE_RE = /```(?:lidow|tool)(?:\w*)\s*\n[\s\S]*?```/g

/** 空态快捷起手式：点一下把提示词填进输入框 */
const QUICK_STARTS: { title: string; desc: string; prompt: string }[] = [
  {
    title: '了解这个项目',
    desc: '扫描目录结构与依赖，给出一份项目说明',
    prompt: '先读一下这个项目的结构和关键配置，然后给我一份简洁的项目说明：技术栈、入口文件、主要模块。'
  },
  {
    title: '创建文件',
    desc: '用 write 工具在工作目录里写一个新文件',
    prompt: '用 write 工具在当前项目根目录创建 hello.txt，内容为：Hello from Lidow'
  },
  {
    title: '查找代码',
    desc: '在整个项目里搜索符号或关键字',
    prompt: '用 grep 工具搜索项目里所有 TODO 注释，按文件分组列出。'
  },
  {
    title: '跑一次构建',
    desc: '执行 build 并分析失败原因',
    prompt: '执行项目的构建命令，如果失败请分析报错原因并给出修复方案。'
  }
]

function TurnBody({ text }: { text: string }): React.JSX.Element {
  // 工具调用块由下方 ToolCard 可视化表达，正文里不再重复展示原始 JSON
  const cleaned = text.replace(FENCE_RE, '').trim()
  if (!cleaned) return <></>
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '')
            const raw = String(children)
            const isBlock = match || raw.includes('\n')
            if (!isBlock) {
              return <code {...props}>{children}</code>
            }
            // lidow/tool 是工具块语言名，highlight.js 不认识；未知语言一律按纯文本渲染，
            // 否则 hljs.highlight 抛 Unknown language，整棵 React 树会被卸载成白屏
            const lang = match?.[1]
            const known = !!lang && hljs.getLanguage(lang)
            let html = ''
            if (known) {
              try {
                html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value
              } catch {
                html = ''
              }
            }
            return (
              <pre>
                {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{children}</code>}
              </pre>
            )
          }
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  )
}

/** 可折叠思考过程块：流式时自动展开，完成后收起 */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  if (!text) return <></>
  return (
    <div className="overflow-hidden rounded-[var(--r-lg)]" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-dim)' }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ color: streaming ? 'var(--accent)' : 'var(--text-hint)' }}>
          <IconSpark size={13} />
        </span>
        <span className="font-medium">{streaming ? '思考中' : '思考过程'}</span>
        {streaming && <span className="anim-breathe h-1 w-1 rounded-full" style={{ background: 'var(--accent)' }} />}
        <span className="flex-1" />
        <IconChevronRight size={12} className={`transition-transform duration-[200ms] ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div
          className="max-h-72 overflow-y-auto border-t px-3.5 py-3 text-[12px] leading-[1.7] whitespace-pre-wrap"
          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-dim)', background: 'var(--surface-sunken)' }}
        >
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
      <div className="flex justify-center">
        <span className="badge" style={{ height: 'auto', padding: '4px 10px', fontSize: 11 }}>
          {turn.text}
        </span>
      </div>
    )
  }
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[78%] rounded-[var(--r-xl)] rounded-br-[6px] px-3.5 py-2.5 text-[13px] leading-[1.62]"
          style={{ background: 'var(--bubble-user-bg)', color: 'var(--text)' }}
        >
          <div className="whitespace-pre-wrap">{turn.text}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {turn.text ? (
        <TurnBody text={turn.text} />
      ) : (
        <span className="text-[12px] italic" style={{ color: 'var(--text-hint)' }}>
          （本轮仅工具调用，无文本）
        </span>
      )}
      {turn.toolResults?.map((r) => (
        <ToolCard key={r.callId} result={r} />
      ))}
    </div>
  )
}

export function ChatPanel({ mode = 'pure' }: { mode?: 'pure' | 'workbench' }): React.JSX.Element {
  const activeSession = useStore((s) => s.activeSession)
  const streamingText = useStore((s) => s.streamingText)
  const streamingTps = useStore((s) => s.streamingTps)
  const thinkingText = useStore((s) => s.thinkingText)
  const sendPrompt = useStore((s) => s.sendPrompt)
  const stop = useStore((s) => s.stop)
  const confirmRequest = useStore((s) => s.confirmRequest)
  const answerConfirm = useStore((s) => s.answerConfirm)
  const plan = useStore((s) => s.plan)
  const quickCmds = useStore((s) => s.quickCmds)
  const [input, setInput] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)

  // DSH 插件经 uiInput.set 下发的输入框内容
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'ui-input') setInput(e.text)
    })
  }, [])

  const allTurns = useMemo(() => activeSession?.turns ?? [], [activeSession])
  // workbench 模式只显示发生过工具调用的轮次——网页里已有完整对话，这里不重复
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

  const slashItems = useMemo(
    () => [
      ...SLASH_COMMANDS.map((c) => ({ key: c.cmd, trigger: c.cmd, label: c.desc, template: c.cmd })),
      ...quickCmds
        .filter((q) => q.enabled)
        .map((q) => ({ key: `q_${q.id}`, trigger: `/${q.trigger}`, label: q.name, template: q.template }))
    ],
    [quickCmds]
  )

  const empty = turns.length === 0 && !streamingText

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      {/* 会话头 */}
      <div
        className="flex h-11 shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <span className="truncate text-[12.5px] font-medium">{activeSession?.title ?? '新会话'}</span>
        {activeSession && (
          <span className="badge badge-accent">{activeSession.providerId}</span>
        )}
        <span className="flex-1" />
        {running && (
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
            <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            {streamingTps > 0 ? `${streamingTps} tok/s` : '生成中'}
          </span>
        )}
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="stable-gutter flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-6 py-7">
          {empty && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 text-center">
              <div className="flex flex-col items-center gap-3">
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-[14px] text-[19px] font-bold"
                  style={{
                    background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 62%, #8b5cf6))',
                    color: 'var(--on-accent)',
                    boxShadow: '0 6px 20px color-mix(in srgb, var(--accent) 28%, transparent)'
                  }}
                >
                  L
                </span>
                {mode === 'workbench' ? (
                  <>
                    <div className="text-[15px] font-semibold">Agent 活动面板</div>
                    <div className="max-w-[400px] text-[12.5px] leading-[1.75]" style={{ color: 'var(--text-dim)' }}>
                      这里只显示本地工具调用、文件改动与需要确认的操作。
                      <br />
                      对话内容看左侧网页，不重复显示。
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[15px] font-semibold">
                      {activeSession ? '开始你的第一个任务' : '新建一个任务开始'}
                    </div>
                    <div className="max-w-[400px] text-[12.5px] leading-[1.75]" style={{ color: 'var(--text-dim)' }}>
                      网页中的 AI 会调用本地工具读写文件、执行命令，
                      <br />
                      结果实时回传到这个面板。
                    </div>
                  </>
                )}
              </div>

              {/* 快捷起手式 */}
              {mode === 'pure' && (
                <div className="grid w-full max-w-[560px] grid-cols-2 gap-2">
                  {QUICK_STARTS.map((q) => (
                    <button
                      key={q.title}
                      className="card card-interactive flex flex-col items-start gap-1 p-3 text-left"
                      onClick={() => {
                        setInput(q.prompt)
                        document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
                      }}
                    >
                      <span className="text-[12px] font-medium">{q.title}</span>
                      <span className="line-clamp-2 text-[11px] leading-[1.55]" style={{ color: 'var(--text-hint)' }}>
                        {q.desc}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {turns.map((t) => (
            <TurnItem key={t.id} turn={t} />
          ))}

          {thinkingText && mode === 'pure' && streamingText && <ThinkingBlock text={thinkingText} streaming />}

          {streamingText && mode === 'pure' && (
            <div className="flex flex-col gap-2">
              {/* 流式期间只渲染纯文本：ReactMarkdown+hljs 全量解析长文本会卡死 UI */}
              <div className="whitespace-pre-wrap text-[13.5px] leading-[1.68]" style={{ color: 'var(--text-body)' }}>
                {streamingText}
              </div>
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                {streamingTps > 0 ? `${streamingTps} tok/s` : '生成中…'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 计划确认 */}
      {plan && plan.status === 'draft' && (
        <div className="mx-auto mb-2 w-full max-w-[780px] px-6">
          <div className="anim-pop card p-3.5">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="badge badge-accent">计划待确认</span>
              <span className="truncate text-[12.5px] font-medium">{plan.goal}</span>
            </div>
            <div className="mb-3 space-y-1.5">
              {plan.items.map((it, i) => (
                <div key={it.id} className="flex items-start gap-2.5 text-[12.5px]">
                  <span
                    className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold tabular-nums"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div>{it.title}</div>
                    {it.detail && (
                      <div className="text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                        {it.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn btn-sm btn-outline" onClick={() => void api.confirmPlan(plan.id, false)}>
                放弃
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => void api.confirmPlan(plan.id, true)}>
                <IconCheck size={12} /> 确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 危险操作确认（内联版） */}
      {confirmRequest && (
        <div className="mx-auto mb-2 w-full max-w-[780px] px-6">
          <div
            className="anim-pop rounded-[var(--r-lg)] p-3"
            style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' }}
          >
            <div className="mb-1 text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
              危险操作确认
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-body)' }}>
              {confirmRequest.reason}
            </div>
            <div className="mt-2.5 flex justify-end gap-2">
              <button className="btn btn-sm btn-outline" onClick={() => void answerConfirm(false)}>
                拒绝
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => void answerConfirm(true)}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="relative shrink-0 px-6 pb-4 pt-1">
        {slashOpen && (
          <div
            className="anim-pop absolute bottom-full left-6 mb-1.5 w-[320px] overflow-hidden rounded-[var(--r-lg)] p-1"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="text-label px-2 py-1.5">指令</div>
            {slashItems.map((c, i) => (
              <button
                key={c.key}
                className="flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-[100ms]"
                style={{ background: i === slashIndex ? 'var(--bg-active)' : 'transparent' }}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => {
                  setInput(c.template.includes('{{input}}') ? c.template : `${c.template} `)
                  setSlashOpen(false)
                }}
              >
                <span className="font-mono text-[11.5px]" style={{ color: 'var(--accent)' }}>
                  {c.trigger}
                </span>
                <span className="truncate" style={{ color: 'var(--text-dim)' }}>
                  {c.label}
                </span>
              </button>
            ))}
          </div>
        )}

        <div
          className="mx-auto flex max-w-[780px] flex-col rounded-[var(--r-xl)] transition-colors duration-[130ms]"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow)'
          }}
        >
          <textarea
            className="max-h-44 min-h-[46px] w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-[1.6] outline-none"
            style={{ color: 'var(--text)' }}
            placeholder="输入任务…  Enter 发送，Shift+Enter 换行"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setSlashOpen(e.target.value.startsWith('/') && !e.target.value.includes(' '))
              setSlashIndex(0)
            }}
            onKeyDown={(e) => {
              if (slashOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const n = slashItems.length
                setSlashIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
                return
              }
              if (slashOpen && e.key === 'Enter') {
                e.preventDefault()
                const item = slashItems[slashIndex]
                if (item) {
                  setInput(item.template.includes('{{input}}') ? item.template : `${item.template} `)
                  setSlashOpen(false)
                }
                return
              }
              if (e.key === 'Escape') {
                setSlashOpen(false)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <span className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
              / 唤起指令
            </span>
            <span className="flex-1" />
            {running ? (
              <button className="btn btn-sm btn-danger" onClick={() => void stop('generate')}>
                <IconStop size={11} /> 停止生成
              </button>
            ) : (
              <button
                title="发送 (Enter)"
                className="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-[130ms] disabled:opacity-30"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                disabled={!input.trim()}
                onClick={() => void submit()}
              >
                <IconArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
