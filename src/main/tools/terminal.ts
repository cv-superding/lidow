import { spawn } from 'node:child_process'

export interface TerminalResult {
  output: string
  exitCode: number | null
  timedOut: boolean
}

const OUTPUT_CAP = 256 * 1024

/**
 * 用户手动执行的终端命令（内置终端面板用）。
 *
 * 与 tools/exec.ts 的区别：那条路径是「AI 提议 → 用户确认 → 执行」，
 * 这里是人自己在终端里敲命令，本来就是他本人的意图，所以不再弹确认门；
 * 但仍然限制 cwd 在项目内，并设硬超时防止卡死。
 *
 * Windows 编码：PowerShell 输出到管道时默认用系统 ANSI 代码页（936），
 * 中文会变成乱码。这里在命令开头注入 UTF-8 设置，并用 -OutputFormat Text
 * 保证编码走控制台代码页；spawn 侧再按 utf8 解码。
 */
export function runTerminal(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number } = {}
): Promise<TerminalResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  if (!command.trim()) return Promise.resolve({ output: '', exitCode: null, timedOut: false })

  const isWin = process.platform === 'win32'
  let file: string
  let args: string[]

  if (isWin) {
    // 先把控制台输入/输出代码页切成 UTF-8，再执行用户命令，
    // 否则中文路径/文件名会显示成「锟斤拷」或 ???。
    const wrapped =
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
      '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
      '$PSStyle.OutputRendering = "PlainText"; ' +
      command
    file = 'powershell.exe'
    args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', wrapped]
  } else {
    file = 'bash'
    args = ['-lc', command]
  }

  return new Promise<TerminalResult>((done) => {
    let out = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { cwd, windowsHide: true, env: { ...process.env } })
    } catch (e) {
      done({ output: String(e instanceof Error ? e.message : e), exitCode: null, timedOut: false })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)

    const append = (buf: Buffer): void => {
      if (out.length >= OUTPUT_CAP) return
      out += buf.toString('utf8')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    child.on('error', (e) => {
      clearTimeout(timer)
      done({ output: out + `\n${String(e.message)}`, exitCode: null, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const truncated = out.length >= OUTPUT_CAP ? '\n…（输出已截断）' : ''
      done({ output: out.slice(0, OUTPUT_CAP) + truncated, exitCode: code, timedOut })
    })
  })
}
