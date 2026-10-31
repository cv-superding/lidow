import { describe, expect, it } from 'vitest'
import { judgeCommand, isReadOnly, splitCompound } from '@main/security/commandGuard'

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

describe('rm 检测：误报与间接执行', () => {
  it('文本内容里的 rm 不再误判（回归：echo "rm -rf /" 曾被 blocked）', () => {
    expect(judgeCommand('echo "rm -rf /"').level).toBe('safe')
    expect(judgeCommand('echo rm -rf /').level).toBe('safe')
    expect(judgeCommand('grep -r "rm -rf /" .').level).toBe('safe')
  })

  it('git rm 仍按删除操作确认', () => {
    expect(judgeCommand('git rm -rf x').level).toBe('confirm')
  })

  it('前缀命令的带参选项不干扰命令词识别', () => {
    expect(judgeCommand('sudo -u root rm -rf /').level).toBe('blocked')
    expect(judgeCommand('nice -n 10 rm -rf /').level).toBe('blocked')
    expect(judgeCommand('sudo -n rm -rf /').level).toBe('blocked')
  })

  it('shell -c / xargs / find -exec 会下钻判断', () => {
    expect(judgeCommand('bash -c "rm -rf /"').level).toBe('blocked')
    expect(judgeCommand('xargs rm -rf /').level).toBe('blocked')
    expect(judgeCommand('xargs -0 rm -rf /').level).toBe('blocked')
    expect(judgeCommand('find . -exec rm -rf / \\;').level).toBe('blocked')
  })

  it('timeout 包装的前缀时长不会被当成命令', () => {
    expect(judgeCommand('timeout 5 rm -rf /').level).toBe('blocked')
    expect(judgeCommand('timeout -s KILL 5 rm -rf /').level).toBe('blocked')
  })
})

describe('命令混淆与分隔符绕过', () => {
  it('单个 & 是后台分隔符，不能只检查前半段', () => {
    expect(splitCompound('echo ok & rm -rf /')).toEqual(['echo ok', 'rm -rf /'])
    expect(judgeCommand('echo ok & rm -rf /').level).toBe('blocked')
    expect(isReadOnly('echo ok & rm -rf /')).toBe(false)
  })

  it('重定向里的 & 不拆段', () => {
    expect(splitCompound('npm test 2>&1')).toEqual(['npm test 2>&1'])
  })

  it('命令替换/反引号下钻判断', () => {
    expect(judgeCommand('echo $(rm -rf /)').level).toBe('blocked')
    expect(judgeCommand('echo `rm -rf /`').level).toBe('blocked')
    expect(isReadOnly('echo $(ls)')).toBe(false)
  })

  it('反斜杠与 ${IFS}/$IFS 混淆还原后再判', () => {
    expect(judgeCommand('r\\m -rf /').level).toBe('blocked')
    expect(judgeCommand('rm${IFS}-rf${IFS}/').level).toBe('blocked')
  })

  it('find -delete 需要确认且不算只读', () => {
    expect(judgeCommand('find . -name "*.tmp" -delete').level).toBe('confirm')
    expect(isReadOnly('find . -name "*.tmp" -delete')).toBe(false)
  })
})
