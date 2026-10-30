import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProjectRootAvailable } from '@main/app/projectFs'

describe('项目根目录可用性检测', () => {
  it('存在的文件夹可用', () => {
    const root = mkdtempSync(join(tmpdir(), 'lidow-proj-'))
    try {
      expect(isProjectRootAvailable(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('被删除的文件夹不可用（不能被当作有效项目）', () => {
    const root = mkdtempSync(join(tmpdir(), 'lidow-proj-'))
    rmSync(root, { recursive: true, force: true })
    expect(isProjectRootAvailable(root)).toBe(false)
  })

  it('路径是文件而不是文件夹时不可用', () => {
    const root = mkdtempSync(join(tmpdir(), 'lidow-proj-'))
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x')
    try {
      expect(isProjectRootAvailable(file)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('空值/非法路径不可用且不抛错', () => {
    expect(isProjectRootAvailable('')).toBe(false)
    expect(isProjectRootAvailable(undefined)).toBe(false)
    expect(isProjectRootAvailable(null)).toBe(false)
    expect(isProjectRootAvailable('Z:\\definitely-missing\\lidow-project')).toBe(false)
  })
})

describe('删除项目目录后的主进程保护', () => {
  const context = readFileSync(join(process.cwd(), 'src/main/app/context.ts'), 'utf8')
  const handlers = readFileSync(join(process.cwd(), 'src/main/app/handlers.ts'), 'utf8')
  const views = readFileSync(join(process.cwd(), 'src/renderer/src/components/views.tsx'), 'utf8')

  it('SessionStore 不会为缺失目录建 .lidow（避免把用户删掉的目录复活）', () => {
    expect(context).toContain('isProjectRootAvailable')
    expect(context).toContain('this.sessionStores.delete(projectId)')
    expect(context).toContain('项目目录不存在')
  })

  it('启动时保留缺失项目并给活动项目做有效回退', () => {
    expect(context).toContain('项目目录不存在，保留记录待处理')
    expect(context).toContain('活动项目目录不存在，已切换到')
    expect(context).toContain('projectAvailable(')
  })

  it('会话列表对缺失项目返回空，而不是构造存储', () => {
    expect(handlers).toContain('if (!ctx.projectAvailable(id)) return []')
    expect(handlers).toContain('relocateProject')
  })

  it('工作区显示目录缺失并提供重新选择', () => {
    expect(views).toContain('目录不存在')
    expect(views).toContain('relocateProject')
    expect(views).toContain('重新选择')
  })

  it('移除项目可选同时删除网页版会话，并清理本地会话', () => {
    expect(views).toContain('同时删除网页版 AI 中的')
    expect(views).toContain('api.removeProject(removeTarget.id, removeWebChats)')
    expect(handlers).toContain('removeWebChat')
    expect(context).toContain('deleteLocalSessions')
    expect(context).toContain('projectChatRefs')
  })
})
