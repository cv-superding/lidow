import { spawn } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { isReadOnly, judgeCommand } from '@main/security/commandGuard'
import type { ToolDef, ToolContext } from './types'
import { clampOutput, str } from './types'

export interface ExecResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  durationMs: number
}

const OUTPUT_HARD_CAP = 512 * 1024 // 512KB 硬上限，防止命令输出撑爆内存

/** 执行 shell 命令：安全门 + 双超时 + 输出限制。bash 走 Git Bash/cmd 兜底，pwsh 走 PowerShell */
export async function execCommand(
  cmd: string,
  ctx: ToolContext,
  opts: { shell?: 'bash' | 'pwsh' | 'auto'; cwd?: string } = {}
): Promise<ExecResult> {
  const verdict = judgeCommand(cmd)
  if (verdict.level === 'blocked') {
    return { ok: false, exitCode: null, output: `已拦截：${verdict.reason}`, timedOut: false, durationMs: 0 }
  }
  const readonly = isReadOnly(cmd)
  if (verdict.level === 'confirm' || (ctx.settings.dangerConfirm && !readonly)) {
    // 确认框必须始终带上具体命令：只显示「包含需要确认的操作：xxx」时
    // 用户根本不知道要执行什么（实测出现空白「执行命令：」的困惑）。
    const detail = verdict.reason
      ? `${verdict.reason}\n\n$ ${cmd}`
      : `执行命令：\n\n$ ${cmd}`
    const ok = await ctx.confirm(detail)
    if (!ok) return { ok: false, exitCode: null, output: '用户拒绝执行该命令', timedOut: false, durationMs: 0 }
  }

  const cwd = opts.cwd && (isAbsolute(opts.cwd) ? resolve(opts.cwd) : resolve(ctx.projectRoot, opts.cwd))
  if (cwd && !cwd.startsWith(resolve(ctx.projectRoot))) {
    return { ok: false, exitCode: null, output: `cwd 越界：仅允许项目目录内`, timedOut: false, durationMs: 0 }
  }
  const workdir = cwd && existsSync(cwd) ? cwd : ctx.projectRoot

  const shellKind = opts.shell ?? 'auto'
  const isWin = process.platform === 'win32'
  let file: string
  let args: string[]
  if (shellKind === 'pwsh' || (isWin && shellKind === 'auto')) {
    file = isWin ? 'powershell.exe' : 'pwsh'
    args = ['-NoProfile', '-NonInteractive', '-Command', cmd]
  } else {
    file = isWin ? 'bash.exe' : 'bash'
    args = ['-c', cmd]
    if (isWin && !isOnPath(file)) {
      file = 'cmd.exe'
      args = ['/d', '/s', '/c', cmd]
    }
  }

  const started = Date.now()
  return new Promise<ExecResult>((resolveP) => {
    const child = spawn(file, args, { cwd: workdir, windowsHide: true, env: { ...process.env } })
    let out = ''
    let timedOut = false
    let settled = false

    const limit = Math.min(ctx.settings.outputBufferLimit, OUTPUT_HARD_CAP)
    const push = (chunk: Buffer): void => {
      if (out.length < OUTPUT_HARD_CAP) out += chunk.toString('utf-8')
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, Math.max(5_000, ctx.settings.commandTimeoutMs))

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const trimmed = clampOutput(out, limit)
      resolveP({
        ok: !timedOut && (code === 0 || code === null),
        exitCode: code,
        output: trimmed + (timedOut ? `\n[lidow] 命令超时（${Math.round(ctx.settings.commandTimeoutMs / 1000)}s）已终止` : ''),
        timedOut,
        durationMs: Date.now() - started
      })
    }
    child.on('close', finish)
    child.on('error', (err) => {
      out += `\n[lidow] 启动失败: ${String(err)}`
      finish(-1)
    })
  })
}

function isOnPath(file: string): boolean {
  const pathEnv = process.env.PATH ?? ''
  return pathEnv
    .split(/[;:]/)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, `${file}`)) || existsSync(join(dir, `${file}.exe`)))
}

export const bashTool: ToolDef = {
  name: 'bash',
  description: '在项目目录执行 shell 命令（Windows 下自动选择 bash/powershell）。危险命令需用户确认。',
  parameters: { command: { type: 'string', description: '完整命令', required: true }, cwd: { type: 'string', description: '相对项目根的工作目录' } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const cmd = str(input, 'command')
    const r = await execCommand(cmd, ctx, { shell: 'auto', cwd: str(input, 'cwd') || undefined })
    ctx.audit?.('command', cmd.slice(0, 120), { cmd, exitCode: r.exitCode, cwd: ctx.projectRoot })
    return {
      ok: r.ok,
      output: `[exit ${r.exitCode ?? 'null'}] ${r.output}`,
      display: { kind: 'terminal', cmd, cwd: ctx.projectRoot, exitCode: r.exitCode, output: r.output },
      error: r.timedOut ? 'timeout' : undefined
    }
  }
}

export const pwshTool: ToolDef = {
  name: 'pwsh',
  description: '强制用 PowerShell 执行命令（Windows 管理任务）。',
  parameters: { command: { type: 'string', description: 'PowerShell 命令', required: true } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const cmd = str(input, 'command')
    const r = await execCommand(cmd, ctx, { shell: 'pwsh' })
    ctx.audit?.('command', cmd.slice(0, 120), { cmd, exitCode: r.exitCode })
    return {
      ok: r.ok,
      output: `[exit ${r.exitCode ?? 'null'}] ${r.output}`,
      display: { kind: 'terminal', cmd, cwd: ctx.projectRoot, exitCode: r.exitCode, output: r.output },
      error: r.timedOut ? 'timeout' : undefined
    }
  }
}
