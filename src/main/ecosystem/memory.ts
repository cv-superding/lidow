import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { JsonStore } from '@main/infra/store'
import type { MemoryEntry } from '@shared/types'

/** 用户记忆：跨会话/跨项目长期记忆，remember / forgetMemory 工具落点 */
export class MemoryStore {
  private store: JsonStore<{ entries: MemoryEntry[] }>

  constructor(userDataDir: string) {
    this.store = new JsonStore<{ entries: MemoryEntry[] }>(join(userDataDir, 'memory.json'), { entries: [] })
  }

  list(): MemoryEntry[] {
    return this.store.get().entries
  }

  add(title: string, content: string, tags: string[], source: MemoryEntry['source'] = 'ai'): MemoryEntry {
    const now = Date.now()
    const entry: MemoryEntry = {
      id: `mem_${nanoid(8)}`,
      title: title.slice(0, 80),
      content: content.slice(0, 4000),
      tags: tags.slice(0, 8),
      createdAt: now,
      updatedAt: now,
      source
    }
    this.store.update((d) => ({ entries: [entry, ...d.entries] }))
    return entry
  }

  remove(id: string): boolean {
    const before = this.list().length
    this.store.update((d) => ({ entries: d.entries.filter((e) => e.id !== id) }))
    return this.list().length < before
  }

  /** 注入系统提示词的记忆段 */
  digest(limit = 30): string {
    const entries = this.list().slice(0, limit)
    if (entries.length === 0) return ''
    return entries.map((e) => `- [${e.tags.join(',') || '无标签'}] ${e.title}: ${e.content.slice(0, 160)}`).join('\n')
  }
}
