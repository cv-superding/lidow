import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('纯模式右上角工具条', () => {
  const title = readFileSync(join(process.cwd(), 'src/renderer/src/components/TitleBar.tsx'), 'utf8')
  const dock = readFileSync(join(process.cwd(), 'src/renderer/src/components/RightDock.tsx'), 'utf8')
  const store = readFileSync(join(process.cwd(), 'src/renderer/src/store.ts'), 'utf8')

  it('快捷操作是独立浮层，不再打开右侧栏 launcher 面板', () => {
    expect(title).toContain('quickOpen')
    expect(title).toContain('快捷操作')
    expect(title).toContain('openAux(lastPanelRef.current)')
    expect(title).not.toContain("openAux('launcher')")
    expect(store).not.toContain("'launcher'")
    expect(dock).not.toContain('LauncherPanel')
  })

  it('侧栏开关记住上次面板，按钮高亮只看各自状态', () => {
    expect(title).toContain('lastPanelRef')
    expect(title).toContain('auxPanel ? active : idle')
    expect(title).toContain('quickOpen ? active : idle')
  })
})
