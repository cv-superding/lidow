import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { JsonStore } from '@main/infra/store'
import type { KnowledgeBase, QuickCommand } from '@shared/types'

/**
 * 本地知识库：挂载文档目录（md/txt/json/html），构建倒排索引，
 * AI 通过 kbSearch 工具检索。重建在添加时全量扫描（<10k 文档足够快）。
 */

interface IndexDoc {
  kbId: string
  path: string
  tokens: Map<string, number>
  length: number
}

const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.html', '.htm', '.csv', '.log', '.ts', '.js', '.py', '.rs', '.go', '.java'])

export function tokenize(text: string): string[] {
  // 中英混合分词：连续字母数字为一个词，CJK 逐字 + 双字组合
  const tokens: string[] = []
  const latin = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  tokens.push(...latin)
  const cjk = text.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i]! + cjk[i + 1]!)
  if (cjk.length === 1) tokens.push(cjk[0]!)
  return tokens
}

export class KnowledgeManager {
  private store: JsonStore<{ bases: KnowledgeBase[] }>
  private docs: IndexDoc[] = []

  constructor(userDataDir: string) {
    this.store = new JsonStore<{ bases: KnowledgeBase[] }>(join(userDataDir, 'knowledge.json'), { bases: [] })
    for (const kb of this.store.get().bases) {
      if (kb.enabled) this.rebuild(kb.id, kb.root)
    }
  }

  list(): KnowledgeBase[] {
    return this.store.get().bases
  }

  add(name: string, root: string): KnowledgeBase {
    if (!existsSync(root)) throw new Error(`目录不存在: ${root}`)
    const kb: KnowledgeBase = {
      id: `kb_${nanoid(6)}`,
      name,
      root,
      enabled: true,
      fileCount: 0
    }
    kb.fileCount = this.rebuild(kb.id, root)
    this.store.update((d) => ({ bases: [...d.bases, kb] }))
    return kb
  }

  remove(id: string): void {
    this.docs = this.docs.filter((d) => d.kbId !== id)
    this.store.update((d) => ({ bases: d.bases.filter((b) => b.id !== id) }))
  }

  /** 重建索引（目录内容变化后调用） */
  reindex(id: string): number {
    const kb = this.store.get().bases.find((b) => b.id === id)
    if (!kb) throw new Error(`知识库不存在: ${id}`)
    const count = this.rebuild(id, kb.root)
    this.store.update((d) => ({ bases: d.bases.map((b) => (b.id === id ? { ...b, fileCount: count } : b)) }))
    return count
  }

  private rebuild(kbId: string, root: string): number {
    this.docs = this.docs.filter((d) => d.kbId !== kbId)
    let count = 0
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue
        const full = join(dir, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(full)
        } else if (TEXT_EXTS.has(extname(name).toLowerCase()) && st.size < 1024 * 1024) {
          try {
            const text = readFileSync(full, 'utf-8')
            const tokens = tokenize(text)
            const freq = new Map<string, number>()
            for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
            this.docs.push({ kbId, path: full, tokens: freq, length: tokens.length })
            count++
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    walk(root)
    return count
  }

  /** BM25 简化版评分检索 */
  search(kbId: string, query: string, limit = 5): { path: string; score: number; snippet: string }[] {
    const qTokens = [...new Set(tokenize(query))]
    const pool = this.docs.filter((d) => d.kbId === kbId)
    const N = Math.max(1, pool.length)
    const avgLen = pool.reduce((n, d) => n + d.length, 0) / N
    const df = new Map<string, number>()
    for (const qt of qTokens) {
      df.set(qt, pool.filter((d) => d.tokens.has(qt)).length)
    }
    const scored = pool.map((d) => {
      let score = 0
      for (const qt of qTokens) {
        const f = d.tokens.get(qt) ?? 0
        if (f === 0) continue
        const n = df.get(qt) ?? 0
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        score += idf * ((f * 2.5) / (f + 1.2 * (0.25 + 0.75 * (d.length / Math.max(1, avgLen)))))
      }
      return { d, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ d, score }) => {
        let content = ''
        try {
          content = readFileSync(d.path, 'utf-8')
        } catch {
          /* ignore */
        }
        const hit = content.search(new RegExp(query.split(/\s+/).filter(Boolean).map(escapeRe).join('|'), 'i'))
        const start = Math.max(0, hit - 60)
        return { path: d.path, score: Math.round(score * 100) / 100, snippet: content.slice(start, start + 320).replace(/\s+/g, ' ') }
      })
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 快捷指令存储 */
export class QuickCommandStore {
  private store: JsonStore<{ commands: QuickCommand[] }>

  constructor(userDataDir: string) {
    this.store = new JsonStore<{ commands: QuickCommand[] }>(join(userDataDir, 'quick-commands.json'), { commands: [] })
  }

  list(): QuickCommand[] {
    return this.store.get().commands
  }

  save(cmd: QuickCommand): QuickCommand[] {
    this.store.update((d) => ({
      commands: [...d.commands.filter((c) => c.id !== cmd.id), { ...cmd, id: cmd.id || `qc_${nanoid(6)}` }]
    }))
    return this.list()
  }

  remove(id: string): QuickCommand[] {
    this.store.update((d) => ({ commands: d.commands.filter((c) => c.id !== id) }))
    return this.list()
  }
}
