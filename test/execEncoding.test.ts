import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { execCommand } from '@main/tools/exec'
import type { ToolContext } from '@main/tools/types'

function ctx(): ToolContext {
  return {
    projectRoot: tmpdir(),
    settings: {
      commandTimeoutMs: 15_000,
      sandboxTimeoutMs: 5_000,
      outputBufferLimit: 100_000,
      ssrfProtection: false,
      dangerConfirm: false,
      deleteProtection: false,
      batchDeleteThreshold: 10,
      permissionMode: 'full'
    },
    confirm: async () => true
  }
}

describe.skipIf(process.platform !== 'win32')('Windows 命令输出编码', () => {
  it('PowerShell 中文输出按 UTF-8 返回，不出现乱码', async () => {
    const r = await execCommand('Write-Output "中文测试-OK"', ctx(), { shell: 'pwsh' })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('中文测试-OK')
  })
})
