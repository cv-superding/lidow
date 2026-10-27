import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { TaskItem } from '@shared/types'

/**
 * 人机共用待办看板（todo-board 灵感）：
 * AI 经 todoWrite 工具写入，用户在「任务」视图查看/勾选，双向共享同一份 .lidow/todos.json。
 * 文件放在项目内（可版本化、可人工编辑）。
 */
export class TodoBoard {
  constructor(private projectRoot: string) {}

  private get file(): string {
    return join(this.projectRoot, '.lidow', 'todos.json')
  }

  list(): TaskItem[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as TaskItem[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  /** AI 全量替换（todoWrite 语义） */
  replace(items: { title: string; status: TaskItem['status'] }[]): TaskItem[] {
    const now = Date.now()
    const next: TaskItem[] = items.slice(0, 50).map((it) => ({
      id: `td_${nanoid(6)}`,
      title: String(it.title).slice(0, 200),
      detail: '',
      status: it.status,
      createdAt: now
    }))
    this.save(next)
    return next
  }

  setStatus(id: string, status: TaskItem['status']): TaskItem | null {
    const items = this.list()
    const hit = items.find((t) => t.id === id)
    if (!hit) return null
    hit.status = status
    this.save(items)
    return hit
  }

  add(title: string): TaskItem {
    const items = this.list()
    const item: TaskItem = {
      id: `td_${nanoid(6)}`,
      title: title.slice(0, 200),
      detail: '',
      status: 'pending',
      createdAt: Date.now()
    }
    this.save([...items, item])
    return item
  }

  clearDone(): number {
    const items = this.list()
    const rest = items.filter((t) => t.status !== 'done' && t.status !== 'skipped')
    const removed = items.length - rest.length
    this.save(rest)
    return removed
  }

  private save(items: TaskItem[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8')
      renameSync(tmp, this.file)
    } catch {
      /* 只读项目等场景静默 */
    }
  }

  /** 系统提示词注入段：AI 知道当前看板状态 */
  digest(): string {
    const items = this.list()
    if (items.length === 0) return ''
    const icon: Record<TaskItem['status'], string> = {
      pending: '□',
      running: '▶',
      done: '✓',
      failed: '✗',
      skipped: '—'
    }
    return items
      .slice(-20)
      .map((t) => `- ${icon[t.status]} ${t.title}`)
      .join('\n')
  }
}
