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
  /remove-item\s+.*-recurse/
]

/** 拆分复合命令：&& || ; | 换行（不考虑引号内的分隔符） */
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
    if (ch === ';' || ch === '\n' || ch === '|') {
      parts.push(cur)
      cur = ''
      continue
    }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) {
      parts.push(cur)
      cur = ''
      i++
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
 * rm 语义解析（正则难以兼顾 flag 前置/后置与目标判定，改用 token 分析）：
 * - `rm` 可出现在任意位置，且跳过前缀修饰词（sudo/env/nohup/command/time/nice）
 * - 兼容长选项（--recursive --force --no-preserve-root）
 * - 目标为 / ~ $home * .. ./ 或通配符根（/*、~*）且带递归/强制 → blocked
 * - 其余任何 rm → confirm
 */
export function judgeRm(seg: string): 'blocked' | 'confirm' | null {
  const tokens = seg.split(/\s+/)
  const idx = tokens.indexOf('rm')
  if (idx === -1) return null
  const rest = tokens.slice(idx + 1)
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
  const candidates = [normalizeCmd(cmd), ...splitCompound(cmd).map(normalizeCmd)]

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
  const segments = splitCompound(cmd)
  if (segments.length === 0) return false
  return segments.every((seg) => {
    const n = normalizeCmd(seg)
    if (n.includes('>')) return false // 覆盖 > 与 >> 写文件
    return SAFE_PREFIXES.some((p) => n === p || n.startsWith(p + ' '))
  })
}
