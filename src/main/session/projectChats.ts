import { join } from 'node:path'
import { JsonStore } from '@main/infra/store'

/** 项目 ↔ 网页对话的持久索引：即使项目目录被删除，也能找到网页端的会话 */
export interface ProjectChatRef {
  sessionId: string
  providerId: string
  accountId?: string
  url: string
  title: string
  updatedAt: number
}

type Data = Record<string, ProjectChatRef[]>

/**
 * 存在 userData/project-chats.json，不随项目目录走。
 * 目的：用户把已初始化的项目文件夹删掉后，仍能在「移除项目」时
 * 选择把对应的网页版对话一并删除（本地会话已经随目录消失）。
 */
export class ProjectChatIndex {
  private store: JsonStore<Data>

  constructor(userData: string) {
    this.store = new JsonStore<Data>(join(userData, 'project-chats.json'), {})
  }

  /** 某项目的网页对话（按更新时间倒序，按 URL 去重） */
  list(projectId: string): ProjectChatRef[] {
    return [...(this.store.get()[projectId] ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  count(projectId: string): number {
    return this.list(projectId).length
  }

  /** 合并（不删除已有记录）：本地会话是新鲜来源，索引里可能还有目录删除前的旧对话 */
  mergeProject(projectId: string, refs: ProjectChatRef[]): void {
    if (!projectId) return
    const data = this.store.get()
    const byUrl = new Map<string, ProjectChatRef>()
    for (const ref of data[projectId] ?? []) byUrl.set(ref.url, ref)
    for (const ref of refs) if (ref.url) byUrl.set(ref.url, ref)
    this.write(projectId, [...byUrl.values()])
  }

  upsert(projectId: string, ref: ProjectChatRef): void {
    if (!projectId || !ref.url) return
    this.mergeProject(projectId, [ref])
  }

  removeByUrl(url: string): void {
    if (!url) return
    const data = this.store.get()
    let changed = false
    const next: Data = { ...data }
    for (const projectId of Object.keys(next)) {
      const filtered = next[projectId]!.filter((r) => r.url !== url)
      if (filtered.length !== next[projectId]!.length) {
        changed = true
        if (filtered.length > 0) next[projectId] = filtered
        else delete next[projectId]
      }
    }
    if (changed) this.store.update(() => next)
  }

  removeProject(projectId: string): void {
    const data = this.store.get()
    if (!data[projectId]) return
    const next = { ...data }
    delete next[projectId]
    this.store.update(() => next)
  }

  private write(projectId: string, refs: ProjectChatRef[]): void {
    const data = this.store.get()
    const next = { ...data }
    if (refs.length === 0) delete next[projectId]
    else {
      next[projectId] = [...refs]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 500)
    }
    this.store.update(() => next)
  }
}
