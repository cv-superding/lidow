import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 中断 → 重试 的行为验证。
 *
 * 之前的问题：`net-error` / `net-response(status:'error')` 只记录到 `ch.netError`
 * 就 break，等待方永远收不到信号 → 要么挂到 10 分钟超时，要么被 DOM 兜底
 * 把半截文本当成"完整回复"，重试引擎一次都不会被触发。
 *
 * 这两条路径耦合了 Electron 的 webContents，无法在单测里实例化，
 * 因此改为对源码做结构断言：确保 error 分支确实会唤醒等待方。
 * 纯粹的"逻辑是否会跑"由 loop 侧的重试单测覆盖（resilience.test.ts）。
 */
describe('overlayManager 中断信号', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/bridge/overlayManager.ts'), 'utf8')

  it('net-response 的 error 分支必须调用等待方（不能只记 netError 就 break）', () => {
    // 截取该 case 的分支体
    const start = src.indexOf("if (payload.status === 'error')")
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 900)
    expect(body).toContain('replyResolvers')
    expect(body).toContain('new Error')
  })

  it('net-error 分支同样要唤醒等待方', () => {
    const start = src.indexOf("case 'net-error'")
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 700)
    expect(body).toContain('replyResolvers')
    expect(body).toContain('new Error')
  })

  it('等待方支持 Error 与文本两种结果', () => {
    expect(src).toContain('(text: string | Error)')
    expect(src).toContain('text instanceof Error')
  })

  it('提供 abandonReply 供看门狗判死后清理悬挂等待', () => {
    expect(src).toContain('abandonReply(')
    const start = src.indexOf('abandonReply(')
    const body = src.slice(start, start + 400)
    expect(body).toContain('replyResolvers.clear()')
  })
})

describe('长任务不能静默停止', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/bridge/loop.ts'), 'utf8')

  it('轮数上限足够长，到达上限时请求结构化收尾摘要', () => {
    // 回归：MAX_TURNS=40 时 for 循环跑完直接返回，用户看到 AI 停在半截、无任何通知
    expect(src).toContain('const MAX_TURNS = 200')
    expect(src).toContain('wrapUpWithSummary')
    expect(src).toContain('WRAP_UP_PROMPT')
    expect(src).toContain("end === 'limit'")
  })

  it('AI 收尾失败时回退本地摘要（已完成 / 未解决 / 说明）', () => {
    expect(src).toContain('appendLocalSummary')
    expect(src).toContain('buildLocalProgressSummary')
    expect(src).toContain('## 已完成')
    expect(src).toContain('## 未解决')
  })

  it('异常中断也附带本地进度摘要，用户能看到做到哪了', () => {
    expect(src).toContain('buildLocalProgressSummary(sessionId, msg)')
  })
})

describe('网页仍在生成时不得插入重试消息', () => {
  const overlaySrc = readFileSync(join(process.cwd(), 'src/main/bridge/overlayManager.ts'), 'utf8')
  const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/overlay.ts'), 'utf8')
  const loopSrc = readFileSync(join(process.cwd(), 'src/main/bridge/loop.ts'), 'utf8')

  it('截断/空回复先等页面收尾（宽限计时），不立即唤醒重试', () => {
    expect(overlaySrc).toContain('ERROR_GRACE_MS')
    expect(overlaySrc).toContain('armErrorGrace')
    expect(overlaySrc).toContain('rearmErrorGrace')
    expect(overlaySrc).toContain('isSoftStreamError')
    // DOM 结束后以页面文本为准
    expect(overlaySrc).toContain('clearErrorGrace(ch)')
  })

  it('发送前等页面停止生成，避免“中途插话”', () => {
    expect(preloadSrc).toContain('页面仍在生成回复，已暂缓发送')
  })

  it('长思考期间发心跳，看门狗不会把“正在生成”误判成卡死', () => {
    expect(preloadSrc).toContain("type: 'stream-heartbeat'")
    expect(overlaySrc).toContain("case 'stream-heartbeat'")
    expect(overlaySrc).toContain('this.rearmErrorGrace(ch)')
  })

  it('用户在网页侧主动停止生成时，不得自动重试插话', () => {
    expect(overlaySrc).toContain('用户在网页侧停止了生成')
    expect(overlaySrc).toContain('lidowStopped')
    expect(loopSrc).toContain("msg.includes('用户在网页侧停止了生成')")
  })

  it('多阶段回答的最终一段不能被 8 秒去重规则吞掉', () => {
    expect(overlaySrc).toContain('lastResolvedText')
    expect(overlaySrc).toContain('!sameReply(ch.lastResolvedText, payload.text)')
    expect(overlaySrc).not.toContain('Date.now() - (ch.lastResolveAt ?? 0) > 8_000')
  })

  it('重启/重载后能从页面快照补齐最终回答，并修正思考片段', () => {
    expect(preloadSrc).toContain('page-snapshot')
    expect(preloadSrc).toContain('schedulePageSnapshot')
    expect(overlaySrc).toContain('page-snapshot')
    expect(loopSrc).toContain('syncExternalReply')
    expect(loopSrc).toContain('忽略被当成回复的思考片段')
    expect(loopSrc).toContain('最终回答替换思考/前半段')
  })

  it('网页侧用户消息与纯文本回复都同步进会话转录', () => {
    expect(preloadSrc).toContain("type: 'user-message'")
    expect(preloadSrc).toContain('markOutgoing(text)')
    expect(preloadSrc).toContain('isOutgoing')
    expect(loopSrc).toContain('网页输入框里直接提问')
    expect(loopSrc).toContain('lastAssistant.text.trim() === clean')
  })
})

describe('loop 的看门狗必须能判死本轮', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/bridge/loop.ts'), 'utf8')

  it('达到催继续上限时 reject，而不是只发通知就返回', () => {
    const start = src.indexOf('看门狗已达上限')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 600)
    expect(body).toContain('failWatchdog')
    expect(body).toContain('new Error')
  })

  it('判死信号与正常回复竞速', () => {
    expect(src).toContain('Promise.race([chunkPromise, watchdogPromise])')
  })

  it('finally 里清理悬挂等待，避免下一轮报「已有等待中的回复请求」', () => {
    expect(src).toContain('abandonReply?.')
  })

  it('格式纠偏有次数上限且回到用户原始任务', () => {
    expect(src).toContain('MAX_WILD_HINTS')
    expect(src).toContain('FORMAT_FIX_PROMPT')
  })

  it('发送类失败重发任务原文，而不是把催促语当新对话第一句', () => {
    // 回归：页面未就绪/填不进输入框时，重试必须用 originalPrompt
    // （此前一律发 retryCfg.prompt ——「刚才的回复似乎中断了…」成了新对话开场白）
    expect(src).toContain('let originalPrompt = prompt')
    const start = src.indexOf('const isSendFailure')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 320)
    expect(body).toContain('cur === originalPrompt')
    expect(body).toContain('originalPrompt')
    expect(body).toContain('retryPrompt ?? retryCfg.prompt')
    // 上下文耗尽续接后，交接提示要更新为新的「任务原文」
    expect(src).toContain('originalPrompt = cur')
  })

  it('自动压缩在任务收尾触发（进行中调用只会被 running 守卫推迟）', () => {
    // 回归：maybeCompact 原挂在每轮末尾 —— running 恒真 → 永远延后 → 死功能。
    // 自动续接会把任务迁到新会话，因此收尾压缩按 state.sessionId 触发。
    const finallyParts = src.split('finally {')
    const withCompact = finallyParts.filter((x) => x.includes('maybeCompact(state.sessionId)'))
    expect(withCompact.length).toBeGreaterThanOrEqual(2)
  })

  it('系统提示词默认只在初始化/首轮注入，重复注入由设置开关控制', () => {
    // 回归：此前每轮都前置完整系统提示词，网页对话里刷屏并浪费上下文
    expect(src).toContain('injectSystemPromptEveryTurn')
    expect(src).toContain('promptSentBefore')
    expect(src).toContain('repeatPrompt || !promptSentBefore')
    expect(src).toContain('systemPromptSent: true')
  })

  it('自动续接必须走 createSession 依赖（routed store 没有 create）', () => {
    // 回归：deps.store 是按会话路由的门面，只有 get/appendTurn/patch/update。
    // 之前直接调 store.create → “this.deps.store.create is not a function”，
    // 压缩成功后任务仍然终止（实测）。
    expect(src).toContain('this.deps.createSession(')
    expect(src).not.toMatch(/this\.deps\.store\.create\(/)
    expect(src).toContain('interface LoopSessionStore')
  })
})

describe('输入框填入必须严格校验（防消息被截断）', () => {
  const src = readFileSync(join(process.cwd(), 'src/preload/overlay.ts'), 'utf8')

  it('不再用「90% 长度」当通过标准', () => {
    const start = src.indexOf('function fillVerified')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 1200)
    expect(body).not.toContain('0.9')
    // 严格相等 + 去空白比对
    expect(body).toContain('current === text')
    expect(body).toContain('compact(current) === want')
  })
})
