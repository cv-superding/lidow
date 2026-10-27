import { useEffect, useState } from 'react'
import { api } from './api'
import type { AppSettings } from '@shared/types'

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api
      .getAppState()
      .then((s) => {
        setSettings(s.settings)
        setVersion(s.version)
      })
      .catch(() => setSettings(null))
  }, [])

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-2xl text-3xl font-bold"
        style={{ background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow)' }}
      >
        L
      </div>
      <div className="text-xl font-semibold">Lidow</div>
      <div style={{ color: 'var(--text-dim)' }}>
        {version ? `v${version} · ` : ''}
        {settings ? '就绪' : '正在连接主进程…'}
      </div>
    </div>
  )
}
