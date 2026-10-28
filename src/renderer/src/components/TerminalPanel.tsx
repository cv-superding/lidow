import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { IconTerminal, IconClose, IconArrowUp } from './icons'

interface Line {
  kind: 'cmd' | 'out' | 'meta'
  text: string
}

/**
 * 内置终端面板：用户手动跑命令（不经过 AI，也不弹确认门）。
 * 命令行历史上下键翻阅；输出合并 stdout/stderr。
 */
export function TerminalPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  // -1 表示不在翻阅历史
  const [histIndex, setHistIndex] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api.terminalCwd().then(setCwd).catch(() => setCwd(''))
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const run = async (): Promise<void> => {
    const cmd = input.trim()
    if (!cmd || busy) return
    setBusy(true)
    setInput('')
    setHistIndex(-1)
    setHistory((h) => [...h, cmd].slice(-100))
    setLines((l) => [...l, { kind: 'cmd', text: cmd }])
    try {
      const r = await api.runTerminal(cmd)
      setLines((l) => {
        const next = [...l]
        if (r.output.trim()) next.push({ kind: 'out', text: r.output.replace(/\s+$/, '') })
        next.push({
          kind: 'meta',
          text: r.timedOut ? '⏱ 超时已中止' : `exit ${r.exitCode ?? 'null'}`
        })
        return next
      })
    } catch (e) {
      setLines((l) => [...l, { kind: 'meta', text: `执行失败：${e instanceof Error ? e.message : String(e)}` }])
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

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--surface-sunken)' }}>
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
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setLines([])}
          title="清空输出"
        >
          清空
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" title="关闭终端" onClick={onClose}>
          <IconClose size={12} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6]">
        {lines.length === 0 && (
          <div className="py-6 text-center text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
            在这里直接运行命令，AI 不会参与
            <br />
            支持 ↑ ↓ 翻阅历史，Enter 执行
          </div>
        )}
        {lines.map((l, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap break-words"
            style={{
              color:
                l.kind === 'cmd'
                  ? 'var(--text)'
                  : l.kind === 'meta'
                    ? 'var(--text-hint)'
                    : 'var(--text-body)'
            }}
          >
            {l.kind === 'cmd' ? (
              <>
                <span style={{ color: 'var(--accent)' }}>❯ </span>
                {l.text}
              </>
            ) : (
              l.text
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 py-1" style={{ color: 'var(--text-hint)' }}>
            <span className="anim-breathe h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            运行中…
          </div>
        )}
      </div>

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
