import { describe, expect, it } from 'vitest'
import { judgeCommand, isReadOnly } from '@main/security/commandGuard'

describe('commandGuard 增强（对齐上游 cuckoo 0.8.15）', () => {
  it('通配符根目录 rm -rf /* 阻断', () => {
    expect(judgeCommand('rm -rf /*').level).toBe('blocked')
    expect(judgeCommand('rm -rf /*.log').level).toBe('blocked')
  })
  it('长选项 --recursive --force 阻断', () => {
    expect(judgeCommand('rm --recursive --force /').level).toBe('blocked')
    expect(judgeCommand('rm --recursive --force ~').level).toBe('blocked')
  })
  it('--no-preserve-root 单独出现也最高危', () => {
    expect(judgeCommand('rm / --no-preserve-root').level).toBe('blocked')
  })
  it('前缀修饰词不绕过（sudo/env/nohup/command/time/nice）', () => {
    for (const p of ['sudo', 'env', 'nohup', 'command', 'time', 'nice']) {
      expect(judgeCommand(`${p} rm -rf /`).level, p).toBe('blocked')
    }
  })
  it('长选项删除普通目录仅确认', () => {
    expect(judgeCommand('rm --recursive ./build-cache').level).toBe('confirm')
  })
  it('白名单不受影响', () => {
    expect(isReadOnly('ls -la')).toBe(true)
    expect(judgeCommand('git status').level).toBe('safe')
  })
})
