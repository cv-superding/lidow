import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import {
  IconMinimize,
  IconMaximize,
  IconRestore,
  IconClose,
  IconPlus,
  IconCheck,
  IconFile,
  IconTerminal,
  IconSettings
} from './icons'

/**
 * 自绘窗口控制（Windows/Linux 关闭原生 frame 后必需）。
 * 按钮区域必须 no-drag，否则会被标题栏拖拽区吞掉点击。
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized)
  }, [])
  const cls =
    'group flex h-full w-[46px] items-center justify-center transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'
  const iconColor = { color: 'var(--text-hint)' } as const
  return (
    <div className="flex h-full items-stretch" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button className={cls} style={iconColor} title="最小化" onClick={() => api.windowMinimize()}>
        <IconMinimize />
      </button>
      <button
        className={cls}
        style={iconColor}
        title={maximized ? '向下还原' : '最大化'}
        onClick={() => void api.windowToggleMaximize().then(setMaximized)}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        className="flex h-full w-[46px] items-center justify-center transition-colors duration-[130ms] hover:bg-[var(--danger)] hover:text-white"
        style={iconColor}
        title="关闭"
        onClick={() => api.windowClose()}
      >
        <IconClose />
      </button>
    </div>
  )
}

/** 纯模式右上工具条：新建 / 任务 / 文件 / 终端 / 设置（Qoder 同款胶囊） */
function PureToolbar({
  terminalOpen,
  onToggleTerminal
}: {
  terminalOpen: boolean
  onToggleTerminal: () => void
}): React.JSX.Element {
  const previewOpen = useStore((s) => s.previewOpen)
  const setPreviewOpen = useStore((s) => s.setPreviewOpen)
  const setPureView = useStore((s) => s.setPureView)
  const btn = 'flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-[130ms] hover:bg-[var(--bg-hover)]'
  const idle = { color: 'var(--text-dim)' } as const
  const active = { color: 'var(--accent)', background: 'var(--accent-soft)' } as const
  const newTask = async (): Promise<void> => {
    const st = useStore.getState()
    const pid = st.activeSession?.providerId ?? st.providers[0]?.id
    if (!pid) {
      st.notice('请先选择一个 AI 平台', 'warn')
      return
    }
    st.setPureView('home')
    await st.createSession(pid)
  }
  return (
    <div
      className="mr-2 flex items-center gap-0.5 rounded-full p-0.5"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <button className={btn} style={idle} title="新建任务 (Ctrl N)" onClick={() => void newTask()}>
        <IconPlus size={14} />
      </button>
      <button className={btn} style={idle} title="任务看板" onClick={() => setPureView('tasks')}>
        <IconCheck size={14} />
      </button>
      <button
        className={btn}
        style={previewOpen ? active : idle}
        title={previewOpen ? '收起文件预览' : '展开文件预览'}
        onClick={() => {
          setPreviewOpen(!previewOpen)
          if (!previewOpen) setPureView('home')
        }}
      >
        <IconFile size={14} />
      </button>
      <button
        className={btn}
        style={terminalOpen ? active : idle}
        title="终端 (Ctrl `)"
        onClick={onToggleTerminal}
      >
        <IconTerminal size={14} />
      </button>
      <button className={btn} style={idle} title="设置" onClick={() => setPureView('settings')}>
        <IconSettings size={14} />
      </button>
    </div>
  )
}

/** 纯模式顶部拖拽条：左侧留白可拖拽，右侧工具条 + 窗口控件 */
export function DragStrip({
  terminalOpen,
  onToggleTerminal
}: {
  terminalOpen: boolean
  onToggleTerminal: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-end border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--sidebar)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <PureToolbar terminalOpen={terminalOpen} onToggleTerminal={onToggleTerminal} />
      <WindowControls />
    </div>
  )
}
