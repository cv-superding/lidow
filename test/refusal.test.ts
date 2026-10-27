import { describe, expect, it } from 'vitest'
import { detectRefusal, attemptRewrite, interceptCheck, extractMemoryMarkers } from '@main/security/refusal'

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

describe('interceptCheck（对齐 cuckoo 0.8.18 自定义拦截）', () => {
  it('任意命中即返回该模式', () => {
    expect(interceptCheck('请先提供支付凭证', ['退款', '支付凭证'])).toBe('支付凭证')
  })
  it('无效正则跳过不抛错', () => {
    expect(interceptCheck('hello', ['([bad', 'hello'])).toBe('hello')
  })
  it('不区分大小写', () => {
    expect(interceptCheck('STOP ALL', ['stop all'])).toBe('stop all')
  })
  it('无命中返回 null', () => {
    expect(interceptCheck('正常回复内容', ['拦截词'])).toBeNull()
  })
})

describe('extractMemoryMarkers（对齐 cuckoo 0.8.16 正文标记）', () => {
  it('提取多条 [记忆] 标记', () => {
    const text = '方案完成。\n[记忆] 用户偏好 TypeScript strict\n[记忆]项目用 pnpm'
    expect(extractMemoryMarkers(text)).toEqual(['用户偏好 TypeScript strict', '项目用 pnpm'])
  })
  it('无标记返回空数组', () => {
    expect(extractMemoryMarkers('普通回复')).toEqual([])
  })
})
