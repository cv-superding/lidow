import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { parseAnsi, hasAnsi, type AnsiSpan } from '../ansi'
import { IconTerminal, IconClose, IconArrowUp, IconTrash } from './icons'

interface Block {
  id: number
  cmd: string
  out: string
  exitCode: number | null
  timedOut: boolean
  running: boolean
}

/** 渲染一段可能带 ANSI 色的输出 */
function AnsiText({ text }: { text: string }): React.JSX.Element {
  const spans = useMemo<AnsiSpan[]>(() => (hasAnsi(text) ? parseAnsi(text) : [{ text }]), [text])
  return (
    <>
      {spans.map((s, i) => {
        if (!s.color && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse) {
          return <span key={i}>{s.text}</span>
        }
        return (
          <span
            key={i}
            style={{
              color: s.inverse ? 'var(--surface-sunken)' : s.color,
              background: s.inverse ? s.color ?? 'var(--text-dim)' : undefined,
              fontWeight: s.bold ? 600 : undefined,
              opacity: s.dim ? 0.65 : undefined,
              fontStyle: s.italic ? 'italic' : undefined,
              textDecoration: s.underline ? 'underline' : undefined
            }}
          >
            {s.text}
          </span>
        )
      })}
    </>
  )
}

/**
 * 内置终端：用户手动跑命令（不经过 AI，也不弹确认门）。
 * 顶部可拖拽调整高度；命令历史 ↑↓ 翻阅；输出支持 ANSI 颜色。
 */
export function TerminalPanel({
  onClose,
  height = 0,
  onHeightChange = () => undefined,
  embedded = false
}: {
  onClose: () => void
  height?: number
  onHeightChange?: (h: number) => void
  /** 嵌入右侧栏：隐藏拖拽条与标题栏，由 Dock 头部承担 */
  embedded?: boolean
}): React.JSX.Element {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIndex, setHistIndex] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)

  useEffect(() => {
    void api.terminalCwd().then(setCwd).catch(() => setCwd(''))
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks])

  const run = async (): Promise<void> => {
    const cmd = input.trim()
    if (!cmd || busy) return
    const id = nextId.current++
    setBusy(true)
    setInput('')
    setHistIndex(-1)
    setHistory((h) => [...h, cmd].slice(-200))
    setBlocks((b) => [...b, { id, cmd, out: '', exitCode: null, timedOut: false, running: true }])
    try {
      const r = await api.runTerminal(cmd)
      setBlocks((b) =>
        b.map((x) =>
          x.id === id ? { ...x, out: r.output.replace(/\s+$/, ''), exitCode: r.exitCode, timedOut: r.timedOut, running: false } : x
        )
      )
    } catch (e) {
      setBlocks((b) =>
        b.map((x) =>
          x.id === id
            ? { ...x, out: `执行失败：${e instanceof Error ? e.message : String(e)}`, exitCode: null, running: false }
            : x
        )
      )
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const recall = (dir: -1 | 1): void => {
    if (history.length === 0) return
    const next = histIndex === -1 ? (dir === -1 ? history.length - 1 : -1) : histIndex + dir
    if (next < 0 || next >= history.length) {
      setHistIndex(-1)
      setInput('')
      return
    }
    setHistIndex(next)
    setInput(history[next] ?? '')
  }

  // ---- 顶部拖拽调整高度 ----
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      // 往上拖 = 变高
      const next = startH.current + (startY.current - e.clientY)
      onHeightChange(Math.min(720, Math.max(120, next)))
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onHeightChange])

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--surface-sunken)' }}>
      {!embedded && (
        <div
          className="group relative h-[5px] shrink-0 cursor-ns-resize"
          style={{ background: 'var(--border)' }}
          onMouseDown={(e) => {
            dragging.current = true
            startY.current = e.clientY
            startH.current = height
            document.body.style.cursor = 'ns-resize'
            document.body.style.userSelect = 'none'
            e.preventDefault()
          }}
        >
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 h-[2px] w-8 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
            style={{ background: 'var(--accent)' }}
          />
        </div>
      )}

      {embedded ? (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="truncate font-mono text-[10px]" style={{ color: 'var(--text-hint)' }} title={cwd}>
            {cwd}
          </span>
          <span className="flex-1" />
          <button className="btn btn-sm btn-ghost" title="清空输出" onClick={() => setBlocks([])}>
            <IconTrash size={11} />
          </button>
        </div>
      ) : (
        <div
          className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          <span style={{ color: 'var(--text-dim)' }}>
            <IconTerminal size={13} />
          </span>
          <span className="text-[12px] font-medium">终端</span>
          <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
            {cwd}
          </span>
          <span className="flex-1" />
          <button className="btn btn-sm btn-ghost" title="清空输出" onClick={() => setBlocks([])}>
            <IconTrash size={12} /> 清空
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" title="关闭终端" onClick={onClose}>
            <IconClose size={12} />
          </button>
        </div>
      )}

      {/* 输出区 */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.65]"
      >
        {blocks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            <div>在这里直接运行命令，AI 不会参与</div>
            <div className="text-[10.5px]">
              ↑ ↓ 翻阅历史 · Enter 执行{embedded ? '' : ' · 拖顶部横条调整高度'}
            </div>
          </div>
        )}
        {blocks.map((b) => (
          <div key={b.id} className="mb-1.5 last:mb-0">
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0" style={{ color: 'var(--accent)' }}>
                ❯
              </span>
              <span className="min-w-0 break-all" style={{ color: 'var(--text)' }}>
                {b.cmd}
              </span>
            </div>
            {b.running && (
              <div className="flex items-center gap-1.5 py-0.5" style={{ color: 'var(--text-hint)' }}>
                <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                运行中…
              </div>
            )}
            {b.out && (
              <pre className="m-0 whitespace-pre-wrap break-words font-mono" style={{ color: 'var(--text-body)' }}>
                <AnsiText text={b.out} />
              </pre>
            )}
            {!b.running && (
              <div className="text-[10.5px]" style={{ color: b.timedOut ? 'var(--warning)' : 'var(--text-hint)' }}>
                {b.timedOut ? '⏱ 超时已中止' : `exit ${b.exitCode ?? '—'}`}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 输入行 */}
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <span className="font-mono text-[12px]" style={{ color: 'var(--accent)' }}>
          ❯
        </span>
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none"
          style={{ color: 'var(--text)' }}
          placeholder={busy ? '等待上一条命令结束…' : '输入命令…'}
          value={input}
          disabled={busy}
          onChange={(e) => {
            setInput(e.target.value)
            setHistIndex(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              recall(-1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              recall(1)
            }
          }}
        />
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          disabled={!input.trim() || busy}
          onClick={() => void run()}
          title="执行"
        >
          <IconArrowUp size={12} />
        </button>
      </div>
    </div>
  )
}
