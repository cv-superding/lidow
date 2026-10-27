import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { Logger } from './log'

/**
 * 凭据保险库：Electron safeStorage（OS 级 DPAPI/Keychain）加密落盘。
 * DSH credentials / secretStore 服务的底座；无 safeStorage 时降级明文并告警。
 */
export class CredentialVault {
  private file: string
  private cache = new Map<string, string>()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'credentials.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) this.cache.set(k, v)
    } catch (e) {
      Logger.warn('vault', `凭据文件损坏: ${String(e)}`)
    }
  }

  private save(): void {
    const obj = Object.fromEntries(this.cache)
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
    renameSync(tmp, this.file)
  }

  private encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plain).toString('base64')}`
    }
    Logger.warn('vault', 'safeStorage 不可用，凭据以明文保存（仅本机可读）')
    return `plain:${plain}`
  }

  private decrypt(stored: string): string {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    return stored.slice(6)
  }

  set(key: string, value: string): void {
    this.cache.set(key, this.encrypt(value))
    this.save()
  }

  get(key: string): string | null {
    const stored = this.cache.get(key)
    if (!stored) return null
    try {
      return this.decrypt(stored)
    } catch (e) {
      Logger.warn('vault', `凭据解密失败 ${key}: ${String(e)}`)
      return null
    }
  }

  delete(key: string): boolean {
    const ok = this.cache.delete(key)
    if (ok) this.save()
    return ok
  }

  keys(): string[] {
    return [...this.cache.keys()]
  }
}
