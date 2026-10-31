import { describe, expect, it } from 'vitest'
import { execCommand } from '@main/tools/exec'
import type { ToolContext } from '@main/tools/types'

function ctx(root: string): ToolContext {
  return {
    projectRoot: root,
    settings: {
      commandTimeoutMs: 5_000,
      sandboxTimeoutMs: 60_000,
      outputBufferLimit: 1024 * 1024,
      ssrfProtection: true,
      dangerConfirm: false,
      deleteProtection: true,
      batchDeleteThreshold: 200,
      permissionMode: 'autonomous'
    },
    confirm: async () => true
  }
}

describe('execCommand 超时', () => {
  it(
    '超时后杀掉整棵进程树并 resolve，不因孙进程占用管道而永久挂起',
    async () => {
      const started = Date.now()
      const r = await execCommand('node -e "setInterval(()=>{},1000)"', ctx(process.cwd()))
      expect(r.timedOut).toBe(true)
      expect(r.ok).toBe(false)
      // 5s 超时 + 进程树收尾；必须远小于 vitest 超时
      expect(Date.now() - started).toBeLessThan(12_000)
    },
    20_000
  )
})
