import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 图片类附件扩展名：附件选择与剪贴板粘贴共用 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

const PASTE_EXTS = new Set(['png', 'jpg', 'gif', 'webp', 'bmp'])
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const KEEP_MS = 10 * 60 * 1000

/**
 * 剪贴板图片 data URL 落盘，返回临时文件路径。
 * 平台复制附件后文件就不再需要，保留 10 分钟避免预览还没读取就被清掉。
 */
export function savePastedImages(images: unknown, dir: string): string[] {
  const list = (Array.isArray(images) ? images : []).slice(0, 16)
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (const raw of list) {
    if (files.length >= 4) break
    const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(raw ?? ''))
    if (!m) continue
    const mime = (m[1] ?? '').toLowerCase()
    const ext = mime === 'jpeg' ? 'jpg' : mime
    if (!PASTE_EXTS.has(ext)) continue
    const buf = Buffer.from(m[2] ?? '', 'base64')
    if (!buf.length) continue
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 12MB')
    const file = join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    writeFileSync(file, buf)
    files.push(file)
    setTimeout(() => {
      try {
        unlinkSync(file)
      } catch {
        /* 已清理 */
      }
    }, KEEP_MS).unref()
  }
  return files
}
