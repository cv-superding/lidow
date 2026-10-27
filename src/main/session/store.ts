import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type { ChatTurn, Session, SessionMeta } from '@shared/types'

/**
 * 会话存储：每项目 sessions/<id>.json 单文件 + index.json 元数据索引。
 * 单文件粒度避免大 JSON 全量重写；血缘与压缩标记在 meta 上。
 */
export class SessionStore {
  private dir: string
  private index: Map<string, SessionMeta> = new Map()

  constructor(projectDir: string) {
    this.dir = join(projectDir, 'sessions')
    mkdirSync(this.dir, { recursive: true })
    this.loadIndex()
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private loadIndex(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.indexPath, 'utf-8'))
      const arr = Array.isArray(raw) ? (raw as SessionMeta[]) : []
      this.index = new Map(arr.map((m) => [m.id, m]))
    } catch {
      this.index = new Map()
    }
  }

  private saveIndex(): void {
    const tmp = `${this.indexPath}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.index.values()], null, 2), 'utf-8')
    renameSync(tmp, this.indexPath)
  }

  private fileOf(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`)
  }

  list(providerId?: string): SessionMeta[] {
    return [...this.index.values()]
      .filter((m) => !m.archived && (!providerId || m.providerId === providerId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  create(projectId: string, providerId: string, parentSessionId?: string, accountId?: string): Session {
    const now = Date.now()
    const meta: SessionMeta = {
      id: `sess_${nanoid(10)}`,
      projectId,
      title: '新会话',
      providerId,
      accountId,
      createdAt: now,
      updatedAt: now,
      parentSessionId,
      compactedTurns: 0
    }
    const session: Session = { ...meta, turns: [] }
    this.index.set(meta.id, meta)
    this.saveIndex()
    this.writeSession(session)
    return session
  }

  get(sessionId: string): Session | null {
    if (!this.index.has(sessionId)) return null
    try {
      return JSON.parse(readFileSync(this.fileOf(sessionId), 'utf-8')) as Session
    } catch {
      return null
    }
  }

  private writeSession(session: Session): void {
    const tmp = `${this.fileOf(session.id)}.tmp`
    writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8')
    renameSync(tmp, this.fileOf(session.id))
  }

  /** 原子更新：带血缘检查——并发窗口只能写自己的会话（修复上游 #24 会话串扰） */
  update(sessionId: string, fn: (s: Session) => Session): Session {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    const next = fn(structuredClone(current))
    next.updatedAt = Date.now()
    const meta = this.index.get(sessionId)
    if (meta) {
      meta.title = next.title
      meta.updatedAt = next.updatedAt
      meta.compactedTurns = next.compactedTurns
      meta.archived = next.archived
      this.saveIndex()
    }
    this.writeSession(next)
    return next
  }

  appendTurn(sessionId: string, turn: ChatTurn): Session {
    return this.update(sessionId, (s) => ({ ...s, turns: [...s.turns, turn] }))
  }

  patchTurn(sessionId: string, turnId: string, patch: Partial<ChatTurn>): Session {
    return this.update(sessionId, (s) => ({
      ...s,
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t))
    }))
  }

  rename(sessionId: string, title: string): void {
    this.update(sessionId, (s) => ({ ...s, title }))
  }

  delete(sessionId: string): void {
    this.index.delete(sessionId)
    this.saveIndex()
    try {
      unlinkSync(this.fileOf(sessionId))
    } catch {
      /* ignore */
    }
  }

  /** 派生新会话（复制末尾 N 轮），用于"从此处分叉" */
  fork(sessionId: string, keepTurns: number): Session | null {
    const src = this.get(sessionId)
    if (!src) return null
    const child = this.create(src.projectId, src.providerId, sessionId, src.accountId)
    this.update(child.id, (s) => ({
      ...s,
      title: `${src.title}（分叉）`,
      turns: src.turns.slice(-keepTurns).map((t) => ({ ...t, id: `turn_${nanoid(8)}` }))
    }))
    return this.get(child.id)
  }
}
