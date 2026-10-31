/**
 * 危险命令检测：复合命令拆分 + rm 语义解析 + 变体归一化 + 分级
 * 覆盖上游 cuckoo-code 的检测能力，并以纯函数形式便于单测
 */

export type DangerLevel = 'safe' | 'confirm' | 'blocked'

const BLOCK_PATTERNS: RegExp[] = [
  /mkfs(\.\w+)?\s/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /dd\s+.*of=\/dev\/[sh]d[a-z]/,
  /shutdown|reboot|halt\s/,
  />\s*\/dev\/[sh]d[a-z]/
]

const CONFIRM_PATTERNS: RegExp[] = [
  /rmdir\s/,
  /del\s+\/[sqr]/,
  /rd\s+\/s/,
  /format\s/,
  /reg\s+(delete|add)\s/,
  /schtasks\s+\/create/,
  /taskkill\s+\/f/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /npm\s+publish/,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
  /chmod\s+777/,
  /chown\s+-r/,
  /mv\s+\S+\s+\/dev\/null/,
  /truncate\s+-s\s*0/,
  /remove-item\s+.*-recurse/,
  /\bfind\b[^\n]*-delete\b/,
  /\bxargs\b[^\n]*\b(rm|unlink|shred)\b/,
  /\bshred\b/,
  /\bwipefs\b/,
  /\bdiskpart\b/,
  /\bbcdedit\b[^\n]*\/delete/
]

/**
 * 拆分复合命令：&& || ; | & 换行（不考虑引号内的分隔符）。
 * 单个 & 是后台执行分隔符：`echo ok & rm -rf /` 必须拆成两段，
 * 否则危险检测只看 echo、命令却真的删了根目录。
 * `2>&1`、`&>file` 里的 & 属于重定向，不能拆。
 */
export function splitCompound(cmd: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';' || ch === '\n') {
      parts.push(cur)
      cur = ''
      continue
    }
    if (ch === '|') {
      parts.push(cur)
      cur = ''
      if (cmd[i + 1] === '|') i++
      continue
    }
    if (ch === '&') {
      const prev = cmd[i - 1] ?? ''
      const next = cmd[i + 1] ?? ''
      // && 是分隔符；>&、<&、&> 是重定向
      if (next === '&') {
        parts.push(cur)
        cur = ''
        i++
        continue
      }
      if (prev === '>' || prev === '<' || next === '>') {
        cur += ch
        continue
      }
      if (prev === '\\') {
        cur += ch
        continue
      }
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** 归一化：去引号、压空白、小写 */
export function normalizeCmd(cmd: string): string {
  return cmd
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 还原常见 shell 混淆：`r\m` → `rm`，`rm${IFS}-rf` → `rm -rf`。
 * 只用于危险检测，不用于执行。
 */
function deobfuscate(cmd: string): string {
  return cmd
    .replace(/\\([a-z])/gi, '$1')
    .replace(/\$\{IFS\}|\$IFS\b/gi, ' ')
}

/** 提取命令替换 $(...) 与反引号里的内层命令（递归，限深度） */
function commandSubstitutions(cmd: string, depth = 0): string[] {
  const out: string[] = []
  if (depth > 4) return out
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '$' && cmd[i + 1] === '(') {
      let balance = 1
      let j = i + 2
      for (; j < cmd.length && balance > 0; j++) {
        if (cmd[j] === '(') balance++
        else if (cmd[j] === ')') balance--
      }
      const inner = cmd.slice(i + 2, Math.max(i + 2, j - 1)).trim()
      if (inner) {
        out.push(inner)
        out.push(...commandSubstitutions(inner, depth + 1))
      }
      i = j - 1
      continue
    }
    if (cmd[i] === '`') {
      const j = cmd.indexOf('`', i + 1)
      if (j > i) {
        const inner = cmd.slice(i + 1, j).trim()
        if (inner) {
          out.push(inner)
          out.push(...commandSubstitutions(inner, depth + 1))
        }
        i = j
      }
    }
  }
  return out
}

/**
 * rm 语义解析（正则难以兼顾 flag 前置/后置与目标判定，改用 token 分析）：
 * - 只看「实际命令词」：跳过前缀修饰词（sudo/env/nohup/command/time/nice）与环境变量赋值；
 *   命令不是 rm 时，文本里出现的 rm（如 `echo "rm -rf /"`、`grep rm file`）不算删除
 * - 兼容长选项（--recursive --force --no-preserve-root）
 * - 目标为 / ~ $home * .. ./ 或通配符根（/*、~*）且带递归/强制 → blocked
 * - 其余任何 rm → confirm
 */
const RM_PREFIXES = new Set(['sudo', 'env', 'nohup', 'command', 'time', 'nice', 'builtin', 'exec', 'ionice', 'stdbuf', 'doas', 'timeout'])
/** 前缀命令自身的带参选项：`sudo -u root rm …` / `nice -n 10 rm …` 里参数不是命令 */
const PREFIX_ARG_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set(['-f', '--format', '-o', '--output']),
  ionice: new Set(['-c', '-n', '-p', '-u']),
  stdbuf: new Set(['-i', '-o', '-e']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after'])
}
/** 前缀命令的位置参数个数（timeout 的时长在命令之前），跳过后才是真正的命令 */
const PREFIX_POSITIONAL: Record<string, number> = { timeout: 1 }
/** 通过内层字符串执行命令的 shell：`bash -c "rm -rf /"` 必须下钻判断 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])

export function judgeRm(seg: string): 'blocked' | 'confirm' | null {
  const tokens = seg.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  let i = 0
  let lastPrefix = ''
  let pendingPositional = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (RM_PREFIXES.has(t)) {
      lastPrefix = t
      pendingPositional += PREFIX_POSITIONAL[t] ?? 0
      i++
      continue
    }
    if (/^[a-z_][a-z0-9_]*=/i.test(t)) {
      i++
      continue
    }
    if (lastPrefix && PREFIX_ARG_FLAGS[lastPrefix]?.has(t)) {
      i += 2
      continue
    }
    if (pendingPositional > 0) {
      pendingPositional--
      i++
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    break
  }
  const command = tokens[i]
  if (!command) return null

  if (SHELLS.has(command)) {
    const flag = tokens.findIndex((t) => t === '-c' || t === '/c' || t === '-command')
    if (flag < 0) return null
    return judgeRm(tokens.slice(flag + 1).join(' '))
  }

  // git rm 等版本控制删除同样属于删除操作（可回滚，按确认处理）
  if (command === 'git' && tokens[i + 1] === 'rm') return 'confirm'

  // 间接执行：xargs rm / find -exec rm
  let rmIdx = -1
  if (command === 'rm') rmIdx = i
  else if (command === 'xargs') {
    let j = i + 1
    while (j < tokens.length && tokens[j]!.startsWith('-')) j++
    if (tokens[j] === 'rm') rmIdx = j
  } else {
    const execAt = tokens.indexOf('-exec')
    if (execAt >= 0 && tokens[execAt + 1] === 'rm') rmIdx = execAt + 1
  }
  if (rmIdx < 0) return null

  const rest = tokens.slice(rmIdx + 1)
  const flags = rest.filter((t) => t.startsWith('-')).join('')
  const targets = rest.filter((t) => !t.startsWith('-'))
  const recursive = flags.includes('r')
  const force = flags.includes('f')
  const dangerous = targets.some(
    (t) =>
      t === '/' ||
      t === '~' ||
      t === '$home' ||
      t === '*' ||
      t === '..' ||
      t === './' ||
      t.startsWith('/*') || // rm -rf /* 与 rm -rf /*.log 等根目录通配
      t === '~*' ||
      t === '~/' ||
      t === '/**' ||
      t === '$home/*'
  )
  // --no-preserve-root 是强信号：即使没有 -r/-f 也视为最高危
  if (dangerous && (recursive || force || flags.includes('no-preserve-root'))) return 'blocked'
  if (flags.includes('no-preserve-root')) return 'blocked'
  return 'confirm'
}

export interface DangerVerdict {
  level: DangerLevel
  reason?: string
}

/**
 * 判定命令危险级别。
 * 关键点：管道注入（curl|sh）这类跨段模式必须对**完整命令**匹配——
 * splitCompound 会先拆掉 |，仅按段匹配时该类模式永远失效。
 */
export function judgeCommand(cmd: string): DangerVerdict {
  const plain = deobfuscate(cmd)
  const candidates = [
    normalizeCmd(cmd),
    normalizeCmd(plain),
    ...splitCompound(cmd).map(normalizeCmd),
    ...splitCompound(plain).map(normalizeCmd)
  ]

  let confirmed: string | null = null
  for (const seg of candidates) {
    const rm = judgeRm(seg)
    if (rm === 'blocked') return { level: 'blocked', reason: '对根目录/主目录/通配符的递归删除' }
    if (rm === 'confirm' && !confirmed) confirmed = seg
    for (const re of BLOCK_PATTERNS) {
      if (re.test(seg)) return { level: 'blocked', reason: '包含不可撤销的破坏性操作' }
    }
  }
  for (const seg of candidates) {
    for (const re of CONFIRM_PATTERNS) {
      if (re.test(seg)) return { level: 'confirm', reason: `包含需要确认的操作：${seg}` }
    }
  }
  // 命令替换/反引号：内层命令必须按同样的规则判一轮，
  // 否则 `echo $(rm -rf /)` 只看到 echo 会被判成安全。
  let substitutionConfirm: string | null = null
  for (const inner of commandSubstitutions(cmd)) {
    const verdict = judgeCommand(inner)
    if (verdict.level === 'blocked') {
      return { level: 'blocked', reason: `命令替换中包含破坏性操作：${inner}` }
    }
    if (verdict.level === 'confirm' && !substitutionConfirm) substitutionConfirm = inner
  }
  if (substitutionConfirm) {
    return { level: 'confirm', reason: `包含需要确认的命令替换：${substitutionConfirm}` }
  }
  if (confirmed) return { level: 'confirm', reason: `包含删除操作：${confirmed}` }
  return { level: 'safe' }
}

/** 常见安全白名单：只读命令不弹确认 */
const SAFE_PREFIXES = [
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'grep',
  'find',
  'findstr',
  'echo',
  'pwd',
  'cd',
  'node -v',
  'node --version',
  'npm ls',
  'npm -v',
  'npm view',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'python --version',
  'python3 --version',
  'where',
  'which',
  'whoami',
  'date',
  'wc'
]

/** 判定是否只读命令（可跳过确认快速执行）。
 * 含重定向（> 写文件）、管道到非白名单、未知前缀时一律不算只读。 */
export function isReadOnly(cmd: string): boolean {
  // 命令替换/反引号/${IFS}/反斜杠转义会改变真实命令，不能按白名单放行
  if (/\$\(|`|\$\{|\$IFS\b/i.test(cmd)) return false
  if (/\\(?=[a-z])/i.test(cmd)) return false
  const segments = splitCompound(cmd)
  if (segments.length === 0) return false
  return segments.every((seg) => {
    const n = normalizeCmd(seg)
    if (n.includes('>')) return false // 覆盖 > 与 >> 写文件
    if (/\s-delete\b/.test(n) || /\s-exec\b/.test(n)) return false // find 的删除/执行动作
    return SAFE_PREFIXES.some((p) => n === p || n.startsWith(p + ' '))
  })
}
