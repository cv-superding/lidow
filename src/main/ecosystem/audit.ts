import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { JsonStore } from '@main/infra/store'
import type { AuditEntry } from '@shared/types'

/**
 * 执行审计：所有文件写入/删除/命令执行留痕；
 * 文件类操作带 .lidow-bak-* 备份路径，支持单步回滚。
 */
export class AuditLedger {
  private store: JsonStore<{ entries: AuditEntry[] }>

  constructor(userDataDir: string) {
    this.store = new JsonStore<{ entries: AuditEntry[] }>(join(userDataDir, 'audit.json'), { entries: [] })
    mkdirSync(join(userDataDir, 'backups'), { recursive: true })
  }

  record(
    sessionId: string,
    kind: AuditEntry['kind'],
    summary: string,
    detail: Record<string, unknown> = {},
    backupPath?: string
  ): AuditEntry {
    const entry: AuditEntry = {
      id: `aud_${nanoid(8)}`,
      ts: Date.now(),
      sessionId,
      kind,
      summary: summary.slice(0, 200),
      detail,
      backupPath,
      reverted: false
    }
    this.store.update((d) => ({ entries: [entry, ...d.entries].slice(0, 2000) }))
    return entry
  }

  list(sessionId?: string, limit = 200): AuditEntry[] {
    return this.store
      .get()
      .entries.filter((e) => !sessionId || e.sessionId === sessionId)
      .slice(0, limit)
  }

  /** 单步回滚：用备份覆盖原文件。删除类操作恢复原内容。 */
  revert(entryId: string): boolean {
    const entry = this.store.get().entries.find((e) => e.id === entryId)
    if (!entry?.backupPath || entry.reverted) return false
    if (!existsSync(entry.backupPath)) return false
    const target = String(entry.detail.path ?? '')
    if (!target) return false
    try {
      copyFileSync(entry.backupPath, target)
      entry.reverted = true
      this.store.update((d) => ({ entries: d.entries.map((e) => (e.id === entryId ? entry : e)) }))
      return true
    } catch {
      return false
    }
  }

  /** 会话血缘摘要（用于系统提示词：AI 知道自己最近动过什么） */
  recentDigest(sessionId: string, limit = 10): string {
    const items = this.list(sessionId, limit)
    if (items.length === 0) return ''
    return items.map((e) => `- [${e.kind}] ${e.summary}${e.reverted ? '（已回滚）' : ''}`).join('\n')
  }
}

/** 项目模板库落盘 */
export function writeTemplateProject(root: string, templateId: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'LIDOW.md'), `# ${templateId}\n\n由 Lidow 项目模板初始化。\n`, 'utf-8')
}
