import { spawn } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { isReadOnly, judgeCommand } from '@main/security/commandGuard'
import { isPathInside } from '@shared/path'
import type { ToolDef, ToolContext } from './types'
import { clampOutput, str } from './types'

export interface ExecResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  durationMs: number
  /** 实际执行目录（审计/终端卡片展示用） */
  cwd?: string
}

const OUTPUT_HARD_CAP = 512 * 1024 // 512KB 硬上限，防止命令输出撑爆内存

/** 查找可用的 Git Bash：优先常见安装位置，跳过 System32/WindowsApps 里的 WSL 启动器 */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash'
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined
  ].filter((v): v is string => Boolean(v))
  for (const root of roots) {
    for (const rel of [
      ['Git', 'bin', 'bash.exe'],
      ['Git', 'usr', 'bin', 'bash.exe']
    ]) {
      const p = join(root, ...rel)
      if (existsSync(p)) return p
    }
  }
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    if (/\\Windows\\(System32|SysWOW64)$/i.test(dir) || /WindowsApps$/i.test(dir)) continue
    const p = join(dir, 'bash.exe')
    if (existsSync(p)) return p
  }
  return null
}

/** 只有找到真正的 bash 才用 Unix 语义；否则退回 PowerShell（避免 WSL 启动器或 cmd 误跑） */
function shellFor(
  shellKind: 'bash' | 'pwsh' | 'auto',
  isWin: boolean
): { file: string; args: (cmd: string) => string[] } {
  const powershell = (): { file: string; args: (cmd: string) => string[] } => ({
    file: isWin ? 'powershell.exe' : 'pwsh',
    // 中文 Windows 的 PowerShell 默认按 GBK/OEM 输出，Node 按 UTF-8 解码会整段乱码
    // （用户反馈：命令错误信息全是 ◆◆◆）。Windows 上先把控制台输出编码固定为 UTF-8；
    // 错误记录/中文提示/原生命令输出都按 UTF-8 回传。
    args: (cmd) =>
      isWin
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ' +
              cmd
          ]
        : ['-NoProfile', '-NonInteractive', '-Command', cmd]
  })
  if (shellKind === 'pwsh') return powershell()
  if (!isWin) return { file: 'bash', args: (cmd) => ['-c', cmd] }
  const bash = findBash()
  if (bash) return { file: bash, args: (cmd) => ['-c', cmd] }
  return powershell()
}

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
  // 权限模式分流（对齐 ZCode 四档）：
  //  plan/ask      → 非只读命令一律确认
  //  autonomous    → 只在检测器判定有风险时确认（默认）
  //  full          → 只读与常规命令直接跑，风险命令仍确认（blocked 已在上面拦掉）
  // dangerConfirm 是「危险命令需确认」总开关：关掉后风险命令不再弹窗。
  // 此前把 `dangerConfirm && 非只读` 也并进 autonomous，导致 npm test / git add
  // 这类常规命令也弹确认，与「只在有风险时问」的语义相反。
  const mode = ctx.settings.permissionMode ?? 'autonomous'
  const needsConfirm =
    mode === 'plan' || mode === 'ask' ? !readonly : verdict.level === 'confirm' && ctx.settings.dangerConfirm
  if (needsConfirm) {
    // 确认框必须始终带上具体命令：只显示「包含需要确认的操作：xxx」时
    // 用户根本不知道要执行什么（实测出现空白「执行命令：」的困惑）。
    const detail = verdict.reason
      ? `${verdict.reason}\n\n$ ${cmd}`
      : `执行命令：\n\n$ ${cmd}`
    const ok = await ctx.confirm(detail)
    if (!ok) return { ok: false, exitCode: null, output: '用户拒绝执行该命令', timedOut: false, durationMs: 0 }
  }

  const cwd = opts.cwd && (isAbsolute(opts.cwd) ? resolve(opts.cwd) : resolve(ctx.projectRoot, opts.cwd))
  if (cwd && !isPathInside(ctx.projectRoot, cwd)) {
    return { ok: false, exitCode: null, output: `cwd 越界：仅允许项目目录内`, timedOut: false, durationMs: 0 }
  }
  const workdir = cwd && existsSync(cwd) ? cwd : ctx.projectRoot

  const shellKind = opts.shell ?? 'auto'
  const isWin = process.platform === 'win32'
  const picked = shellFor(shellKind, isWin)
  const file = picked.file
  const args = picked.args(cmd)

  const started = Date.now()
  return new Promise<ExecResult>((resolveP) => {
    if (ctx.signal?.aborted) {
      resolveP({ ok: false, exitCode: null, output: '用户中止了命令', timedOut: false, durationMs: 0, cwd: workdir })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: workdir,
        windowsHide: true,
        env: { ...process.env },
        // POSIX 下建独立进程组，超时/停止时能连同子进程一起杀掉
        detached: process.platform !== 'win32'
      })
    } catch (e) {
      resolveP({
        ok: false,
        exitCode: null,
        output: `启动失败: ${String(e)}`,
        timedOut: false,
        durationMs: Date.now() - started,
        cwd: workdir
      })
      return
    }
    let out = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const limit = Math.min(ctx.settings.outputBufferLimit, OUTPUT_HARD_CAP)
    const push = (chunk: Buffer): void => {
      if (out.length < OUTPUT_HARD_CAP) out += chunk.toString('utf-8')
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killFallback) clearTimeout(killFallback)
      ctx.signal?.removeEventListener('abort', onAbort)
      const trimmed = clampOutput(out, limit)
      const suffix = timedOut
        ? `\n[lidow] 命令超时（${Math.round(ctx.settings.commandTimeoutMs / 1000)}s）已终止`
        : aborted
          ? '\n[lidow] 用户中止了命令'
          : ''
      resolveP({
        ok: !timedOut && !aborted && (code === 0 || code === null),
        exitCode: code,
        output: trimmed + suffix,
        timedOut,
        durationMs: Date.now() - started,
        cwd: workdir
      })
    }

    /**
     * 只杀 shell 不够：npm/vite 等会派生子进程，子进程继承 stdout 管道后
     * 'close' 永远不触发，工具会一直卡到应用退出。这里杀整棵进程树，
     * 并设兜底：管道销毁 + 按当前输出结束本轮。
     */
    let killFallback: NodeJS.Timeout | null = null
    const killTree = (): void => {
      const pid = child.pid
      if (pid) {
        if (process.platform === 'win32') {
          try {
            const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore'
            })
            killer.on('error', () => undefined)
            killer.unref()
          } catch {
            /* ignore */
          }
        } else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (!killFallback) {
        killFallback = setTimeout(() => {
          killFallback = null
          try {
            child.stdout?.destroy()
            child.stderr?.destroy()
          } catch {
            /* ignore */
          }
          finish(child.exitCode ?? null)
        }, 3000)
        killFallback.unref?.()
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, Math.max(5_000, ctx.settings.commandTimeoutMs))

    // 「停止工具」：杀掉进程树并让上层把本轮标记为已取消
    const onAbort = (): void => {
      aborted = true
      killTree()
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })

    // 进程退出但管道被孙进程占用时 close 不会来：exit 后短暂等待输出排空即收尾
    child.on('exit', (code) => {
      if (settled) return
      setTimeout(() => {
        if (settled) return
        try {
          child.stdout?.destroy()
          child.stderr?.destroy()
        } catch {
          /* ignore */
        }
        finish(code)
      }, 800).unref?.()
    })
    child.on('close', finish)
    child.on('error', (err) => {
      out += `\n[lidow] 启动失败: ${String(err)}`
      finish(-1)
    })
  })
}

export const bashTool: ToolDef = {
  name: 'bash',
  description: '在项目目录执行 shell 命令（Windows 优先 Git Bash，未安装时退回 PowerShell）。危险命令需用户确认。',
  parameters: { command: { type: 'string', description: '完整命令', required: true }, cwd: { type: 'string', description: '相对项目根的工作目录' } },
  dangerLevel: 'confirm',
  async run(input, ctx) {
    const cmd = str(input, 'command')
    const r = await execCommand(cmd, ctx, { shell: 'auto', cwd: str(input, 'cwd') || undefined })
    const cwd = r.cwd ?? ctx.projectRoot
    ctx.audit?.('command', cmd.slice(0, 120), { cmd, exitCode: r.exitCode, cwd })
    return {
      ok: r.ok,
      output: `[exit ${r.exitCode ?? 'null'}] ${r.output}`,
      display: { kind: 'terminal', cmd, cwd, exitCode: r.exitCode, output: r.output },
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
    const cwd = r.cwd ?? ctx.projectRoot
    ctx.audit?.('command', cmd.slice(0, 120), { cmd, exitCode: r.exitCode, cwd })
    return {
      ok: r.ok,
      output: `[exit ${r.exitCode ?? 'null'}] ${r.output}`,
      display: { kind: 'terminal', cmd, cwd, exitCode: r.exitCode, output: r.output },
      error: r.timedOut ? 'timeout' : undefined
    }
  }
}
