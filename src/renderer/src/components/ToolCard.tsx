import { useState } from 'react'
import type { ToolResult } from '@shared/types'
import { IconChevronRight, IconTerminal, IconCheck, IconClose, IconFile } from './icons'

/** 可视化工具卡片：diff / 终端 / 表格 / 文件列表 / 文本 */
export function ToolCard({ result }: { result: ToolResult }): React.JSX.Element {
  const [open, setOpen] = useState(!result.ok)
  const display = result.display

  return (
    <div
      className="overflow-hidden rounded-[var(--r-lg)] transition-colors duration-[130ms]"
      style={{
        background: 'var(--surface)',
        border: `1px solid ${result.ok ? 'var(--border)' : 'color-mix(in srgb, var(--danger) 32%, transparent)'}`
      }}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]"
        onClick={() => setOpen(!open)}
      >
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: result.ok ? 'var(--success-soft)' : 'var(--danger-soft)',
            color: result.ok ? 'var(--success)' : 'var(--danger)'
          }}
        >
          {result.ok ? <IconCheck size={11} /> : <IconClose size={10} />}
        </span>
        <span className="font-mono text-[12px] font-medium" style={{ color: 'var(--text)' }}>
          {result.name}
        </span>
        {display && <span className="badge">{display.kind}</span>}
        <span className="flex-1" />
        <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-hint)' }}>
          {result.durationMs}ms
        </span>
        <IconChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-[200ms] ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="anim-fade border-t px-3 py-2.5" style={{ borderColor: 'var(--border-soft)' }}>
          {result.error && (
            <div
              className="mb-2 rounded-[var(--r-sm)] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed"
              style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
            >
              {result.error}
            </div>
          )}

          {display?.kind === 'diff' && <DiffView patch={display.patch} />}

          {display?.kind === 'terminal' && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                <IconTerminal size={11} />
                {display.cmd}
              </div>
              <pre
                className="max-h-64 overflow-auto rounded-[var(--r-md)] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]"
                style={{ background: 'var(--surface-sunken)', color: 'var(--text-body)', border: '1px solid var(--border-soft)' }}
              >
                {display.output || '（无输出）'}
              </pre>
            </div>
          )}

          {display?.kind === 'table' && (
            <div className="overflow-auto rounded-[var(--r-md)]" style={{ border: '1px solid var(--border)' }}>
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    {display.columns.map((c) => (
                      <th
                        key={c}
                        className="border-b px-2.5 py-1.5 font-medium"
                        style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {display.rows.slice(0, 50).map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className="border-b px-2.5 py-1.5"
                          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-body)' }}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {display?.kind === 'files' && (
            <div className="max-h-56 space-y-0.5 overflow-auto font-mono text-[11.5px]" style={{ color: 'var(--text-body)' }}>
              {display.files.map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <span style={{ color: 'var(--text-hint)' }}>
                    <IconFile size={11} />
                  </span>
                  {f}
                </div>
              ))}
              {display.truncated && <div style={{ color: 'var(--text-hint)' }}>…已截断</div>}
            </div>
          )}

          {(!display || display.kind === 'text') && (
            <pre
              className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6]"
              style={{ color: 'var(--text-dim)' }}
            >
              {result.output || '（无输出）'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function DiffView({ patch }: { patch: string }): React.JSX.Element {
  const lines = patch.split('\n')
  return (
    <div
      className="overflow-auto rounded-[var(--r-md)] font-mono text-[11.5px] leading-[1.6]"
      style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-soft)' }}
    >
      {lines.map((line, i) => {
        const add = line.startsWith('+')
        const del = line.startsWith('-')
        return (
          <div
            key={i}
            className="whitespace-pre px-3 py-px"
            style={{
              background: add
                ? 'color-mix(in srgb, var(--success) 12%, transparent)'
                : del
                  ? 'color-mix(in srgb, var(--danger) 12%, transparent)'
                  : 'transparent',
              color: add ? 'var(--success)' : del ? 'var(--danger)' : 'var(--text-dim)'
            }}
          >
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}
