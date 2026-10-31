import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
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
      if (!Array.isArray(raw)) throw new Error('index.json 不是数组')
      const arr = raw as SessionMeta[]
      this.index = new Map(arr.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]))
      // 回填：早期版本的 update() 只把 title/时间写进索引，providerUrl 只落在会话文件里。
      // 不回填的话老会话切回来时永远找不到导航目标（表现为「切回旧会话上下文是空的」）。
      let repaired = false
      for (const [id, meta] of this.index) {
        if (meta.providerUrl !== undefined) continue
        try {
          const s = JSON.parse(readFileSync(this.fileOf(id), 'utf-8')) as Session
          if (s.providerUrl) {
            meta.providerUrl = s.providerUrl
            repaired = true
          }
        } catch {
          /* 会话文件缺失/损坏：跳过 */
        }
      }
      if (repaired) this.saveIndex()
    } catch (e) {
      // 新项目还没有 index.json：正常空索引，不需要告警/重建
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.index = new Map()
        return
      }
      // 索引损坏时绝不能直接清空：会话文件还在，必须重建索引，
      // 否则下次 saveIndex 会把只含新会话的索引写回去，旧会话永久消失。
      try {
        renameSync(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`)
      } catch {
        /* 文件不可移动 */
      }
      this.index = new Map()
      this.rebuildIndexFromFiles()
      console.warn('[lidow:session] index.json 损坏，已从会话文件重建:', String(e))
    }
  }

  /** Session → 索引元数据（只剔除 turns，避免漏同步字段） */
  private static metaOf(s: Session): SessionMeta {
    return {
      id: s.id,
      projectId: s.projectId,
      title: s.title,
      providerId: s.providerId,
      accountId: s.accountId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      parentSessionId: s.parentSessionId,
      compactedTurns: s.compactedTurns,
      systemPromptSent: s.systemPromptSent,
      archived: s.archived,
      // 写空串而不是 undefined：JSON 会丢 undefined，启动回填逻辑会为每个
      // 没有网页地址的会话重读整份历史文件（大会话启动明显变慢）
      providerUrl: s.providerUrl ?? '',
      titleLocked: s.titleLocked
    }
  }

  /** 从 sessions/*.json 重建内存索引（跳过 index.json 自身） */
  private rebuildIndexFromFiles(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue
      try {
        const s = JSON.parse(readFileSync(join(this.dir, file), 'utf-8')) as Session
        if (!s || typeof s.id !== 'string') continue
        this.index.set(s.id, SessionStore.metaOf(s))
      } catch {
        /* 损坏的会话文件跳过 */
      }
    }
    if (this.index.size > 0) this.saveIndex()
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
      compactedTurns: 0,
      systemPromptSent: false
    }
    const session: Session = { ...meta, turns: [] }
    // 先落会话文件再写索引：写文件失败时不要留下指向空会话的索引项
    this.writeSession(session)
    this.index.set(meta.id, meta)
    this.saveIndex()
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

  /** 索引里的会话元数据（不读整份会话文件，供按会话解析所属项目等热路径） */
  meta(sessionId: string): SessionMeta | undefined {
    return this.index.get(sessionId)
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
    // 先写会话文件，再整体同步索引：漏字段（如 accountId）会让网页监听/分区
    // 在重启后按旧账号去错位置；写文件失败时索引也保持旧值。
    this.writeSession(next)
    this.index.set(sessionId, SessionStore.metaOf(next))
    this.saveIndex()
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
    this.update(sessionId, (s) => ({ ...s, title, titleLocked: true }))
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
