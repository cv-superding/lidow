import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import fg from 'fast-glob'
import { createTwoFilesPatch } from 'diff'
import type { ToolDef } from './types'
import { clampOutput, num, str } from './types'

/** 路径安全：强制限制在项目根内，拒绝越界（目录隔离） */
export function safePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：${p} 不在项目目录 ${root} 内`)
  }
  return abs
}

const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'target']

function denyProductDirs(p: string): void {
  // 分隔符同时接受 \ 与 /：Windows 上模型常写 dist/x，只按 sep 切分会漏判
  const parts = p.split(/[\\/]+/).map((seg) => seg.toLowerCase())
  if (parts.some((seg) => EXCLUDED_DIRS.includes(seg))) {
    throw new Error(`目录 ${p} 位于产物目录（${EXCLUDED_DIRS.join('/')}）内，默认禁止写入；如确需修改请让用户调整配置`)
  }
}

export const readTool: ToolDef = {
  name: 'read',
  description: '读取文件内容（文本）。大文件自动截断。',
  parameters: { path: { type: 'string', description: '项目内相对路径', required: true }, offset: { type: 'number', description: '起始行（1 基）' }, limit: { type: 'number', description: '行数上限' } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const abs = safePath(ctx.projectRoot, str(input, 'path'))
    const raw = readFileSync(abs, 'utf-8')
    const lines = raw.split('\n')
    const offset = Math.max(1, num(input, 'offset', 1))
    const limit = num(input, 'limit', 2000)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    return { ok: true, output: clampOutput(numbered, ctx.settings.outputBufferLimit) }
  }
}

export const writeTool: ToolDef = {
  name: 'write',
  description: '写入文件（覆盖）。自动创建父目录。原文件备份进审计以便回滚。',
  parameters: { path: { type: 'string', description: '项目内相对路径', required: true }, content: { type: 'string', description: '完整文件内容', required: true } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const relPath = str(input, 'path')
    const abs = safePath(ctx.projectRoot, relPath)
    denyProductDirs(relPath)
    // 计划/确认模式：改文件前必须经过用户确认（此前只有命令与删除有确认门）
    if (ctx.settings.permissionMode === 'plan' || ctx.settings.permissionMode === 'ask') {
      const ok = await ctx.confirm(`写入文件：${relPath}`)
      if (!ok) return { ok: false, output: '', error: '用户拒绝写入' }
    }
    let oldContent: string | undefined
    let backupPath: string | undefined
    try {
      if (statSync(abs).isFile()) {
        oldContent = readFileSync(abs, 'utf-8')
        backupPath = `${abs}.lidow-bak-${Date.now()}`
        writeFileSync(backupPath, oldContent)
      }
    } catch {
      /* 新文件 / 非文本文件 */
    }
    const content = str(input, 'content')
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    ctx.audit?.('file-write', `写入 ${relPath}`, { path: abs, bytes: content.length }, backupPath)
    // 生成 diff 供 UI 汇总「N 个文件已修改 +X -Y」；新文件即全量新增
    const patch = createTwoFilesPatch('a/' + relPath, 'b/' + relPath, oldContent ?? '', content, undefined, undefined, {
      context: 3
    })
    return {
      ok: true,
      output: `已写入 ${relPath}（${content.length} 字符）`,
      display: { kind: 'diff', path: relPath, patch }
    }
  }
}

/** edit：字符串替换；保留原文件换行风格（CRLF/LF），修复上游已知缺陷 */
export const editTool: ToolDef = {
  name: 'edit',
  description: '精确替换文件中的文本片段。oldText 必须唯一匹配。',
  parameters: { path: { type: 'string', description: '项目内相对路径', required: true }, oldText: { type: 'string', description: '待替换原文（需唯一）', required: true }, newText: { type: 'string', description: '替换为', required: true } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const relPath = str(input, 'path')
    const abs = safePath(ctx.projectRoot, relPath)
    denyProductDirs(relPath)
    if (ctx.settings.permissionMode === 'plan' || ctx.settings.permissionMode === 'ask') {
      const ok = await ctx.confirm(`编辑文件：${relPath}`)
      if (!ok) return { ok: false, output: '', error: '用户拒绝编辑' }
    }
    const raw = readFileSync(abs, 'utf-8')
    const crlf = raw.includes('\r\n')
    const oldText = str(input, 'oldText')
    const newText = str(input, 'newText')
    const normOld = crlf ? oldText.replace(/\r?\n/g, '\r\n') : oldText.replace(/\r?\n/g, '\n')
    const normNew = crlf ? newText.replace(/\r?\n/g, '\r\n') : newText.replace(/\r?\n/g, '\n')
    const count = raw.split(normOld).length - 1
    if (count === 0) {
      return { ok: false, output: '', error: `oldText 在文件中无匹配（注意换行风格为 ${crlf ? 'CRLF' : 'LF'}）` }
    }
    if (count > 1) {
      return { ok: false, output: '', error: `oldText 匹配 ${count} 处，要求唯一；请扩大上下文` }
    }
    const next = raw.replace(normOld, normNew)
    let backupPath: string | undefined
    try {
      backupPath = `${abs}.lidow-bak-${Date.now()}`
      writeFileSync(backupPath, raw)
    } catch {
      /* ignore */
    }
    writeFileSync(abs, next, 'utf-8')
    const patch = createTwoFilesPatch('a/' + relPath, 'b/' + relPath, raw, next, undefined, undefined, { context: 3 })
    ctx.audit?.('file-write', `编辑 ${relPath}`, { path: abs }, backupPath)
    return { ok: true, output: `已编辑 ${relPath}`, display: { kind: 'diff', path: relPath, patch } }
  }
}

export const globTool: ToolDef = {
  name: 'glob',
  description: '按 glob 模式列出文件。默认排除 node_modules/dist 等产物目录。',
  parameters: { pattern: { type: 'string', description: 'glob 模式，如 src/**/*.ts', required: true } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const pattern = str(input, 'pattern')
    const files = await fg(pattern, {
      cwd: ctx.projectRoot,
      ignore: EXCLUDED_DIRS.map((d) => `**/${d}/**`),
      dot: true,
      suppressErrors: true
    })
    const list = files.sort().slice(0, 500)
    return {
      ok: true,
      output: list.join('\n') + (files.length > 500 ? `\n…共 ${files.length} 个，已截断` : ''),
      display: { kind: 'files', pattern, files: list, truncated: files.length > 500 }
    }
  }
}

export const grepTool: ToolDef = {
  name: 'grep',
  description: '在项目内按正则搜索文件内容（纯 Node 实现，无需 ripgrep）。',
  parameters: { pattern: { type: 'string', description: 'JS 正则', required: true }, glob: { type: 'string', description: '文件过滤 glob，默认 **/*' }, maxResults: { type: 'number', description: '上限，默认 100' } },
  dangerLevel: 'safe',
  async run(input, ctx) {
    const pattern = str(input, 'pattern')
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch (e) {
      return { ok: false, output: '', error: `无效正则: ${String(e)}` }
    }
    const globPat = str(input, 'glob') || '**/*'
    const max = num(input, 'maxResults', 100)
    const files = await fg(globPat, { cwd: ctx.projectRoot, ignore: EXCLUDED_DIRS.map((d) => `**/${d}/**`), dot: true, suppressErrors: true, absolute: false })
    const results: string[] = []
    for (const f of files) {
      if (results.length >= max) break
      let content: string
      try {
        const st = statSync(join(ctx.projectRoot, f))
        if (st.size > 2 * 1024 * 1024) continue
        content = readFileSync(join(ctx.projectRoot, f), 'utf-8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          results.push(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
          if (results.length >= max) break
        }
      }
    }
    return { ok: true, output: results.length ? results.join('\n') : '无匹配' }
  }
}

export const deleteFileTool: ToolDef = {
  name: 'deleteFile',
  description: '删除项目内的单个文件或空目录。需确认。非空目录请先逐项删除其中的文件。',
  parameters: { path: { type: 'string', description: '项目内相对路径', required: true } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const relPath = str(input, 'path')
    const abs = safePath(ctx.projectRoot, relPath)
    denyProductDirs(relPath)
    // safePath 对 "." 会放行并返回根目录本身 —— 递归删除会直接清空整个项目
    if (abs === resolve(ctx.projectRoot)) {
      return { ok: false, output: '', error: '拒绝删除项目根目录' }
    }
    let st
    try {
      st = statSync(abs)
    } catch {
      return { ok: false, output: '', error: `路径不存在：${relPath}` }
    }
    const isDir = st.isDirectory()
    if (isDir && readdirSync(abs).length > 0) {
      return { ok: false, output: '', error: `目录非空，拒绝递归删除：${relPath}（请先逐项删除其中的文件）` }
    }
    const ok = await ctx.confirm(`删除${isDir ? '空目录' : '文件'}：${relPath}`)
    if (!ok) return { ok: false, output: '', error: '用户拒绝删除' }
    let backupPath: string | undefined
    if (!isDir) {
      try {
        backupPath = `${abs}.lidow-bak-${Date.now()}`
        writeFileSync(backupPath, readFileSync(abs))
      } catch {
        /* 文件不可读（权限）时仍尝试删除 */
      }
    }
    if (isDir) rmdirSync(abs)
    else unlinkSync(abs)
    ctx.audit?.('file-delete', `删除 ${relPath}`, { path: abs }, backupPath)
    return { ok: true, output: `已删除 ${relPath}` }
  }
}
