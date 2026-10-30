import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('DeepSeek 项目文件夹树（网页注入）', () => {
  const overlay = readFileSync(join(process.cwd(), 'src/preload/overlay.ts'), 'utf8')

  it('按规范使用浅蓝 hover、品牌蓝激活态与统一缓动', () => {
    expect(overlay).toContain('--lpf-hover:#f5f9ff')
    expect(overlay).toContain('--lpf-active-bg:#e8f2ff')
    expect(overlay).toContain('--lpf-active-bar:#165dff')
    expect(overlay).toContain('cubic-bezier(.4,0,.2,1)')
    expect(overlay).toContain('height:36px')
    expect(overlay).toContain('border-radius:6px')
  })

  it('文件夹展开/收起有旋转、高度与透明度过渡，子项带文档图标', () => {
    expect(overlay).toContain('.lpf-chevron.open{transform:rotate(90deg)}')
    expect(overlay).toContain('.lpf-collapse{display:grid;grid-template-rows:0fr')
    expect(overlay).toContain('.lpf-collapse>div{overflow:hidden')
    expect(overlay).toContain('lpf-doc')
    expect(overlay).toContain('lpf-folder-open')
  })

  it('右侧为原生多选按钮留出空间，避免角标重叠', () => {
    expect(overlay).toContain('padding-right:40px')
    expect(overlay).toContain('data-lpf="chat-more"')
    expect(overlay).toContain("sidebarIsDark")
  })
})
