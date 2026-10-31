import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 侧栏宽度拖拽手柄：附在侧栏右边界，hover 显示高亮，拖动改宽度。
 *
 * 用 pointer events + setPointerCapture：鼠标移出元素后仍持续接收移动事件
 * （用 mousemove 在窗口外会断）。拖动期间给 body 加拖拽光标并禁用选区，
 * 否则会选中侧栏文字。
 */
export function ResizeHandle({
  width,
  onResize,
  min = 200,
  max = 520,
  title = '拖动调整宽度',
  side = 'right'
}: {
  width: number
  onResize: (w: number) => void
  min?: number
  max?: number
  title?: string
  /** right：手柄贴在容器右边界（左侧栏）；left：贴在左边界（右侧面板），拖动方向相反 */
  side?: 'left' | 'right'
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 只响应左键
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      startX.current = e.clientX
      startW.current = width
      setDragging(true)
    },
    [width]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const delta = e.clientX - startX.current
      // 手柄在左边界时，往左拖 = 变宽
      const next = startW.current + (side === 'left' ? -delta : delta)
      onResize(Math.min(max, Math.max(min, next)))
    },
    [dragging, max, min, onResize, side]
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }, [])

  // 拖动期间统一光标 + 禁止选中
  useEffect(() => {
    if (!dragging) return
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={title}
      title={title}
      className="group absolute top-0 z-20 h-full w-[7px] cursor-col-resize"
      style={{
        [side === 'left' ? 'left' : 'right']: 0,
        transform: side === 'left' ? 'translateX(-50%)' : 'translateX(50%)',
        touchAction: 'none'
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 拖动中手柄被卸载（切面板）时也会触发，避免 body 残留 col-resize
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(side === 'left' ? 320 : 268)}
    >
      {/* 视觉指示：hover 半亮，拖动时全亮并加宽 */}
      <span
        className="pointer-events-none absolute left-1/2 top-0 h-full -translate-x-1/2 transition-all duration-[130ms] group-hover:opacity-60"
        style={{
          width: dragging ? 3 : 1.5,
          background: 'var(--accent)',
          opacity: dragging ? 1 : 0
        }}
      />
    </div>
  )
}
