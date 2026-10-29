/** 鲸鱼娘桌宠的纯状态逻辑：尺寸、位置、动作与台词。组件外置便于单测。 */

export const PET_BASE_W = 220
export const PET_BASE_H = 148

export const PET_SIZES = [
  { id: 'small', label: '小', scale: 0.82 },
  { id: 'medium', label: '中', scale: 1 },
  { id: 'large', label: '大', scale: 1.16 }
] as const

export type PetSizeId = (typeof PET_SIZES)[number]['id']

export type PetClip = 'idle' | 'think' | 'wave' | 'happy' | 'shy' | 'angry' | 'eat'
export type PetReaction = Exclude<PetClip, 'idle' | 'think'>

export const PET_REACTIONS: readonly PetReaction[] = ['wave', 'happy', 'shy', 'angry', 'eat']
/** 空闲自动动作不主动生气，避免没被招惹却摆臭脸 */
export const PET_IDLE_REACTIONS: readonly PetReaction[] = ['wave', 'happy', 'shy', 'eat']

const REACTION_LINES: Record<PetReaction, readonly string[]> = {
  wave: ['在呢在呢～', '需要我做什么？'],
  happy: ['嘿嘿，被摸头了', '今天也要加油！', '漂亮，又搞定一件！'],
  shy: ['诶…别突然戳我啦', '讨厌～'],
  angry: ['哼，再戳就生气了！', '工作的时候不要打扰我哦'],
  eat: ['谢谢投喂！', '吃饱才有力气干活～']
}

const IDLE_LINES = [
  '今天也要加油呀～',
  '写代码记得起来走走。',
  '我在这儿，需要就叫我。',
  '要不要喝口水？',
  '这个项目看起来很有意思。'
]

export function reactionLine(reaction: PetReaction, rand: () => number = Math.random): string {
  const lines = REACTION_LINES[reaction]
  return lines[Math.floor(rand() * lines.length)] ?? lines[0]!
}

export function idleLine(rand: () => number = Math.random): string {
  return IDLE_LINES[Math.floor(rand() * IDLE_LINES.length)] ?? IDLE_LINES[0]!
}

export function petClip(reaction: PetReaction | null, busy: boolean): PetClip {
  if (reaction) return reaction
  return busy ? 'think' : 'idle'
}

export function workingLine(state: { toolBusy: boolean; thinking: boolean; writing: boolean }): string {
  if (state.thinking) return '正在思考…'
  if (state.writing) return '正在回复…'
  if (state.toolBusy) return '正在调用本地工具…'
  return '等待回复…'
}

export function clampPetPos(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number
): { x: number; y: number } {
  const maxX = Math.max(0, vw - w)
  const maxY = Math.max(0, vh - h)
  return {
    x: Math.max(0, Math.min(maxX, Math.round(x))),
    y: Math.max(0, Math.min(maxY, Math.round(y)))
  }
}

/** 默认落在右下角、右侧工具侧栏之外，并给底部输入框留出空间。 */
export function defaultPetPos(
  vw: number,
  vh: number,
  w: number,
  h: number,
  rightInset = 0,
  bottomInset = 92
): { x: number; y: number } {
  return clampPetPos(
    vw - w - 20 - Math.max(0, rightInset),
    vh - h - Math.max(0, bottomInset),
    w,
    h,
    vw,
    vh
  )
}

export function nextPetSize(index: number): number {
  return (index + 1) % PET_SIZES.length
}

export function petSizeAt(index: number): (typeof PET_SIZES)[number] {
  return PET_SIZES[index] ?? PET_SIZES[1]
}
