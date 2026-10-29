import { describe, expect, it } from 'vitest'
import {
  PET_IDLE_REACTIONS,
  PET_SIZES,
  clampPetPos,
  defaultPetPos,
  idleLine,
  nextPetSize,
  petClip,
  petSizeAt,
  reactionLine,
  workingLine
} from '../src/renderer/src/pet'

describe('桌宠状态逻辑', () => {
  it('交互动作优先于工作态，工作时回落到思考动画', () => {
    expect(petClip('happy', true)).toBe('happy')
    expect(petClip(null, true)).toBe('think')
    expect(petClip(null, false)).toBe('idle')
  })

  it('气泡文案区分思考 / 回复 / 工具执行 / 等待', () => {
    expect(workingLine({ toolBusy: true, thinking: true, writing: false })).toContain('思考')
    expect(workingLine({ toolBusy: true, thinking: false, writing: true })).toContain('回复')
    expect(workingLine({ toolBusy: true, thinking: false, writing: false })).toContain('工具')
    expect(workingLine({ toolBusy: false, thinking: false, writing: false })).toContain('等待')
  })

  it('把宠物限制在窗口内', () => {
    expect(clampPetPos(-30, -20, 220, 148, 1360, 860)).toEqual({ x: 0, y: 0 })
    expect(clampPetPos(9999, 9999, 220, 148, 1360, 860)).toEqual({ x: 1140, y: 712 })
    expect(clampPetPos(120.4, 80.6, 220, 148, 1360, 860)).toEqual({ x: 120, y: 81 })
  })

  it('默认位置给右侧工具栏和底部输入区留出空间', () => {
    expect(defaultPetPos(1360, 860, 220, 148, 340)).toEqual({ x: 780, y: 620 })
    expect(defaultPetPos(1360, 860, 220, 148, 0)).toEqual({ x: 1120, y: 620 })
    expect(defaultPetPos(1360, 860, 220, 148, 0, 150)).toEqual({ x: 1120, y: 562 })
  })

  it('尺寸在 小 / 中 / 大 之间循环，非法索引回落到中号', () => {
    expect(PET_SIZES).toHaveLength(3)
    expect(PET_IDLE_REACTIONS).not.toContain('angry')
    expect(nextPetSize(0)).toBe(1)
    expect(nextPetSize(1)).toBe(2)
    expect(nextPetSize(2)).toBe(0)
    expect(petSizeAt(99).id).toBe('medium')
  })

  it('台词按随机数取值且始终命中候选', () => {
    expect(reactionLine('wave', () => 0)).toBe('在呢在呢～')
    expect(reactionLine('eat', () => 0.99)).toBeTruthy()
    expect(idleLine(() => 0)).toBeTruthy()
  })
})
