import { useEffect, useState } from 'react'
import { useStore } from '@renderer/store'
import { PureModeShell } from '@renderer/components/PureModeShell'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { RightDock } from '@renderer/components/RightDock'
import { SessionDeleteDialog } from '@renderer/components/AppShell'
import { WebLoginDialog } from './webLogin'

function WebNotices(): React.JSX.Element {
  const notices = useStore((s) => s.notices)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {notices.slice(-3).map((n, i) => (
        <div
          key={`${n.ts}-${i}`}
          className="anim-toast flex items-center gap-2 rounded-[var(--r-lg)] px-3.5 py-2.5 text-[12.5px]"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            color:
              n.level === 'error' ? 'var(--danger)' : n.level === 'warn' ? 'var(--warning)' : 'var(--text)'
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background:
                n.level === 'error' ? 'var(--danger)' : n.level === 'warn' ? 'var(--warning)' : 'var(--success)'
            }}
          />
          {n.message}
        </div>
      ))}
    </div>
  )
}

export function WebApp(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  const [loginOpen, setLoginOpen] = useState(false)

  useEffect(() => {
    void useStore.getState().boot()
  }, [])

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="flex flex-col items-center gap-3">
          <span
            className="anim-breathe flex h-10 w-10 items-center justify-center rounded-[11px] text-[17px] font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            L
          </span>
          <span className="text-[12px]" style={{ color: 'var(--text-hint)' }}>正在连接 Lidow…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      <PureModeShell web onLogin={() => setLoginOpen(true)} />
      <div className="relative min-w-0 flex-1">
        <ChatPanel mode="pure" />
      </div>
      <RightDock />
      <SessionDeleteDialog />
      <WebNotices />
      {loginOpen && <WebLoginDialog onClose={() => setLoginOpen(false)} />}
    </div>
  )
}
