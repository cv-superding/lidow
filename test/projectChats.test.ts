import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectChatIndex } from '@main/session/projectChats'

describe('项目网页对话索引', () => {
  it('按 URL 去重、持久化并支持移除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lidow-chats-'))
    try {
      const idx = new ProjectChatIndex(dir)
      idx.upsert('p1', {
        sessionId: 's1',
        providerId: 'deepseek',
        url: 'https://chat.deepseek.com/a/chat/s/one',
        title: '旧标题',
        updatedAt: 1
      })
      idx.upsert('p1', {
        sessionId: 's1',
        providerId: 'deepseek',
        url: 'https://chat.deepseek.com/a/chat/s/one',
        title: '新标题',
        updatedAt: 2
      })
      expect(idx.count('p1')).toBe(1)
      expect(idx.list('p1')[0]!.title).toBe('新标题')

      // 重新构造 = 从磁盘读回
      const reloaded = new ProjectChatIndex(dir)
      expect(reloaded.count('p1')).toBe(1)
      reloaded.upsert('p1', {
        sessionId: 's2',
        providerId: 'deepseek',
        url: 'https://chat.deepseek.com/a/chat/s/two',
        title: '第二条',
        updatedAt: 3
      })
      expect(reloaded.count('p1')).toBe(2)

      reloaded.removeByUrl('https://chat.deepseek.com/a/chat/s/one')
      expect(reloaded.count('p1')).toBe(1)
      reloaded.removeProject('p1')
      expect(reloaded.count('p1')).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('合并本地会话时保留索引里的旧对话（目录删除后仍能清理）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lidow-chats-'))
    try {
      const idx = new ProjectChatIndex(dir)
      idx.upsert('p1', {
        sessionId: 'old',
        providerId: 'deepseek',
        url: 'https://chat.deepseek.com/a/chat/s/old',
        title: '目录删除前的对话',
        updatedAt: 1
      })
      idx.mergeProject('p1', [
        {
          sessionId: 'new',
          providerId: 'deepseek',
          url: 'https://chat.deepseek.com/a/chat/s/new',
          title: '当前会话',
          updatedAt: 2
        }
      ])
      expect(idx.count('p1')).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
