import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('网页原生「新对话」初始化引导', () => {
  const overlay = readFileSync(join(process.cwd(), 'src/preload/overlay.ts'), 'utf8')
  const manager = readFileSync(join(process.cwd(), 'src/main/bridge/overlayManager.ts'), 'utf8')
  const context = readFileSync(join(process.cwd(), 'src/main/app/context.ts'), 'utf8')
  const types = readFileSync(join(process.cwd(), 'src/shared/types.ts'), 'utf8')

  it('overlay 点击平台新对话后通知主进程并跨重载保留初始化入口', () => {
    expect(overlay).toContain("send({ type: 'native-new-chat' })")
    expect(overlay).toContain('markNativeNewChat()')
    expect(overlay).toContain('isNativeNewChatPending()')
    expect(overlay).toContain('(nativeNewChat || !projectInitialized)')
  })

  it('主进程收到后解绑旧会话，避免新对话消息记到旧会话', () => {
    expect(types).toContain("type: 'native-new-chat'")
    expect(manager).toContain("case 'native-new-chat'")
    expect(context).toContain('handleNativeNewChat')
    expect(context).toContain('this.overlay.unbindSession(sessionId)')
  })
})
