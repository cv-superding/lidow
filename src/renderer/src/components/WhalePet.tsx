import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IconClose } from './icons'
import idleClip from '../assets/pet/idle.webm'
import thinkClip from '../assets/pet/think.webm'
import waveClip from '../assets/pet/wave.webm'
import happyClip from '../assets/pet/happy.webm'
import shyClip from '../assets/pet/shy.webm'
import angryClip from '../assets/pet/angry.webm'
import eatClip from '../assets/pet/eat.webm'

const CLIPS = {
  idle: idleClip,
  think: thinkClip,
  wave: waveClip,
  happy: happyClip,
  shy: shyClip,
  angry: angryClip,
  eat: eatClip
} as const

type ClipName = keyof typeof CLIPS
const REACTIONS: ClipName[] = ['wave', 'happy', 'shy', 'angry', 'eat']
const PET_W = 220
const PET_H = 148
const POS_KEY = 'lidow:petPos'

function clampPos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(window.innerWidth - PET_W, x)),
    y: Math.max(0, Math.min(window.innerHeight - PET_H, y))
  }
}

/**
 * 鲸鱼娘桌宠：素材来自 PC2005-cloud/dsh-pet（MIT）。
 * 单击随机互动、拖动换位置；AI 生成中自动切换成思考动画。
 */
export function WhalePet(): React.JSX.Element | null {
  const enabled = useStore((s) => s.settings.desktopPet)
  const busy = useStore(
    (s) => s.streamingText.length > 0 || s.thinkingText.length > 0 || Boolean(s.pendingReplySessionId)
  )
  const [reaction, setReaction] = useState<ClipName | null>(null)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pos, setPos] = useState(() => {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) {
        const p = JSON.parse(raw) as { x?: number; y?: number }
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clampPos(Number(p.x), Number(p.y))
      }
    } catch {
      /* ignore */
    }
    return clampPos(window.innerWidth - PET_W - 18, window.innerHeight - PET_H - 110)
  })
  const drag = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const lastPos = useRef(pos)

  useEffect(() => {
    const onResize = (): void => setPos((p) => clampPos(p.x, p.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!enabled) return null

  const clip: ClipName = reaction ?? (busy ? 'think' : 'idle')

  const react = (): void => {
    const next = REACTIONS[Math.floor(Math.random() * REACTIONS.length)] ?? 'wave'
    setReaction(next)
  }

  const hide = (): void => {
    void api.updateSettings({ desktopPet: false }).then((next) => {
      useStore.setState({ settings: next })
      useStore.getState().notice('桌宠已隐藏，可在 设置 → 外观 重新打开')
    })
  }

  return (
    <div
      className="fixed z-30 select-none"
      style={{
        left: pos.x,
        top: pos.y,
        width: PET_W,
        height: PET_H,
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none'
      }}
      title="鲸鱼娘 · 单击互动，拖动移动"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y, moved: false }
        lastPos.current = pos
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
        const next = clampPos(d.originX + dx, d.originY + dy)
        lastPos.current = next
        setPos(next)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        setDragging(false)
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        if (!d) return
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(lastPos.current))
        } catch {
          /* ignore */
        }
        if (!d.moved) react()
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      <video
        key={clip}
        src={CLIPS[clip]}
        autoPlay
        muted
        playsInline
        preload="auto"
        draggable={false}
        loop={clip === 'idle' || clip === 'think'}
        onEnded={() => setReaction(null)}
        className="pointer-events-none h-full w-full object-contain"
        style={{ filter: 'drop-shadow(0 10px 18px rgba(0,0,0,.28))' }}
      />
      {hovered && (
        <button
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-[130ms]"
          style={{ background: 'rgba(20,22,28,.55)', color: '#fff' }}
          title="隐藏桌宠"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            hide()
          }}
        >
          <IconClose size={9} />
        </button>
      )}
    </div>
  )
}
