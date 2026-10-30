import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('网页回复快照清洗', () => {
  const overlay = readFileSync(join(process.cwd(), 'src/preload/overlay.ts'), 'utf8')

  it('剔除“已思考（用时 N 秒）”折叠条，避免答非前缀导致整段重复追加', () => {
    expect(overlay).toContain('cleanRenderedText')
    expect(overlay).toContain('已(?:深度)?思考')
  })
})
