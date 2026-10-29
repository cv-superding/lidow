import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteFileTool, writeTool } from '@main/tools/fs'
import type { ToolContext } from '@main/tools/types'

function makeCtx(root: string, approve = true): ToolContext {
  return {
    projectRoot: root,
    settings: {
      commandTimeoutMs: 30_000,
      sandboxTimeoutMs: 60_000,
      outputBufferLimit: 1024 * 1024,
      ssrfProtection: true,
      dangerConfirm: true,
      permissionMode: 'autonomous'
    },
    confirm: async () => approve
  }
}

describe('deleteFile 安全边界', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lidow-fs-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('拒绝删除项目根目录（path = "."）', async () => {
    const root = tmp()
    writeFileSync(join(root, 'keep.txt'), 'x')
    const r = await deleteFileTool.run({ path: '.' }, makeCtx(root))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('项目根目录')
    expect(existsSync(join(root, 'keep.txt'))).toBe(true)
  })

  it('拒绝递归删除非空目录', async () => {
    const root = tmp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'a')
    const r = await deleteFileTool.run({ path: 'sub' }, makeCtx(root))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('非空')
    expect(existsSync(join(root, 'sub', 'a.txt'))).toBe(true)
  })

  it('用户拒绝时不删除文件', async () => {
    const root = tmp()
    writeFileSync(join(root, 'a.txt'), 'hello')
    const r = await deleteFileTool.run({ path: 'a.txt' }, makeCtx(root, false))
    expect(r.ok).toBe(false)
    expect(existsSync(join(root, 'a.txt'))).toBe(true)
  })

  it('删除文件时写入备份', async () => {
    const root = tmp()
    writeFileSync(join(root, 'a.txt'), 'hello')
    const r = await deleteFileTool.run({ path: 'a.txt' }, makeCtx(root))
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
    expect(readdirSync(root).filter((f) => f.includes('.lidow-bak-')).length).toBe(1)
  })

  it('允许删除空目录', async () => {
    const root = tmp()
    mkdirSync(join(root, 'empty'))
    const r = await deleteFileTool.run({ path: 'empty' }, makeCtx(root))
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, 'empty'))).toBe(false)
  })

  it('越界路径被拒绝（抛错由上层转成失败结果）', async () => {
    const root = tmp()
    await expect(deleteFileTool.run({ path: '../outside.txt' }, makeCtx(root))).rejects.toThrow('越界')
  })

  it('产物目录下的文件禁止删除（正斜杠写法同样命中）', async () => {
    const root = tmp()
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'x.js'), 'x')
    await expect(deleteFileTool.run({ path: 'dist/x.js' }, makeCtx(root))).rejects.toThrow('产物目录')
  })

  it('write 生成 diff，供 UI 汇总文件变更行数', async () => {
    const root = tmp()
    await writeTool.run({ path: 'a.txt', content: 'old line\nkeep\n' }, makeCtx(root))
    const r = await writeTool.run({ path: 'a.txt', content: 'new line\nkeep\nextra\n' }, makeCtx(root))
    expect(r.ok).toBe(true)
    expect(r.display?.kind).toBe('diff')
    if (r.display?.kind === 'diff') {
      expect(r.display.path).toBe('a.txt')
      expect(r.display.patch).toContain('+new line')
      expect(r.display.patch).toContain('-old line')
    }
  })
})
