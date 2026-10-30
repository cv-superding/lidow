import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePastedImages } from '@main/app/pasteImages'

describe('剪贴板图片落盘', () => {
  it('png/jpeg data URL 写入临时文件并保留扩展名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lidow-paste-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
      const files = savePastedImages([`data:image/png;base64,${png}`, `data:image/jpeg;base64,${jpg}`], dir)
      expect(files).toHaveLength(2)
      expect(files[0]!.endsWith('.png')).toBe(true)
      expect(files[1]!.endsWith('.jpg')).toBe(true)
      expect(readFileSync(files[0]!)[0]).toBe(0x89)
      expect(readFileSync(files[1]!)[0]).toBe(0xff)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('忽略非图片数据，且最多附加 4 张', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lidow-paste-'))
    try {
      const png = Buffer.from([1, 2, 3]).toString('base64')
      const files = savePastedImages(
        [
          'data:text/plain;base64,aGk=',
          `data:image/svg+xml;base64,${png}`,
          'not-a-data-url',
          ...Array.from({ length: 6 }, () => `data:image/png;base64,${png}`)
        ],
        dir
      )
      expect(files).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
