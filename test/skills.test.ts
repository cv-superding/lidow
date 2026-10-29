import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, readSkill } from '../src/main/ecosystem/skills'

describe('skills discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'lidow-skills-'))
  const skillsDir = join(root, '.lidow', 'skills')
  const dirSkill = join(skillsDir, 'tdd', 'SKILL.md')
  const flatSkill = join(skillsDir, 'flat.md')

  mkdirSync(join(skillsDir, 'tdd'), { recursive: true })
  writeFileSync(dirSkill, '---\nname: tdd\ndescription: 测试驱动开发\n---\nTDD 正文')
  writeFileSync(flatSkill, '---\nname: flat\ndescription: 扁平技能\n---\nflat body')
  // 分类目录 + 同类 README 不应被当成技能；BOM/块标量 description 要能解析
  mkdirSync(join(skillsDir, 'frontend', 'code-review'), { recursive: true })
  writeFileSync(join(skillsDir, 'frontend', 'README.md'), '# 分类说明')
  writeFileSync(
    join(skillsDir, 'frontend', 'code-review', 'SKILL.md'),
    '\uFEFF---\nname: code-review\ndescription: >\n  审查代码\n  并给出建议\n---\nreview body'
  )

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('扫描 skills/<name>/SKILL.md、平铺 .md 和一层分类目录', () => {
    const projectSkills = listSkills(root).filter((s) => s.scope === 'project')
    expect(projectSkills.map((s) => s.name).sort()).toEqual(['code-review', 'flat', 'tdd'])
    expect(projectSkills.find((s) => s.name === 'tdd')?.description).toBe('测试驱动开发')
    expect(projectSkills.find((s) => s.name === 'code-review')?.description).toBe('审查代码 并给出建议')
    expect(projectSkills.some((s) => s.name === 'README')).toBe(false)
  })

  it('readSkill 可以读取目录技能', () => {
    expect(readSkill(dirSkill, root)).toContain('TDD 正文')
  })

  it('拒绝技能目录之外的文件', () => {
    expect(() => readSkill(join(root, 'outside.md'), root)).toThrow(/不在允许目录/)
  })
})