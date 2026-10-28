import { useState } from 'react'
import type { ToolResult } from '@shared/types'

/** 可视化工具卡片：diff / 终端 / 表格 / 文件列表 / 文本 */
export function ToolCard({ result }: { result: ToolResult }): React.JSX.Element {
  const [open, setOpen] = useState(result.ok)
  const display = result.display
  const icon = result.ok ? '✓' : '✗'
  const color = result.ok ? '#4caf7d' : '#e06c6c'

  return (
    <div className="hover-lift w-[92%] overflow-hidden rounded-2xl" style={{ background: 'var(--bg-panel)', border: `1px solid ${result.ok ? 'var(--border)' : '#7a3b3b'}` }}>
      <button
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px]"
        onClick={() => setOpen(!open)}
      >
        <span style={{ color }} className="font-bold">{icon}</span>
        <span className="font-mono" style={{ color: 'var(--accent)' }}>{result.name}</span>
        <span style={{ color: 'var(--text-dim)' }}>{result.durationMs}ms</span>
        {display && <span className="rounded-md px-1.5 py-0.5 text-[10.5px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-dim)' }}>{display.kind}</span>}
        <span className="ml-auto" style={{ color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="anim-tab border-t px-3.5 py-2.5 text-[12.5px]" style={{ borderColor: 'var(--border)' }}>
          {result.error && <div className="mb-2" style={{ color: '#e06c6c' }}>{result.error}</div>}
          {display?.kind === 'diff' && <DiffView patch={display.patch} />}
          {display?.kind === 'terminal' && (
            <div>
              <div className="mb-1.5 font-mono text-[11.5px]" style={{ color: 'var(--text-dim)' }}>$ {display.cmd}</div>
              <pre className="max-h-64 overflow-auto rounded-xl p-2.5 font-mono text-[11.5px] leading-relaxed" style={{ background: '#0d0d11', color: '#c8ccd4' }}>
                {display.output}
              </pre>
            </div>
          )}
          {display?.kind === 'table' && (
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr>
                  {display.columns.map((c) => (
                    <th key={c} className="border-b px-2 py-1" style={{ borderColor: 'var(--border)' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {display.rows.slice(0, 50).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="border-b px-2 py-1" style={{ borderColor: 'var(--border)' }}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {display?.kind === 'files' && (
            <div className="max-h-56 space-y-0.5 overflow-auto font-mono text-[11.5px]">
              {display.files.map((f) => (
                <div key={f}>{f}</div>
              ))}
              {display.truncated && <div style={{ color: 'var(--text-dim)' }}>…已截断</div>}
            </div>
          )}
          {(!display || display.kind === 'text') && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
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
    <div className="overflow-auto rounded-xl font-mono text-[11.5px] leading-relaxed" style={{ background: 'var(--bg-elevated)' }}>
      {lines.map((line, i) => {
        const bg = line.startsWith('+') ? 'rgba(76,175,125,.12)' : line.startsWith('-') ? 'rgba(224,108,108,.12)' : 'transparent'
        const fg = line.startsWith('+') ? '#6fce9c' : line.startsWith('-') ? '#e08a8a' : 'var(--text-dim)'
        return (
          <div key={i} style={{ background: bg, color: fg }} className="whitespace-pre px-3 py-px">
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}
