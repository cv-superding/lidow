import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('纯模式文件/图片上传', () => {
  const handlers = readFileSync(join(process.cwd(), 'src/main/app/handlers.ts'), 'utf8')
  const ipc = readFileSync(join(process.cwd(), 'src/shared/ipc.ts'), 'utf8')
  const chat = readFileSync(join(process.cwd(), 'src/renderer/src/components/ChatPanel.tsx'), 'utf8')

  it('通过 CDP 把本机文件写入网页 file input（图片/文档通用）', () => {
    expect(handlers).toContain("R('uploadWebFile'")
    expect(handlers).toContain('DOM.setFileInputFiles')
    expect(handlers).toContain("'multiSelections'")
    expect(handlers).toContain("name: '图片'")
    expect(ipc).toContain('uploadWebFile')
  })

  it('纯模式附件按钮走本机文件选择，而不是只点隐藏 input', () => {
    expect(chat).toContain('.uploadWebFile(')
    expect(chat).toContain('uploadWebFile')
  })
})
