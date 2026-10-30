import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import hljs from 'highlight.js'
import { useStore, useProject, WEB_MODE, type ReviewFile } from '../store'
import { api } from '../api'
import { waitWebviewWcId, webviewWcId } from '../webviews'
import { stripCitationMarkers, stripToolArtifacts } from '../textClean'
import { toolLabel } from '../toolLabels'
import { ToolCard } from './ToolCard'
import { PureToolbar } from './TitleBar'
import type { ChatTurn, SkillMeta, ToolResult } from '@shared/types'
import {
  IconArrowUp,
  IconStop,
  IconChevronRight,
  IconSpark,
  IconCheck,
  IconAttach,
  IconShield,
  IconBulb,
  IconHand,
  IconEye,
  IconChevronDown,
  IconClose,
  IconDiff,
  IconFolder,
  IconFile,
  IconCopy,
  IconEdit,
  IconRefresh,
  IconThumbUp,
  IconThumbDown,
  IconVolume,
  IconShare
} from './icons'

const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '手动压缩上下文' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/plan', desc: '要求 AI 先拆解任务计划' },
  { cmd: '/memory', desc: '让 AI 记住当前要点' }
]

/** 与主进程 parser 同款：识别 lidow 工具块围栏（渲染侧清理见 ../textClean） */

/** 空态快捷起手式：点一下把提示词填进输入框 */
const QUICK_STARTS: { title: string; desc: string; prompt: string }[] = [
  {
    title: '了解这个项目',
    desc: '扫描目录结构与依赖，给出一份项目说明',
    prompt:
      '先读一下这个项目的结构和关键配置，然后给我一份简洁的项目说明：技术栈、入口文件、主要模块。'
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
  const cleaned = stripCitationMarkers(stripToolArtifacts(text))
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
                {html ? (
                  <code dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  <code>{children}</code>
                )}
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

/** 可折叠处理过程（思考）：默认只露一行摘要，展开才显示完整推理（Qoder 同款活动流） */
function ThinkingBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (!text) return <></>
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 72)
  return (
    <div
      className="overflow-hidden rounded-[var(--r-lg)]"
      style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-dim)' }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="shrink-0"
          style={{ color: streaming ? 'var(--accent)' : 'var(--text-hint)' }}
        >
          <IconSpark size={13} />
        </span>
        <span className="shrink-0 font-medium">{streaming ? '思考中' : '已处理'}</span>
        {streaming && (
          <span
            className="anim-breathe h-1 w-1 shrink-0 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        )}
        {!open && preview ? (
          <span
            className="min-w-0 flex-1 truncate text-[11px]"
            style={{ color: 'var(--text-hint)' }}
          >
            · {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <IconChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-[200ms] ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div
          className="max-h-72 overflow-y-auto border-t px-3.5 py-3 text-[12px] leading-[1.7] whitespace-pre-wrap"
          style={{
            borderColor: 'var(--border-soft)',
            color: 'var(--text-dim)',
            background: 'var(--surface-sunken)'
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

/** 一轮工具调用聚合：执行中显示计时并自动展开；结束后折叠为「执行工具 N 次」 */
function ToolGroup({
  results,
  running = false,
  startedAt
}: {
  results: ToolResult[]
  running?: boolean
  startedAt?: number
}): React.JSX.Element {
  const [open, setOpen] = useState(running)
  const [now, setNow] = useState(Date.now())
  const failed = results.filter((r) => !r.ok).length
  useEffect(() => {
    // 执行中自动展开看进度；结束后收起，但失败时保持展开避免错误被藏起来
    setOpen(running || failed > 0)
  }, [running, failed])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const secs = running && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0
  const labels = [...new Set(results.map((r) => toolLabel(r.name)))].slice(0, 4)
  return (
    <div
      className="overflow-hidden rounded-[var(--r-lg)]"
      style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <span
            className="anim-breathe h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        ) : (
          <span
            className="shrink-0"
            style={{ color: failed > 0 ? 'var(--danger)' : 'var(--success)' }}
          >
            {failed > 0 ? <IconClose size={10} /> : <IconCheck size={11} />}
          </span>
        )}
        <span className="shrink-0 font-medium" style={{ color: 'var(--text)' }}>
          {running ? `正在执行中 · ${secs}s` : `执行工具 ${results.length} 次`}
        </span>
        {labels.length > 0 ? (
          <span
            className="min-w-0 flex-1 truncate text-[11px]"
            style={{ color: 'var(--text-hint)' }}
          >
            {labels.join('、')}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {!running && failed > 0 && (
          <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--danger)' }}>
            {failed} 失败
          </span>
        )}
        <IconChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-[200ms] ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div
          className="anim-fade flex flex-col gap-1 border-t px-2 py-2"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          {results.map((r) => (
            <ToolCard key={r.callId} result={r} flat />
          ))}
        </div>
      )}
    </div>
  )
}

/** 收集本轮 diff：同一文件多次编辑取最后一次，供右栏审阅展示 */
function diffFiles(results: ToolResult[]): ReviewFile[] {
  const byPath = new Map<string, ReviewFile>()
  for (const r of results) {
    if (!r.ok || r.display?.kind !== 'diff') continue
    let add = 0
    let del = 0
    for (const line of r.display.patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) add++
      else if (line.startsWith('-')) del++
    }
    byPath.set(r.display.path, { path: r.display.path, patch: r.display.patch, add, del })
  }
  return [...byPath.values()]
}

function ChangeCard({
  results,
  running
}: {
  results: ToolResult[]
  running: boolean
}): React.JSX.Element | null {
  const files = diffFiles(results)
  if (files.length === 0) return null
  const stats = {
    files: files.length,
    add: files.reduce((n, f) => n + f.add, 0),
    del: files.reduce((n, f) => n + f.del, 0)
  }
  return (
    <button
      className="flex items-center gap-2 self-start rounded-[var(--r-lg)] px-3 py-2 text-[12px] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]"
      style={{
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--text-dim)'
      }}
      title="在右侧审阅变更"
      onClick={() => useStore.getState().openReview(files)}
    >
      {running ? (
        <span
          className="anim-breathe h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      ) : (
        <span className="shrink-0" style={{ color: 'var(--text-hint)' }}>
          <IconDiff size={13} />
        </span>
      )}
      <span>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{stats.files}</span> 个文件已修改
      </span>
      {stats.add > 0 && <span style={{ color: 'var(--success)' }}>+{stats.add}</span>}
      {stats.del > 0 && <span style={{ color: 'var(--danger)' }}>−{stats.del}</span>}
      <IconChevronRight size={12} className="shrink-0" />
    </button>
  )
}

/** 首包等待态：对齐 Qoder 的「正在思考」 */
function PendingIndicator({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const start = since || now
  const secs = Math.max(0, Math.floor((now - start) / 1000))
  return (
    <div
      className="anim-fade flex items-center gap-2 self-start rounded-[var(--r-lg)] border px-3 py-[7px] text-[12px]"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface)',
        color: 'var(--text-dim)'
      }}
    >
      <span className="anim-breathe inline-flex" style={{ color: 'var(--accent)' }}>
        <IconSpark size={14} />
      </span>
      <span>正在思考</span>
      <span className="pending-dots">
        <span />
        <span />
        <span />
      </span>
      {secs >= 1 && (
        <span className="tabular-nums" style={{ color: 'var(--text-hint)' }}>
          {secs}s
        </span>
      )}
    </div>
  )
}

/** 旧数据/旧捕获通道可能把同一回答写入多轮：仅显示层去重，保留更完整的一条 */
function dedupeAssistantTurns(list: ChatTurn[]): ChatTurn[] {
  const norm = (text: string): string =>
    text
      .replace(/\s+/g, '')
      .replace(/[*_`#>~|:：\-—，。；、,.;!?！？"'“”‘’（）()【】<>《》]/g, '')
  const out: ChatTurn[] = []
  let groupStart = 0
  for (const turn of list) {
    if (turn.role !== 'assistant') {
      out.push(turn)
      groupStart = out.length
      continue
    }
    if ((turn.toolResults?.length ?? 0) > 0 || /```lidow/i.test(turn.text)) {
      out.push(turn)
      continue
    }
    const key = norm(turn.text)
    if (!key) {
      out.push(turn)
      continue
    }
    let duplicateOf = -1
    for (let j = out.length - 1; j >= groupStart; j--) {
      const prev = out[j]
      if (!prev || prev.role !== 'assistant') continue
      if ((prev.toolResults?.length ?? 0) > 0 || /```lidow/i.test(prev.text)) continue
      const prevKey = norm(prev.text)
      if (!prevKey) continue
      const related =
        prevKey === key ||
        (key.length >= 30 &&
          prevKey.length >= 30 &&
          (prevKey.includes(key) || key.includes(prevKey)))
      if (related) {
        duplicateOf = j
        break
      }
    }
    if (duplicateOf < 0) {
      out.push(turn)
      continue
    }
    const prev = out[duplicateOf]!
    if (key.length > norm(prev.text).length) {
      out[duplicateOf] = { ...turn, think: turn.think || prev.think }
    }
  }
  return out
}

function ActionButton({
  title,
  onClick,
  active,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-[var(--r-sm)] transition-colors duration-[120ms] hover:bg-[var(--bg-hover)]"
      style={{ color: active ? 'var(--accent)' : 'var(--text-hint)' }}
    >
      {children}
    </button>
  )
}

function TurnItem({
  turn,
  sessionId,
  showActions,
  onEditUser
}: {
  turn: ChatTurn
  sessionId?: string
  showActions?: boolean
  onEditUser?: (text: string) => void
}): React.JSX.Element {
  const isUser = turn.role === 'user'
  const isSystem = turn.role === 'system'
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const [speaking, setSpeaking] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(turn.text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  const speak = (): void => {
    const synth = window.speechSynthesis
    if (!synth) return
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    const u = new SpeechSynthesisUtterance(turn.text.replace(/```[\s\S]*?```/g, ' ').slice(0, 6000))
    u.lang = /[一-龥]/.test(turn.text) ? 'zh-CN' : 'en-US'
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    synth.cancel()
    synth.speak(u)
    setSpeaking(true)
  }
  const share = (): void => {
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; text?: string }) => Promise<void>
    }
    if (typeof nav.share === 'function') {
      void nav.share({ title: 'Lidow', text: turn.text }).catch(() => undefined)
      return
    }
    void navigator.clipboard.writeText(turn.text).then(() => {
      useStore.getState().notice('已复制内容，可粘贴分享')
    })
  }
  const regenerate = (): void => {
    if (!sessionId) return
    void api.overlayAction(sessionId, ['重新生成', '重新回答', 'Regenerate'])
    useStore.getState().notice('已请求网页端重新生成')
  }

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
      <div className="group flex flex-col items-end">
        <div
          className="max-w-[78%] rounded-[var(--r-xl)] rounded-br-[6px] px-3.5 py-2.5 text-[13px] leading-[1.62]"
          style={{ background: 'var(--bubble-user-bg)', color: 'var(--text)' }}
        >
          <div className="whitespace-pre-wrap">{turn.text}</div>
        </div>
        {showActions && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <ActionButton title={copied ? '已复制' : '复制'} onClick={copy}>
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </ActionButton>
            {onEditUser && (
              <ActionButton title="修改并重新发送" onClick={() => onEditUser(turn.text)}>
                <IconEdit size={13} />
              </ActionButton>
            )}
          </div>
        )}
      </div>
    )
  }

  // status=streaming 且已有工具 = 工具批次正在执行（转圈 + 计时）
  const toolRunning = turn.status === 'streaming' && (turn.toolResults?.length ?? 0) > 0
  return (
    <div className="flex flex-col gap-2">
      {/* 处理过程默认折叠，只露摘要；历史轮次也保留可展开查看 */}
      {turn.think && <ThinkingBlock text={turn.think} streaming={false} />}
      {turn.text ? (
        <TurnBody text={turn.text} />
      ) : (
        <span className="text-[12px] italic" style={{ color: 'var(--text-hint)' }}>
          （本轮仅工具调用，无文本）
        </span>
      )}
      {turn.toolResults && turn.toolResults.length > 0 && (
        <ToolGroup results={turn.toolResults} running={toolRunning} startedAt={turn.ts} />
      )}
      {showActions && turn.text && (
        <div className="mt-0.5 flex flex-wrap items-center gap-0.5">
          <ActionButton title={copied ? '已复制' : '复制'} onClick={copy}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </ActionButton>
          {sessionId && (
            <ActionButton title="在网页端重新生成" onClick={regenerate}>
              <IconRefresh size={13} />
            </ActionButton>
          )}
          <ActionButton
            title="有帮助"
            active={vote === 'up'}
            onClick={() => setVote(vote === 'up' ? null : 'up')}
          >
            <IconThumbUp size={13} />
          </ActionButton>
          <ActionButton
            title="没帮助"
            active={vote === 'down'}
            onClick={() => setVote(vote === 'down' ? null : 'down')}
          >
            <IconThumbDown size={13} />
          </ActionButton>
          <ActionButton title={speaking ? '停止朗读' : '朗读'} active={speaking} onClick={speak}>
            <IconVolume size={13} />
          </ActionButton>
          <ActionButton title="分享" onClick={share}>
            <IconShare size={13} />
          </ActionButton>
        </div>
      )}
    </div>
  )
}

/** 首次使用引导：由 overlay 注入到 AI 网页里（见 preload/overlay.ts），此处不再实现 */

/**
 * 权限模式选择器（对齐 ZCode 四档）。
 * 语义差异直接影响工具是否停下来问你：
 *  plan → 编辑前先出计划；ask → 改文件/执行命令都问；
 *  autonomous → 只在有风险时问；full → 减少确认次数
 */
const PERMISSION_MODES = [
  { id: 'plan', label: '计划模式', desc: '编辑前先出计划', icon: IconBulb },
  { id: 'ask', label: '变更前确认', desc: '改文件前先问我', icon: IconHand },
  { id: 'autonomous', label: '自主模式', desc: '在有风险时询问', icon: IconShield },
  { id: 'full', label: '完全访问', desc: '减少确认次数', icon: IconEye }
] as const

function PermissionPicker(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const cur = PERMISSION_MODES.find((m) => m.id === settings.permissionMode) ?? PERMISSION_MODES[2]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      <button className="composer-chip" title="权限模式" onClick={() => setOpen((v) => !v)}>
        <cur.icon size={12} /> {cur.label}
        <IconChevronDown
          size={10}
          className={`transition-transform duration-[150ms] ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          className="anim-pop absolute bottom-[calc(100%+6px)] left-0 z-50 w-[240px] overflow-hidden rounded-[var(--r-lg)] p-1"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)'
          }}
        >
          {PERMISSION_MODES.map((m) => {
            const active = m.id === settings.permissionMode
            return (
              <button
                key={m.id}
                className={`flex w-full items-start gap-2.5 rounded-[var(--r-sm)] px-2 py-2 text-left transition-colors duration-[100ms] ${
                  active ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]'
                }`}
                onClick={() => {
                  setOpen(false)
                  void api
                    .updateSettings({ permissionMode: m.id })
                    .then((next) => useStore.setState({ settings: next }))
                }}
              >
                <span
                  className="mt-[2px] shrink-0"
                  style={{ color: active ? 'var(--accent)' : 'var(--text-hint)' }}
                >
                  <m.icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium">{m.label}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-hint)' }}>
                    {m.desc}
                  </span>
                </span>
                {active && (
                  <span className="mt-[3px] shrink-0" style={{ color: 'var(--accent)' }}>
                    <IconCheck size={12} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ChatPanel({ mode = 'pure' }: { mode?: 'pure' | 'workbench' }): React.JSX.Element {
  const activeSession = useStore((s) => s.activeSession)
  const pendingReplySessionId = useStore((s) => s.pendingReplySessionId)
  const pendingSince = useStore((s) => s.pendingSince)
  const streamingText = useStore((s) => s.streamingText)
  const streamingTps = useStore((s) => s.streamingTps)
  const thinkingText = useStore((s) => s.thinkingText)
  const sendPrompt = useStore((s) => s.sendPrompt)
  const stop = useStore((s) => s.stop)
  const confirmRequest = useStore((s) => s.confirmRequest)
  const answerConfirm = useStore((s) => s.answerConfirm)
  const plan = useStore((s) => s.plan)
  const sessions = useStore((s) => s.sessions)
  const quickCmds = useStore((s) => s.quickCmds)
  const toggleState = useStore((s) => s.toggleState)
  // 不能写成 useStore((s) => s.currentComposerActions())：
  // 该方法每次调用都返回新数组，zustand 比较引用 → 无限重渲染（实测白屏报
  // Maximum update depth exceeded）。订阅稳定的原始字段，再用 useMemo 派生。
  const activeSessionId = activeSession?.providerId ?? ''
  const tabsForComposer = useStore((s) => s.tabs)
  const providersForComposer = useStore((s) => s.providers)
  const composerActions = useMemo(() => {
    const pid = activeSessionId
    if (!pid) return []
    const tabAdapter = tabsForComposer.find((t) => t.providerId === pid)?.adapter
    const base = tabAdapter?.composerActions?.length
      ? tabAdapter.composerActions
      : (providersForComposer.find((x) => x.id === pid)?.adapter?.composerActions ?? [])
    const actions = [...base]
    // 其它平台只要网页里有对应开关，也自动补 chip（不用为每家写死清单）
    const hasThink = actions.some((a) => a.keywords.some((k) => /思考|think/i.test(k)))
    if (toggleState.thinkAvailable && !hasThink) {
      actions.push({ label: '思考', keywords: ['思考', 'Thinking'] })
    }
    const hasSearch = actions.some((a) => a.keywords.some((k) => /搜索|search/i.test(k)))
    if (toggleState.searchAvailable && !hasSearch) {
      actions.push({ label: '搜索', keywords: ['搜索', 'Search'] })
    }
    return actions
  }, [
    activeSessionId,
    tabsForComposer,
    providersForComposer,
    toggleState.thinkAvailable,
    toggleState.searchAvailable
  ])
  const [input, setInput] = useState('')
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null)
  const [earlyExpanded, setEarlyExpanded] = useState(false)
  const [composerHeight, setComposerHeight] = useState(0)
  const resizeStart = useRef<{ y: number; h: number } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<
    Record<string, { key: string; name: string; preview?: string }[]>
  >({})
  const attachments = activeSession?.id ? (pendingAttachments[activeSession.id] ?? []) : []
  const addAttachments = (
    sessionId: string,
    items: { path: string; name: string; preview?: string }[]
  ): void => {
    if (items.length === 0) return
    setPendingAttachments((prev) => ({
      ...prev,
      [sessionId]: [
        ...(prev[sessionId] ?? []),
        ...items.map((it) => ({ key: it.path, name: it.name, preview: it.preview }))
      ]
    }))
  }
  const clearAttachments = (sessionId: string): void => {
    setPendingAttachments((prev) => (prev[sessionId]?.length ? { ...prev, [sessionId]: [] } : prev))
  }
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashSelectedRef = useRef<HTMLButtonElement | null>(null)
  const projectId = useStore((s) => s.activeProjectId)
  const project = useProject(useStore())
  const auxPanel = useStore((s) => s.auxPanel)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [initOpen, setInitOpen] = useState(false)
  const [initPicking, setInitPicking] = useState(false)
  const [initStarting, setInitStarting] = useState(false)
  const [initName, setInitName] = useState('')

  // 打开斜杠菜单时重新扫描技能/快捷指令：新装的技能和刚保存的指令不需要重启软件
  useEffect(() => {
    if (!slashOpen) return
    void api
      .listSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
    void api
      .listQuickCommands()
      .then((c) => useStore.setState({ quickCmds: c }))
      .catch(() => undefined)
  }, [slashOpen, projectId])
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户是否停留在底部（用滚动事件维护；更新后再算会因单次增长过大永久失效） */
  const stickRef = useRef(true)

  // DSH 插件经 uiInput.set 下发的输入框内容
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'ui-input') setInput(e.text)
    })
  }, [])

  const allTurns = useMemo(() => activeSession?.turns ?? [], [activeSession])
  // workbench 模式只显示发生过工具调用的轮次——网页里已有完整对话，这里不重复
  const turns = useMemo(() => {
    const base =
      mode === 'workbench' ? allTurns.filter((t) => (t.toolResults?.length ?? 0) > 0) : allTurns
    return dedupeAssistantTurns(base)
  }, [allTurns, mode])
  // 当前任务（最后一条用户消息之后）的全部工具结果：文件变更汇总用
  const taskChangeResults = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === 'user') return turns.slice(i + 1).flatMap((t) => t.toolResults ?? [])
    }
    return turns.flatMap((t) => t.toolResults ?? [])
  }, [turns])
  const running = activeSession
    ? turns[turns.length - 1]?.status === 'streaming' || streamingText.length > 0
    : false
  // 实时思考只在任务进行中显示：刚发出（最后一轮是用户）或正在生成/执行；
  // 任务结束后网页侧迟到的 think-chunk 不能再挂到最终答复下面。
  const liveThinking = Boolean(
    thinkingText &&
    activeSession &&
    (running ||
      pendingReplySessionId === activeSession.id ||
      turns[turns.length - 1]?.role === 'user')
  )
  // 已发送但首包还没到：显示「正在思考」，避免看起来卡死
  const waiting = Boolean(
    activeSession &&
    pendingReplySessionId === activeSession.id &&
    allTurns[allTurns.length - 1]?.role === 'user' &&
    !streamingText &&
    !thinkingText
  )
  // 工具批次执行中（turn.status=streaming 且已有结果）：停止按钮应中止工具而不是生成
  const lastTurn = turns[turns.length - 1]
  const toolRunning = Boolean(
    activeSession && lastTurn?.status === 'streaming' && (lastTurn.toolResults?.length ?? 0) > 0
  )

  // 滚屏跟随：记住用户是否停留在底部；流式/新消息时只在「原本就在底部」才跟随。
  // 旧实现把判定放在 DOM 增长之后，单次新增超过 120px 时会永远判为不在底部。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, streamingText])

  const preferredProviderId = (): string | undefined => {
    const st = useStore.getState()
    const tab = st.tabs.find((t) => t.id === st.activeTabId)
    return tab?.providerId ?? st.providers[0]?.id
  }

  const pickProjectDir = async (): Promise<void> => {
    if (initPicking) return
    setInitPicking(true)
    try {
      // 浏览器拿不到系统目录对话框：Web 版直接输入服务端容器内路径
      const dir = WEB_MODE
        ? window.prompt('容器内工作目录（例如 /workspace）', project?.root ?? '/workspace')
        : await api.pickDirectory()
      if (dir) await useStore.getState().openProject(dir)
    } catch (e) {
      useStore
        .getState()
        .notice(`选择目录失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setInitPicking(false)
    }
  }

  const finishInit = async (): Promise<void> => {
    if (!project || initStarting) return
    setInitStarting(true)
    try {
      const st = useStore.getState()
      let session = st.activeSession
      if (!session) {
        const pid = preferredProviderId()
        if (!pid) {
          useStore.getState().notice('请先选择一个 AI 平台', 'warn')
          return
        }
        await st.createSession(pid)
        session = useStore.getState().activeSession
      }
      if (!session) return

      const title = initName.trim().slice(0, 40)
      if (title) {
        await api.renameSession(session.id, title)
        useStore.setState((cur) => ({
          activeSession:
            cur.activeSession?.id === session.id
              ? { ...cur.activeSession, title, titleLocked: true }
              : cur.activeSession,
          sessions: cur.sessions.map((s) => (s.id === session.id ? { ...s, title } : s))
        }))
      }

      // 等 webview attach 并完成绑定：初始化提示词必须发进这条新对话
      const tabs = useStore.getState().tabs
      const tab =
        tabs.find((t) => t.sessionId === session.id) ??
        tabs.find((t) => t.providerId === session.providerId)
      if (tab) {
        const wcId = webviewWcId(tab.id)
        if (wcId <= 0) await waitWebviewWcId(tab.id, 60)
      }

      setInitOpen(false)
      useStore.getState().notice('正在初始化网页会话…')
      const ok = await api.startProjectSession(session.id)
      if (!ok) {
        useStore.getState().notice('网页还没准备好，初始化未完成：可稍后在网页模式重试', 'warn')
        return
      }
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 60)
    } catch (e) {
      useStore
        .getState()
        .notice(`初始化失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setInitStarting(false)
    }
  }

  const startComposerResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeStart.current = {
      y: e.clientY,
      h: inputRef.current?.getBoundingClientRect().height ?? 46
    }
  }
  const moveComposerResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeStart.current
    if (!start) return
    const max = Math.max(160, Math.round(window.innerHeight * 0.5))
    setComposerHeight(Math.min(max, Math.max(46, start.h + (start.y - e.clientY))))
  }
  const endComposerResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    resizeStart.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const startEdit = (text: string, turnId: string): void => {
    setInput(text)
    setEditingTurnId(turnId)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(text.length, text.length)
    })
  }

  useEffect(() => {
    setEditingTurnId(null)
    setEarlyExpanded(false)
  }, [activeSession?.id])

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text) return
    // 快捷指令模板里的占位符没填就发送，AI 收到的是一句带 {{input}} 的指令
    if (text.includes('{{input}}')) {
      useStore.getState().notice('请先把 {{input}} 替换为具体内容再发送', 'warn')
      return
    }
    setInput('')
    setEditingTurnId(null)
    setSlashOpen(false)
    const session = activeSession
    if (text === '/new') {
      const providerId = session?.providerId ?? preferredProviderId()
      if (providerId) await useStore.getState().createSession(providerId)
      return
    }
    if (!session) {
      const providerId = preferredProviderId()
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
      await useStore.getState().openProviderTab(created.providerId, created.id, created.accountId)
      await useStore.getState().sendPrompt(text)
      clearAttachments(created.id)
      return
    }
    if (text === '/compact') {
      const next = await api.compactSession(session.id)
      useStore.setState({ activeSession: next })
      return
    }
    if (text === '/memory') {
      await sendPrompt(
        '请用 remember 工具保存本次会话的关键结论与用户偏好（若无可保存内容请直接说明）。'
      )
      clearAttachments(session.id)
      return
    }
    if (text === '/plan') {
      await sendPrompt('请先用 planSubmit 工具把这个需求拆解为分步计划，等待我确认后再执行。')
      clearAttachments(session.id)
      return
    }
    await sendPrompt(text)
    clearAttachments(session.id)
  }

  const slashItems = useMemo(
    () => [
      ...SLASH_COMMANDS.map((c) => ({
        key: c.cmd,
        trigger: c.cmd,
        label: c.desc,
        template: c.cmd
      })),
      ...quickCmds
        .filter((q) => q.enabled)
        .map((q) => ({
          key: `q_${q.id}`,
          trigger: `/${q.trigger}`,
          label: q.name,
          template: q.template
        })),
      // 技能也作为斜杠命令暴露；输入后由 AI 调 readSkill 读取正文（渐进披露，不塞满上下文）
      ...skills
        .filter((s) => s.name.trim() && s.enabled !== false)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({
          key: `skill_${s.path}`,
          trigger: `/${s.name.trim().replace(/^\/+/, '').replace(/\s+/g, '-')}`,
          label: `技能 · ${s.description || s.name}`,
          template: `请使用技能「${s.name.trim()}」完成任务：`
        }))
    ],
    [quickCmds, skills]
  )
  const slashFiltered = useMemo(() => {
    const q = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : ''
    if (!q) return slashItems
    return slashItems.filter(
      (c) => c.trigger.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)
    )
  }, [slashItems, input])

  useEffect(() => {
    if (slashOpen) slashSelectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slashOpen, slashIndex, slashFiltered.length])

  const totalTextLen = useMemo(() => turns.reduce((n, t) => n + t.text.length, 0), [turns])
  // 上下文变长后默认折叠较早轮次，只保留最近 6 条，避免纯净模式无限拉长
  const shouldFoldEarly = turns.length > 8 || totalTextLen > 8_000
  const keepRecent = 6
  const visibleTurns = shouldFoldEarly && !earlyExpanded ? turns.slice(-keepRecent) : turns
  const empty = turns.length === 0 && !streamingText

  return (
    <div className="relative flex h-full flex-col" style={{ background: 'var(--bg)' }}>
      {/* 会话头 */}
      <div
        className="flex h-11 shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <span className="truncate text-[12.5px] font-medium">
          {activeSession?.title ?? '新会话'}
        </span>
        {activeSession && <span className="badge badge-accent">{activeSession.providerId}</span>}
        <span className="flex-1" />
        {running && (
          <span
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: 'var(--text-hint)' }}
          >
            <span
              className="anim-breathe h-1.5 w-1.5 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            {streamingTps > 0 ? `${streamingTps} tok/s` : '生成中'}
          </span>
        )}
        {!auxPanel && <PureToolbar />}
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
                    background:
                      'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 62%, #8b5cf6))',
                    color: 'var(--on-accent)',
                    boxShadow: '0 6px 20px color-mix(in srgb, var(--accent) 28%, transparent)'
                  }}
                >
                  L
                </span>
                {mode === 'workbench' ? (
                  <>
                    <div className="text-[15px] font-semibold">Agent 活动面板</div>
                    <div
                      className="max-w-[400px] text-[12.5px] leading-[1.75]"
                      style={{ color: 'var(--text-dim)' }}
                    >
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
                    <div
                      className="max-w-[400px] text-[12.5px] leading-[1.75]"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      网页中的 AI 会调用本地工具读写文件、执行命令，
                      <br />
                      结果实时回传到这个面板。
                    </div>
                  </>
                )}
              </div>

              {mode === 'pure' && (
                <div className="flex w-full max-w-[560px] flex-col gap-3">
                  {/* 初始化项目：新任务空态的主入口，点击弹出目录确认弹窗 */}
                  <button
                    className="group flex w-full items-center gap-3 rounded-[var(--r-xl)] border p-4 text-left transition-colors duration-[130ms]"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--accent) 38%, var(--border))',
                      background: 'var(--accent-soft)'
                    }}
                    onClick={() => {
                      setInitName(
                        activeSession?.title && activeSession.title !== '新会话'
                          ? activeSession.title
                          : ''
                      )
                      setInitOpen(true)
                    }}
                  >
                    <span
                      className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px]"
                      style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                    >
                      <IconFolder size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold">初始化项目</span>
                      <span
                        className="mt-0.5 block truncate text-[11.5px]"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {project?.root ?? '选择一个工作目录，AI 才能读写本地文件'}
                      </span>
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-0.5 text-[11.5px]"
                      style={{ color: 'var(--accent)' }}
                    >
                      {project ? '更换' : '选择目录'}
                      <IconChevronRight size={12} />
                    </span>
                  </button>

                  {/* 快捷起手式 */}
                  <div className="grid w-full grid-cols-2 gap-2">
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
                        <span
                          className="line-clamp-2 text-[11px] leading-[1.55]"
                          style={{ color: 'var(--text-hint)' }}
                        >
                          {q.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {shouldFoldEarly && turns.length > keepRecent && (
            <div className="flex justify-center">
              <button
                className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
                style={{
                  background: 'var(--surface-sunken)',
                  color: 'var(--text-dim)',
                  border: '1px solid var(--border)'
                }}
                onClick={() => setEarlyExpanded((v) => !v)}
              >
                <IconChevronDown
                  size={12}
                  className={`transition-transform duration-[150ms] ${earlyExpanded ? 'rotate-180' : ''}`}
                />
                {earlyExpanded ? '收起较早消息' : `展开之前 ${turns.length - keepRecent} 条消息`}
                <span style={{ color: 'var(--text-hint)' }}>· 上下文较长</span>
              </button>
            </div>
          )}
          {visibleTurns.map((t) => (
            <TurnItem
              key={t.id}
              turn={t}
              sessionId={activeSession?.id}
              showActions={mode === 'pure'}
              onEditUser={(text) => startEdit(text, t.id)}
            />
          ))}
          {waiting && <PendingIndicator since={pendingSince} />}
          {/* 文件变更汇总：按「本轮任务」聚合所有轮次的 diff，展示在活动流末尾 */}
          {taskChangeResults.length > 0 && (
            <ChangeCard results={taskChangeResults} running={lastTurn?.status === 'streaming'} />
          )}
          {/* 只显示当前任务进行中的实时思考；任务结束后网页可能还有迟到的思考块，
              不能让它挂在最终答复下面，看起来像「还在想」 */}
          {liveThinking && mode === 'pure' && (
            <ThinkingBlock text={thinkingText} streaming={!streamingText} />
          )}

          {streamingText && mode === 'pure' && (
            <div className="flex flex-col gap-2">
              {/* 流式期间只渲染纯文本：ReactMarkdown+hljs 全量解析长文本会卡死 UI */}
              <div
                className="whitespace-pre-wrap text-[13.5px] leading-[1.68]"
                style={{ color: 'var(--text-body)' }}
              >
                {stripCitationMarkers(streamingText)}
              </div>
              <span
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-hint)' }}
              >
                <span
                  className="anim-breathe h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
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
              <button
                className="btn btn-sm btn-outline"
                onClick={() => {
                  const sid = plan.sessionId
                  useStore.setState({ plan: null })
                  void api.confirmPlan(sid, false)
                }}
              >
                放弃
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  const sid = plan.sessionId
                  useStore.setState({ plan: null })
                  void api.confirmPlan(sid, true)
                }}
              >
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
            style={{
              background: 'var(--danger-soft)',
              border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)'
            }}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
                危险操作确认
              </span>
              {confirmRequest.sessionId && confirmRequest.sessionId !== activeSession?.id && (
                <span className="text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
                  来自「
                  {sessions.find((s) => s.id === confirmRequest.sessionId)?.title ?? '其他会话'}」
                </span>
              )}
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
        {shouldFoldEarly && turns.length > keepRecent && (
          <div className="mx-auto mb-2 flex max-w-[780px] justify-center">
            <button
              className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--text-dim)',
                border: '1px solid var(--border)'
              }}
              onClick={() => setEarlyExpanded((v) => !v)}
            >
              <IconChevronDown
                size={12}
                className={`transition-transform duration-[150ms] ${earlyExpanded ? 'rotate-180' : ''}`}
              />
              {earlyExpanded ? '收起较早消息' : `已折叠之前 ${turns.length - keepRecent} 条消息`}
              <span style={{ color: 'var(--text-hint)' }}>· 上下文较长</span>
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mx-auto flex w-full max-w-[780px] flex-wrap items-center gap-2 px-1 pb-2">
            {attachments.map((a) =>
              a.preview ? (
                <div
                  key={a.key}
                  className="h-12 w-12 overflow-hidden rounded-[10px]"
                  style={{ border: '1px solid var(--border-strong)', background: 'var(--bg)' }}
                  title={`${a.name}（已附加到网页输入框，发送时一起上传）`}
                >
                  <img src={a.preview} alt={a.name} className="h-full w-full object-cover" />
                </div>
              ) : (
                <div
                  key={a.key}
                  className="flex h-12 max-w-[220px] items-center gap-1.5 rounded-[10px] px-2.5"
                  style={{
                    border: '1px solid var(--border)',
                    background: 'var(--surface-sunken)'
                  }}
                  title={`${a.name}（已附加到网页输入框，发送时一起上传）`}
                >
                  <span className="shrink-0" style={{ color: 'var(--text-hint)' }}>
                    <IconFile size={13} />
                  </span>
                  <span className="truncate text-[11px]">{a.name}</span>
                </div>
              )
            )}
          </div>
        )}
        <div
          data-composer="true"
          className="relative mx-auto flex max-w-[780px] flex-col rounded-[var(--r-xl)] transition-colors duration-[160ms]"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow)'
          }}
        >
          {/* 斜杠菜单锚定在输入框上；宽度与输入框一致（Qoder 同款命令面板） */}
          {slashOpen && (
            <div
              className="anim-pop absolute bottom-full left-0 z-50 mb-2 w-full max-w-[calc(100vw-32px)] overflow-hidden rounded-[var(--r-xl)]"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-lg)'
              }}
            >
              <div
                className="border-b px-3 py-2 text-[11px] font-medium"
                style={{ borderColor: 'var(--border-soft)', color: 'var(--text-dim)' }}
              >
                命令
              </div>
              <div className="max-h-[300px] overflow-y-auto p-1">
                {slashFiltered.map((c, i) => (
                  <button
                    key={c.key}
                    ref={i === slashIndex ? slashSelectedRef : undefined}
                    className="flex h-[32px] w-full items-center gap-3 rounded-[var(--r-sm)] px-2.5 text-left transition-colors duration-[100ms]"
                    style={{ background: i === slashIndex ? 'var(--bg-active)' : 'transparent' }}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => {
                      setInput(c.template.includes('{{input}}') ? c.template : `${c.template} `)
                      setSlashOpen(false)
                    }}
                  >
                    <span
                      className="w-[190px] shrink-0 truncate whitespace-nowrap font-mono text-[12px] font-medium"
                      style={{ color: i === slashIndex ? 'var(--accent)' : 'var(--text)' }}
                      title={c.trigger}
                    >
                      {c.trigger}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-[11.5px]"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {c.label}
                    </span>
                  </button>
                ))}
                {slashFiltered.length === 0 && (
                  <div className="px-2.5 py-3 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
                    没有匹配的指令或技能
                  </div>
                )}
              </div>
              <div
                className="flex items-center justify-between border-t px-3 py-2 text-[11px]"
                style={{
                  borderColor: 'var(--border-soft)',
                  background: 'var(--surface-sunken)',
                  color: 'var(--text-hint)'
                }}
              >
                <span>输入内容以搜索命令、技能或快捷指令</span>
                <IconChevronDown size={12} className="opacity-60" />
              </div>
            </div>
          )}
          <div
            className="group flex h-[10px] shrink-0 cursor-row-resize items-center justify-center"
            title="拖动调整输入框高度，双击恢复默认"
            onPointerDown={startComposerResize}
            onPointerMove={moveComposerResize}
            onPointerUp={endComposerResize}
            onPointerCancel={endComposerResize}
            onDoubleClick={() => setComposerHeight(0)}
          >
            <span
              className="h-[3px] w-8 rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              style={{ background: 'var(--border-strong)' }}
            />
          </div>
          {editingTurnId && (
            <div
              className="flex items-center gap-2 px-4 pt-3 text-[11px]"
              style={{ color: 'var(--text-hint)' }}
            >
              <IconEdit size={12} />
              <span>正在编辑消息 · 发送后将作为新消息重新提问</span>
              <button
                className="ml-auto rounded-[var(--r-sm)] px-1.5 py-0.5 transition-colors duration-[120ms] hover:bg-[var(--bg-hover)]"
                onClick={() => {
                  setEditingTurnId(null)
                  setInput('')
                }}
              >
                取消
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            className="max-h-44 min-h-[46px] w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-[1.6] outline-none"
            style={{
              color: 'var(--text)',
              ...(composerHeight ? { height: composerHeight, maxHeight: 'none' } : {})
            }}
            placeholder={editingTurnId ? '修改后按 Enter 重新发送…' : '交给 Lidow 一个任务…'}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setSlashOpen(e.target.value.startsWith('/') && !e.target.value.includes(' '))
              setSlashIndex(0)
            }}
            onPaste={(e) => {
              const dt = e.clipboardData
              if (!dt) return
              const files = [...dt.items]
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => Boolean(f))
              if (files.length === 0) return
              // 同时带文字时保留原生粘贴，避免吞掉用户复制的文本
              if (dt.getData('text/plain')) return
              e.preventDefault()
              if (!activeSession) {
                useStore.getState().notice('请先新建或选择会话，再粘贴图片', 'warn')
                return
              }
              const session = activeSession
              const pastedUrls: string[] = []
              void Promise.all(
                files.slice(0, 4).map(
                  (f) =>
                    new Promise<string>((resolve, reject) => {
                      const reader = new FileReader()
                      reader.onload = () => resolve(String(reader.result ?? ''))
                      reader.onerror = () => reject(reader.error ?? new Error('读取剪贴板图片失败'))
                      reader.readAsDataURL(f)
                    })
                )
              )
                .then((images) => {
                  pastedUrls.push(...images)
                  return api.pasteWebImages(session.id, images)
                })
                .then((r) => {
                  if (r.ok) {
                    // 本地 data URL 已在内存里，直接拿来预览；主进程只补文件路径/名称
                    addAttachments(
                      session.id,
                      pastedUrls.map((src, i) => ({
                        path: r.files?.[i]?.path ?? `paste-${Date.now()}-${i}`,
                        name: r.files?.[i]?.name ?? `粘贴图片 ${i + 1}`,
                        preview: src
                      }))
                    )
                    return
                  }
                  useStore.getState().notice(r.message ?? '图片附加失败', 'warn')
                })
                .catch((err) =>
                  useStore
                    .getState()
                    .notice(
                      `图片附加失败：${err instanceof Error ? err.message : String(err)}`,
                      'error'
                    )
                )
            }}
            onKeyDown={(e) => {
              if (slashOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const n = slashFiltered.length
                if (n > 0)
                  setSlashIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
                return
              }
              if (slashOpen && e.key === 'Enter') {
                const item = slashFiltered[slashIndex]
                if (item) {
                  e.preventDefault()
                  setInput(
                    item.template.includes('{{input}}') ? item.template : `${item.template} `
                  )
                  setSlashOpen(false)
                  return
                }
                // 没有匹配时不吞回车：先收起菜单，下一次 Enter 正常发送
                setSlashOpen(false)
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
          <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1">
            {/* 网页交互开关：深度思考 / 智能搜索 / 上传（点击转发给平台页面） */}
            {/* 平台自带功能：每个平台不同（DeepSeek=深度思考/智能搜索，豆包=对话/项目/技能/快速）。
                按当前会话平台的 adapter.composerActions 渲染，不写死。 */}
            {composerActions.map((a) => {
              // 平台自带开关的真实状态由 overlay 每秒上报：开启的 chip 高亮
              const kw = a.keywords.join(' ')
              const active =
                (toggleState.think && /思考|think/i.test(kw)) ||
                (toggleState.search && /搜索|search/i.test(kw))
              return (
                <button
                  key={a.label}
                  className="composer-chip"
                  title={`切换${a.label}`}
                  style={
                    active
                      ? {
                          color: 'var(--accent)',
                          borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)'
                        }
                      : undefined
                  }
                  onClick={() =>
                    activeSession && void api.overlayAction(activeSession.id, a.keywords)
                  }
                >
                  <IconSpark size={12} /> {a.label}
                </button>
              )
            })}
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title="上传文件/图片（附加到网页输入区）"
              onClick={() => {
                if (!activeSession) return
                if (WEB_MODE) {
                  void api.overlayToggle(activeSession.id, 'upload-file')
                  return
                }
                void api
                  .uploadWebFile(activeSession.id)
                  .then((r) => {
                    if (r.canceled) return
                    if (r.ok) {
                      addAttachments(activeSession.id, r.files ?? [])
                      return
                    }
                    useStore.getState().notice(r.message ?? '文件附加失败', 'warn')
                  })
                  .catch((e) =>
                    useStore
                      .getState()
                      .notice(`上传失败：${e instanceof Error ? e.message : String(e)}`, 'error')
                  )
              }}
            >
              <IconAttach size={13} />
            </button>
            <PermissionPicker />
            <span className="flex-1" />
            {running ? (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void stop(toolRunning ? 'tool' : 'generate')}
              >
                <IconStop size={11} /> {toolRunning ? '停止工具' : '停止生成'}
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

      {/* 初始化项目弹窗：选择/更换工作目录，确认后回到对话输入 */}
      {initOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[76] flex items-center justify-center px-6"
            style={{ background: 'rgba(9,12,18,.42)', backdropFilter: 'blur(3px)' }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !initPicking) setInitOpen(false)
            }}
          >
            <div
              className="anim-pop w-full max-w-[460px] overflow-hidden rounded-[18px]"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 24px 64px rgba(0,0,0,.28)'
              }}
            >
              <div
                className="flex items-center gap-2.5 border-b px-5 py-4"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  <IconFolder size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold">第一步：初始化项目</div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-hint)' }}>
                    AI 需要一个工作目录才能读写你的文件
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-ghost btn-icon"
                  title="关闭"
                  disabled={initPicking}
                  onClick={() => setInitOpen(false)}
                >
                  <IconClose size={12} />
                </button>
              </div>
              <div className="space-y-3 px-5 py-4">
                <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  选定目录后再开始对话；之后也可以在左侧项目菜单中切换。
                </div>
                <div
                  className="rounded-[var(--r-md)] border px-3 py-2.5 font-mono text-[11.5px] break-all"
                  style={{
                    borderColor: 'var(--border-soft)',
                    background: 'var(--surface-sunken)',
                    color: project ? 'var(--text)' : 'var(--warning)'
                  }}
                >
                  {project?.root ?? '尚未选择目录'}
                </div>
                <label className="block">
                  <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                    会话名称（可选）
                  </span>
                  <input
                    className="field h-9"
                    maxLength={40}
                    placeholder="例如：修复登录问题；留空则自动命名"
                    value={initName}
                    onChange={(e) => setInitName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void finishInit()
                      }
                    }}
                  />
                </label>
              </div>
              <div
                className="flex items-center justify-end gap-2 border-t px-5 py-3"
                style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
              >
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={initPicking}
                  onClick={() => setInitOpen(false)}
                >
                  取消
                </button>
                <button
                  className="btn btn-sm btn-outline"
                  disabled={initPicking}
                  onClick={() => void pickProjectDir()}
                >
                  {initPicking ? '选择中…' : project ? '更换目录' : '选择目录'}
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!project || initPicking || initStarting}
                  onClick={() => void finishInit()}
                >
                  {initStarting ? '初始化中…' : '开始对话'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
