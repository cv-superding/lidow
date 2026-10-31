import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from './types'
import { str } from './types'

interface MysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

const WRITE_PREFIX = /^(insert|update|delete|drop|alter|create|truncate|rename|replace|grant|revoke|call|merge|load|lock|handler)\b/i

/** 去掉前导注释/空白：块注释或行注释开头曾能绕过写操作确认 */
function stripLeadingComments(sql: string): string {
  let out = sql.trim()
  for (;;) {
    const next = out
      .replace(/^\/\*[\s\S]*?\*\//, '')
      .replace(/^(?:--|#)[^\n]*(\n|$)/, '')
      .trim()
    if (next === out) return out
    out = next
  }
}

/** 分号是否只出现在字符串/注释内部（INSERT ('a;b') 不能误判为多语句） */
function hasMultipleStatements(sql: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      if (ch === '\\' && quote !== '`') {
        i++
        continue
      }
      if (ch === quote) {
        if (sql[i + 1] === quote && quote !== '`') {
          i++
          continue
        }
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      if (end < 0) return false
      i = end
      continue
    }
    if (ch === '#') {
      const end = sql.indexOf('\n', i + 1)
      if (end < 0) return false
      i = end
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return false
      i = end + 1
      continue
    }
    if (ch === ';') return true
  }
  return false
}

function loadConfig(projectRoot: string): MysqlConfig {
  const cfgPath = join(projectRoot, '.lidow', 'mysql.json')
  if (!existsSync(cfgPath)) {
    throw new Error(`缺少连接配置：请在项目 .lidow/mysql.json 写入 {"host","port","user","password","database"}（该文件勿提交到仓库）`)
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Partial<MysqlConfig>
  if (!cfg.host || !cfg.user || !cfg.database) throw new Error('mysql.json 缺少 host/user/database 必填字段')
  return {
    host: cfg.host,
    port: cfg.port ?? 3306,
    user: cfg.user,
    password: cfg.password ?? '',
    database: cfg.database
  }
}

/** mysql 工具：查询渲染表格卡片；写操作强制确认门 */
export const mysqlTool: ToolDef = {
  name: 'mysql',
  description: '执行 MySQL 查询。连接配置在项目 .lidow/mysql.json；写操作（INSERT/UPDATE/DDL 等）需用户确认。',
  parameters: {
    sql: { type: 'string', description: 'SQL 语句（单条）', required: true },
    maxRows: { type: 'number', description: '返回行数上限，默认 50' }
  },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const sql = str(input, 'sql').trim().replace(/;\s*$/, '')
    // 只看字符串/注释外的分号，避免把 INSERT ('a;b') 误判成多语句
    if (hasMultipleStatements(sql))
      return { ok: false, output: '', error: '仅允许单条 SQL（检测到多个分号）' }
    const maxRows = Math.max(1, Math.min(1000, Number(input.maxRows) || 50))

    const bare = stripLeadingComments(sql)
    // WITH … DELETE 这类 CTE 写操作不以写关键字开头，也要走确认门。
    // /*!50000 DROP ... */ 是 MySQL 的「可执行注释」，stripLeadingComments 会把它
    // 整段剥掉，必须单独识别为写操作。
    const isWrite =
      sql.includes('/*!') ||
      WRITE_PREFIX.test(bare) ||
      (/^with\b/i.test(bare) && /\b(insert|update|delete|replace|merge)\b/i.test(bare)) ||
      /\binto\s+(outfile|dumpfile)\b/i.test(bare) ||
      /\bfor\s+update\b/i.test(bare) ||
      /\block\s+in\s+share\s+mode\b/i.test(bare)
    if (isWrite) {
      const ok = await ctx.confirm(`执行写操作 SQL：${sql.slice(0, 160)}`)
      if (!ok) return { ok: false, output: '', error: '用户拒绝执行该写操作' }
    }

    let cfg: MysqlConfig
    try {
      cfg = loadConfig(ctx.projectRoot)
    } catch (e) {
      return { ok: false, output: '', error: String(e instanceof Error ? e.message : e) }
    }

    const mysql = await import('mysql2/promise')
    const conn = await mysql.createConnection({ ...cfg, connectTimeout: 8000 })
    try {
      const [result] = await conn.query(sql)
      if (Array.isArray(result)) {
        const rows = result as Record<string, unknown>[]
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
        const shown = rows.slice(0, maxRows)
        const table = [columns.join(' | '), ...shown.map((r) => columns.map((c) => String(r[c] ?? 'NULL')).join(' | '))].join('\n')
        return {
          ok: true,
          output: `查询返回 ${rows.length} 行${rows.length > maxRows ? `（显示前 ${maxRows} 行）` : ''}：\n${table}`,
          display: {
            kind: 'table',
            columns: columns.length ? columns : ['(空结果)'],
            rows: shown.map((r) => columns.map((c) => String(r[c] ?? 'NULL'))),
            rowCount: rows.length
          }
        }
      }
      const info = result as { affectedRows?: number; insertId?: number; changedRows?: number }
      const text = `执行成功：affectedRows=${info.affectedRows ?? 0}${info.insertId ? ` insertId=${info.insertId}` : ''}${info.changedRows !== undefined ? ` changedRows=${info.changedRows}` : ''}`
      return { ok: true, output: text, display: { kind: 'text', text } }
    } catch (e) {
      return { ok: false, output: '', error: `SQL 执行失败: ${String(e instanceof Error ? e.message : e)}` }
    } finally {
      await conn.end()
    }
  }
}
