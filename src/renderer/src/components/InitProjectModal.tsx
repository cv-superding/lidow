import { useState } from 'react'
import { api } from '../api'

/**
 * 初始化项目弹窗（cuckoo init-prompt 同款）：选目录 + 输入第一句话。
 * 工作台和纯净模式共用；发送时由 loop 附加项目上下文与系统提示词。
 */
export function InitProjectModal({
  onClose,
  onSend
}: {
  onClose: () => void
  onSend: (text: string) => void
}): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    const d = await api.pickDirectory()
    if (d) setDir(d)
  }

  const submit = (): void => {
    if (!dir || !text.trim() || busy) return
    setBusy(true)
    void api
      .openProject(dir)
      .then(() => onSend(text.trim()))
      .catch(() => setBusy(false))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }}>
      <div
        className="anim-pop w-[560px] max-w-[92vw] rounded-2xl p-5"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow)' }}
      >
        <div className="mb-1 text-[15px] font-semibold">初始化项目</div>
        <div className="mb-4 text-[11.5px]" style={{ color: 'var(--text-hint)' }}>
          选择 AI 可以操作的工作目录，然后用一句话说明你想做什么
        </div>

        <div className="mb-1.5 text-[12px]" style={{ color: 'var(--text-hint)' }}>
          项目目录
        </div>
        <div className="mb-4 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[12.5px] outline-none"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)' }}
            placeholder="请先选择项目目录"
            readOnly
            value={dir}
          />
          <button
            className="shrink-0 rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={() => void pick()}
          >
            选择目录
          </button>
        </div>

        <div className="mb-1.5 text-[12px]" style={{ color: 'var(--text-hint)' }}>
          你要对 AI 说的第一句话（自动附加项目上下文与工具说明）
        </div>
        <textarea
          className="mb-4 min-h-[110px] w-full resize-none rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)' }}
          placeholder="例如：帮我看看这个项目的入口文件在哪里，然后整理一份结构说明…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            className="rounded-lg px-4 py-2 text-[12.5px]"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded-lg px-4 py-2 text-[12.5px] disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
            disabled={!dir || !text.trim() || busy}
            onClick={submit}
          >
            {busy ? '初始化中…' : '开始'}
          </button>
        </div>
      </div>
    </div>
  )
}
