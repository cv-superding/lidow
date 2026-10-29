import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IconClose } from './icons'
import {
  PET_BASE_H,
  PET_BASE_W,
  PET_IDLE_REACTIONS,
  PET_REACTIONS,
  clampPetPos,
  defaultPetPos,
  idleLine,
  nextPetSize,
  petClip,
  petSizeAt,
  reactionLine,
  workingLine,
  type PetReaction
} from '../pet'
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

const POS_KEY = 'lidow:petPos'
const POS_VERSION = 2
const SIZE_KEY = 'lidow:petSize'
const QUIET_KEY = 'lidow:petQuiet'
const HINT_KEY = 'lidow:petHintSeen'
const MENU_W = 212
const MENU_H = 310
const PURE_BOTTOM_INSET = 150

type BubbleTone = 'info' | 'happy' | 'warn'
type Bubble = { text: string; tone: BubbleTone; live?: boolean; n: number }

function readPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { x?: number; y?: number; v?: number }
    // 旧坐标没有避开输入框/右栏，升级后重置一次默认位置
    if (p.v !== POS_VERSION) return null
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: Number(p.x), y: Number(p.y) }
  } catch {
    /* ignore */
  }
  return null
}

function savePos(p: { x: number; y: number }): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ ...p, v: POS_VERSION }))
  } catch {
    /* ignore */
  }
}

function readSizeIndex(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw === null) return 1
    const index = Number(raw)
    if (Number.isInteger(index) && index >= 0 && index < 3) return index
  } catch {
    /* ignore */
  }
  return 1
}

function readQuiet(): boolean {
  try {
    return localStorage.getItem(QUIET_KEY) === '1'
  } catch {
    return false
  }
}

/** 默认位置避开右侧工具侧栏和底部输入区 */
function defaultPosition(w: number, h: number): { x: number; y: number } {
  const st = useStore.getState()
  const rightInset = st.auxPanel ? st.auxWidth : 0
  // 纯净模式的对话页底部有输入框，宠物要落在它上方
  const bottomInset = st.pureMode && st.pureView === 'home' ? PURE_BOTTOM_INSET : 36
  return defaultPetPos(window.innerWidth, window.innerHeight, w, h, rightInset, bottomInset)
}

/**
 * 鲸鱼娘桌宠：素材来自 PC2005-cloud/dsh-pet（MIT）。
 * 待机/工作状态联动、点击回应、投喂、气泡、右键菜单、尺寸与位置记忆。
 */
export function WhalePet(): React.JSX.Element | null {
  const enabled = useStore((s) => s.settings.desktopPet)
  const busy = useStore(
    (s) => s.streamingText.length > 0 || s.thinkingText.length > 0 || Boolean(s.pendingReplySessionId)
  )
  const thinking = useStore((s) => s.thinkingText.length > 0)
  const writing = useStore((s) => s.streamingText.length > 0)
  const toolBusy = useStore((s) => {
    const turns = s.activeSession?.turns
    const last = turns && turns.length > 0 ? turns[turns.length - 1] : undefined
    return Boolean(last?.status === 'streaming' && (last.toolResults?.length ?? 0) > 0)
  })
  const activeSessionId = useStore((s) => s.activeSession?.id ?? '')
  const lastTurnId = useStore((s) => s.activeSession?.turns.at(-1)?.id ?? '')
  const lastTurnStatus = useStore((s) => s.activeSession?.turns.at(-1)?.status ?? '')
  const confirmId = useStore((s) => s.confirmRequest?.callId ?? '')
  const auxPanel = useStore((s) => s.auxPanel)
  const auxWidth = useStore((s) => s.auxWidth)
  const pureMode = useStore((s) => s.pureMode)
  const pureView = useStore((s) => s.pureView)

  const [reaction, setReaction] = useState<{ clip: PetReaction; n: number } | null>(null)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [sizeIdx, setSizeIdx] = useState(readSizeIndex)
  const [quiet, setQuiet] = useState(readQuiet)

  const size = petSizeAt(sizeIdx)
  const petW = Math.round(PET_BASE_W * size.scale)
  const petH = Math.round(PET_BASE_H * size.scale)

  const [pos, setPos] = useState(() => {
    const initial = petSizeAt(readSizeIndex())
    const w = Math.round(PET_BASE_W * initial.scale)
    const h = Math.round(PET_BASE_H * initial.scale)
    const saved = readPos()
    return saved
      ? clampPetPos(saved.x, saved.y, w, h, window.innerWidth, window.innerHeight)
      : defaultPosition(w, h)
  })

  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(
    null
  )
  const lastPos = useRef(pos)
  const quietRef = useRef(quiet)
  const bubbleTimer = useRef<number | null>(null)
  const finishTimer = useRef<number | null>(null)

  const say = useCallback((text: string, tone: BubbleTone = 'info', ttl = 4200): void => {
    if (quietRef.current) return
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    setBubble({ text, tone, n: Date.now() })
    bubbleTimer.current = window.setTimeout(() => {
      setBubble(null)
      bubbleTimer.current = null
    }, ttl)
  }, [])

  const showReaction = useCallback((clip: PetReaction): void => {
    setReaction({ clip, n: Date.now() })
  }, [])

  // 动作片段播完自动回待机；onEnded 之外的兜底（视频被节流/解码失败时）
  useEffect(() => {
    if (!reaction) return
    const timer = window.setTimeout(() => setReaction(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [reaction])

  useEffect(() => {
    return () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current)
    }
  }, [])

  // 首次启用时给一次操作提示，之后靠右键菜单发现能力
  useEffect(() => {
    if (!enabled) return
    try {
      if (localStorage.getItem(HINT_KEY)) return
    } catch {
      return
    }
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(HINT_KEY, '1')
      } catch {
        /* ignore */
      }
      showReaction('wave')
      say('单击互动 · 右键更多 · 拖我换位置', 'info', 6_200)
    }, 1_400)
    return () => window.clearTimeout(timer)
  }, [enabled, say, showReaction])

  // 会话状态联动：开始工作 / 工具执行 / 完成 / 出错 / 停止 / 等待确认
  const prev = useRef({ busy, toolBusy, sessionId: activeSessionId, turnId: lastTurnId, status: lastTurnStatus, confirmId })
  useEffect(() => {
    const p = prev.current
    const current = { busy, toolBusy, sessionId: activeSessionId, turnId: lastTurnId, status: lastTurnStatus, confirmId }
    if (!enabled) {
      prev.current = current
      if (finishTimer.current !== null) {
        window.clearTimeout(finishTimer.current)
        finishTimer.current = null
      }
      return
    }
    const sameSession = Boolean(activeSessionId) && activeSessionId === p.sessionId
    if (activeSessionId !== p.sessionId && finishTimer.current !== null) {
      window.clearTimeout(finishTimer.current)
      finishTimer.current = null
    }

    if (busy && !p.busy) {
      if (finishTimer.current !== null) {
        window.clearTimeout(finishTimer.current)
        finishTimer.current = null
      }
      setReaction(null)
      say('交给我吧，马上处理～', 'info', 2_400)
    }
    if (busy && toolBusy && !p.toolBusy) say('正在调用本地工具…', 'info', 3_000)

    if (!busy && p.busy && sameSession) {
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current)
      const sid = activeSessionId
      // 自动续接/多轮工具会在中途短暂 busy=false，延后确认避免反复弹「搞定」
      finishTimer.current = window.setTimeout(() => {
        finishTimer.current = null
        const st = useStore.getState()
        if (st.activeSession?.id !== sid) return
        if (st.streamingText.length > 0 || st.thinkingText.length > 0 || st.pendingReplySessionId) return
        const turn = st.activeSession?.turns.at(-1)
        if (turn?.status === 'error') {
          showReaction('angry')
          say('这次没跑通，去看看日志吧…', 'warn', 5_200)
        } else if (turn?.status === 'stopped') {
          showReaction('shy')
          say('已经停下啦', 'info', 3_200)
        } else {
          showReaction('happy')
          say('搞定！', 'happy', 3_800)
        }
      }, 900)
    }

    if (confirmId && confirmId !== p.confirmId) {
      showReaction('wave')
      say('这里需要你确认一下', 'warn', 5_200)
    }
    prev.current = current
  }, [enabled, busy, toolBusy, activeSessionId, lastTurnId, lastTurnStatus, confirmId, say, showReaction])

  // 空闲时偶尔自己动一下，别让桌宠像张贴纸
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => {
      const st = useStore.getState()
      const busyNow = st.streamingText.length > 0 || st.thinkingText.length > 0 || Boolean(st.pendingReplySessionId)
      if (busyNow || document.hidden) return
      if (Math.random() > 0.35) return
      const clip = PET_IDLE_REACTIONS[Math.floor(Math.random() * PET_IDLE_REACTIONS.length)] ?? 'wave'
      showReaction(clip)
      if (!quietRef.current) {
        const line = Math.random() < 0.5 ? idleLine() : reactionLine(clip)
        say(line, 'info', 3_800)
      }
    }, 75_000)
    return () => window.clearInterval(timer)
  }, [enabled, say, showReaction])

  // 窗口尺寸/缩放变化后把宠物收回可视区
  useEffect(() => {
    setPos((p) => {
      const next = clampPetPos(p.x, p.y, petW, petH, window.innerWidth, window.innerHeight)
      if (next.x !== p.x || next.y !== p.y) savePos(next)
      return next
    })
  }, [petW, petH])

  // 右侧工具侧栏打开时，别让宠物正好盖在面板上
  useEffect(() => {
    if (!enabled || !auxPanel) return
    setPos((p) => {
      const maxRight = window.innerWidth - auxWidth - 8
      if (p.x + petW <= maxRight) return p
      const next = clampPetPos(maxRight - petW, p.y, petW, petH, window.innerWidth, window.innerHeight)
      savePos(next)
      return next
    })
  }, [enabled, auxPanel, auxWidth, petW, petH])

  // 进入纯净模式对话页时，从输入框上方让开
  useEffect(() => {
    if (!enabled || !pureMode || pureView !== 'home') return
    setPos((p) => {
      const maxBottom = window.innerHeight - PURE_BOTTOM_INSET
      if (p.y + petH <= maxBottom) return p
      const next = clampPetPos(p.x, maxBottom - petH, petW, petH, window.innerWidth, window.innerHeight)
      savePos(next)
      return next
    })
  }, [enabled, pureMode, pureView, petW, petH])

  useEffect(() => {
    const onResize = (): void => {
      setPos((p) => {
        const next = clampPetPos(p.x, p.y, petW, petH, window.innerWidth, window.innerHeight)
        if (next.x !== p.x || next.y !== p.y) savePos(next)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [petW, petH])

  // 右键菜单：点外面 / Esc / 窗口变化时关闭
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Element | null
      if (target?.closest?.('[data-pet-menu]') || target?.closest?.('[data-whale-pet]')) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    const onResize = (): void => setMenu(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [menu])

  if (!enabled) return null

  const clip = petClip(reaction?.clip ?? null, busy)
  const liveText = busy ? workingLine({ toolBusy, thinking, writing }) : ''
  const shown: Bubble | null = quiet
    ? null
    : (bubble ?? (liveText ? { text: liveText, tone: 'info', live: true, n: 0 } : null))
  const bubbleAbove = pos.y > 84
  const bubbleHalf = 130
  const centerX = pos.x + petW / 2
  const bubbleCenter = Math.min(Math.max(centerX, bubbleHalf + 8), window.innerWidth - bubbleHalf - 8)
  const bubbleShift = bubbleCenter - centerX

  const react = (): void => {
    const next = PET_REACTIONS[Math.floor(Math.random() * PET_REACTIONS.length)] ?? 'wave'
    setMenu(null)
    showReaction(next)
    say(reactionLine(next), next === 'angry' ? 'warn' : 'info', 3_400)
  }

  const feed = (): void => {
    setMenu(null)
    showReaction('eat')
    say(reactionLine('eat'), 'happy', 3_800)
  }

  const cycleSize = (): void => {
    const next = nextPetSize(sizeIdx)
    const nextSize = petSizeAt(next)
    const w = Math.round(PET_BASE_W * nextSize.scale)
    const h = Math.round(PET_BASE_H * nextSize.scale)
    setSizeIdx(next)
    try {
      localStorage.setItem(SIZE_KEY, String(next))
    } catch {
      /* ignore */
    }
    setPos((p) => {
      const clamped = clampPetPos(p.x, p.y, w, h, window.innerWidth, window.innerHeight)
      savePos(clamped)
      return clamped
    })
    setMenu(null)
    showReaction('happy')
    say(`换成${nextSize.label}号啦`, 'info', 2_600)
  }

  const resetPosition = (): void => {
    const next = defaultPosition(petW, petH)
    setPos(next)
    savePos(next)
    setMenu(null)
    showReaction('happy')
    say('回到老位置啦', 'info', 2_800)
  }

  const toggleQuiet = (): void => {
    const next = !quiet
    setQuiet(next)
    quietRef.current = next
    try {
      localStorage.setItem(QUIET_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
    setMenu(null)
    if (next) {
      if (bubbleTimer.current !== null) {
        window.clearTimeout(bubbleTimer.current)
        bubbleTimer.current = null
      }
      setBubble(null)
    } else {
      say('气泡已开启～', 'info', 2_600)
    }
    showReaction('wave')
  }

  const openSettings = (): void => {
    setMenu(null)
    const st = useStore.getState()
    if (st.pureMode) st.setPure(false)
    st.setView('settings')
    window.setTimeout(() => {
      document.getElementById('settings-appearance')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 180)
  }

  const hide = (): void => {
    setMenu(null)
    void api.updateSettings({ desktopPet: false }).then((next) => {
      useStore.setState({ settings: next })
      useStore.getState().notice('桌宠已隐藏，可在 设置 → 外观 重新打开')
    })
  }

  const menuPosition = (): { x: number; y: number } => {
    // 菜单贴在宠物旁边，不盖住它；右侧工具侧栏也算占用空间
    const reservedRight = auxPanel ? auxWidth : 0
    const rightSpace = window.innerWidth - reservedRight - (pos.x + petW) - 8
    const x = rightSpace >= MENU_W ? pos.x + petW + 8 : pos.x - MENU_W - 8
    const y = pos.y + petH / 2 - 70
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8))
    }
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(menuPosition())
  }

  const menuItem =
    'flex h-[30px] w-full items-center gap-2 rounded-[var(--r-sm)] px-2.5 text-left text-[12px] transition-colors duration-[110ms] hover:bg-[var(--bg-hover)]'

  return (
    <>
      <div
        data-whale-pet
        className="fixed z-30 select-none"
        style={{
          left: pos.x,
          top: pos.y,
          width: petW,
          height: petH,
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          opacity: dragging ? 0.92 : 1,
          outline: 'none'
        }}
        title="鲸鱼娘 · 单击互动 · 右键菜单 · 拖动移动"
        role="button"
        tabIndex={0}
        aria-label="鲸鱼娘桌宠：单击互动，右键更多，拖动移动"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            react()
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            setMenu(menuPosition())
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          setMenu(null)
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
          const next = clampPetPos(d.originX + dx, d.originY + dy, petW, petH, window.innerWidth, window.innerHeight)
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
          savePos(lastPos.current)
          if (!d.moved) react()
        }}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
        }}
      >
        <video
          key={reaction ? `${clip}-${reaction.n}` : clip}
          src={CLIPS[clip]}
          autoPlay
          muted
          playsInline
          preload="auto"
          draggable={false}
          loop={clip === 'idle' || clip === 'think'}
          onEnded={() => setReaction(null)}
          className="pointer-events-none h-full w-full object-contain"
          style={{
            filter: 'drop-shadow(0 10px 18px rgba(0,0,0,.28))',
            transform: hovered && !dragging ? 'translateY(-2px) scale(1.015)' : undefined,
            transition: 'transform 180ms ease'
          }}
        />
        {hovered && (
          <button
            className="absolute right-1 top-1 z-50 flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-[130ms]"
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
        {shown && (
          <div
            key={`${shown.n}-${shown.live ? 'live' : 'say'}`}
            className="pointer-events-none absolute z-40 w-max max-w-[250px]"
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${bubbleShift}px))`,
              ...(bubbleAbove ? { bottom: petH + 10 } : { top: petH + 10 })
            }}
            role="status"
            aria-live="polite"
          >
            <div
              className="anim-pop relative rounded-[12px] px-3 py-2 text-[12px] leading-relaxed"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-lg)',
                color:
                  shown.tone === 'warn' ? 'var(--danger)' : shown.tone === 'happy' ? 'var(--success)' : 'var(--text-body)'
              }}
            >
              {shown.text}
              {shown.live && (
                <span className="pending-dots ml-1.5 inline-flex align-middle">
                  <span />
                  <span />
                  <span />
                </span>
              )}
              <span
                className="absolute h-2 w-2 rotate-45"
                style={{
                  left: `calc(50% - ${bubbleShift}px)`,
                  ...(bubbleAbove
                    ? {
                        bottom: -4,
                        background: 'var(--surface-raised)',
                        borderRight: '1px solid var(--border)',
                        borderBottom: '1px solid var(--border)'
                      }
                    : {
                        top: -4,
                        background: 'var(--surface-raised)',
                        borderLeft: '1px solid var(--border)',
                        borderTop: '1px solid var(--border)'
                      })
                }}
              />
            </div>
          </div>
        )}
      </div>

      {menu && (
        <div
          data-pet-menu
          role="menu"
          className="anim-pop fixed z-[90] overflow-hidden rounded-[var(--r-lg)] p-1"
          style={{
            left: menu.x,
            top: menu.y,
            width: MENU_W,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)'
          }}
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">鲸鱼娘</span>
              <span className={busy ? 'badge badge-accent' : 'badge'}>{busy ? '工作中' : '待机中'}</span>
            </div>
            <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
              单击互动 · 右键菜单 · 拖动移动
            </div>
          </div>
          <div className="divider-soft mb-1" />
          <button className={menuItem} onClick={react}>
            摸摸头
          </button>
          <button className={menuItem} onClick={feed}>
            投喂
          </button>
          <div className="divider-soft my-1" />
          <button className={menuItem} onClick={cycleSize}>
            大小 · {size.label}
            <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-hint)' }}>
              切换
            </span>
          </button>
          <button className={menuItem} onClick={resetPosition}>
            回到默认位置
          </button>
          <button className={menuItem} onClick={toggleQuiet}>
            气泡 · {quiet ? '关' : '开'}
          </button>
          <div className="divider-soft my-1" />
          <button className={menuItem} onClick={openSettings}>
            外观设置
          </button>
          <button className={menuItem} style={{ color: 'var(--danger)' }} onClick={hide}>
            隐藏桌宠
          </button>
        </div>
      )}
    </>
  )
}
