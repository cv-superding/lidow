import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 原子写 JSON 存储（临时文件 + rename），避免写入中断损坏数据 */
export class JsonStore<T extends object> {
  private data: T
  private flushing = false

  constructor(
    private readonly filePath: string,
    private readonly defaults: T
  ) {
    this.data = this.load()
  }

  get(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch }
    this.flush()
    return this.data
  }

  update(fn: (prev: T) => T): T {
    this.data = fn(this.data)
    this.flush()
    return this.data
  }

  load(): T {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as T
        return { ...structuredClone(this.defaults), ...raw }
      }
    } catch (err) {
      // 损坏文件不覆盖原文件，进入默认值并保留损坏副本供用户排查
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.warn('[lidow:store] corrupted store, backed up:', String(err))
    }
    return structuredClone(this.defaults)
  }

  flush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } finally {
      this.flushing = false
    }
  }
}

export function userDataDir(): string {
  // 在 app ready 前由 bootstrap 注入真实路径，此处延迟解析
  return join(process.env.LIDOW_USER_DATA ?? '.')
}
