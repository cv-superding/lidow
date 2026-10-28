import { useEffect, useState } from 'react'
import { api } from '../api'
import { IconMinimize, IconMaximize, IconRestore, IconClose } from './icons'

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

/** 纯模式顶部拖拽条：左侧留白可拖拽，右侧窗口控件 */
export function DragStrip(): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-end border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--sidebar)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <WindowControls />
    </div>
  )
}
