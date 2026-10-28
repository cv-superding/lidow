import { useState } from 'react'
import { api } from '../api'
import { IconFolder, IconArrowUp } from './icons'

/**
 * 初始化项目弹窗：选目录 + 输入第一句话。
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(9, 12, 18, 0.5)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="anim-pop w-[540px] max-w-full overflow-hidden rounded-[var(--r-2xl)]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-title">初始化项目</div>
          <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-hint)' }}>
            选择 AI 可以操作的工作目录，然后用一句话说明你想做什么
          </div>
        </div>

        <div className="px-5 py-4">
          {/* 目录 */}
          <div className="text-label mb-1.5">项目目录</div>
          <div className="mb-4 flex gap-2">
            <input className="field font-mono text-[11.5px]" placeholder="尚未选择目录" readOnly value={dir} />
            <button className="btn btn-outline shrink-0" onClick={() => void pick()}>
              <IconFolder size={13} /> 选择
            </button>
          </div>

          {/* 第一句话 */}
          <div className="text-label mb-1.5">第一句话</div>
          <textarea
            className="field min-h-[104px] text-[12.5px]"
            placeholder="例如：看看这个项目的入口文件在哪，然后整理一份结构说明…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
            }}
            autoFocus
          />
          <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
            发送时会自动附加项目上下文与工具说明 · Ctrl+Enter 提交
          </div>
        </div>

        {/* 底部 */}
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-sunken)' }}
        >
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!dir || !text.trim() || busy} onClick={submit}>
            {busy ? '初始化中…' : '开始'}
            {!busy && <IconArrowUp size={13} />}
          </button>
        </div>
      </div>
    </div>
  )
}
