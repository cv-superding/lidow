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

const WRITE_PREFIX = /^(insert|update|delete|drop|alter|create|truncate|rename|replace|grant|revoke|call)\b/i

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
    if (sql.includes(';')) return { ok: false, output: '', error: '仅允许单条 SQL（检测到多个分号）' }
    const maxRows = typeof input.maxRows === 'number' ? input.maxRows : 50

    const isWrite = WRITE_PREFIX.test(sql)
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
