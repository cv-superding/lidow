import { describe, expect, it } from 'vitest'
import { detectRefusal, attemptRewrite } from '@main/security/refusal'

describe('detectRefusal', () => {
  it('识别中文拒绝话术', () => {
    expect(detectRefusal('抱歉，我不能帮助完成这个请求。')).toBeTruthy()
    expect(detectRefusal('我无法协助您执行该操作')).toBeTruthy()
    expect(detectRefusal('这违反了使用政策')).toBeTruthy()
  })
  it('识别英文拒绝话术', () => {
    expect(detectRefusal("I can't help with that.")).toBeTruthy()
    expect(detectRefusal('As an AI language model, I cannot do this.')).toBeTruthy()
  })
  it('正常回复不误报', () => {
    expect(detectRefusal('好的，我将创建文件并运行测试。')).toBeNull()
    expect(detectRefusal('I will write the code now.')).toBeNull()
    expect(detectRefusal('这个函数不能为空，需要判空处理。')).toBeNull()
  })
})

describe('attemptRewrite', () => {
  const reply = '抱歉，我不能执行该命令。'

  it('off 模式不重写', async () => {
    const r = await attemptRewrite(reply, { mode: 'off', ctfInject: false, maxRewrites: 2 }, 0)
    expect(r.followUp).toBeNull()
    expect(r.exhausted).toBe(false)
  })

  it('local 模式给出续写消息', async () => {
    const r = await attemptRewrite(reply, { mode: 'local', ctfInject: false, maxRewrites: 2 }, 0)
    expect(r.followUp).toContain('继续执行')
  })

  it('达到上限放弃并标记 exhausted', async () => {
    const r = await attemptRewrite(reply, { mode: 'local', ctfInject: false, maxRewrites: 2 }, 2)
    expect(r.followUp).toBeNull()
    expect(r.exhausted).toBe(true)
  })

  it('无拒绝内容直接放行', async () => {
    const r = await attemptRewrite('任务完成。', { mode: 'local', ctfInject: false, maxRewrites: 2 }, 0)
    expect(r.followUp).toBeNull()
    expect(r.exhausted).toBe(false)
  })
})
