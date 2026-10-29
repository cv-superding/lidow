import { afterAll, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  createSkill,
  importExternalSkills,
  listExternalSkills,
  listSkillTrash,
  listSkills,
  purgeSkillTrash,
  readSkill,
  restoreSkillTrash,
  setSkillEnabled,
  skillsDigest,
  trashSkill,
  updateSkill
} from '../src/main/ecosystem/skills'

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
  mkdirSync(join(skillsDir, 'block'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'block', 'SKILL.md'),
    '---\nname: block-scalar\ndescription: >-\n  block description\n  on two lines\n---\nbody'
  )

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('扫描 skills/<name>/SKILL.md、平铺 .md 和一层分类目录', () => {
    const projectSkills = listSkills(root).filter((s) => s.scope === 'project')
    expect(projectSkills.map((s) => s.name).sort()).toEqual(['block-scalar', 'code-review', 'flat', 'tdd'])
    expect(projectSkills.find((s) => s.name === 'tdd')?.description).toBe('测试驱动开发')
    expect(projectSkills.find((s) => s.name === 'code-review')?.description).toBe('审查代码 并给出建议')
    expect(projectSkills.find((s) => s.name === 'block-scalar')?.description).toBe('block description on two lines')
    expect(projectSkills.find((s) => s.name === 'code-review')?.category).toBe('frontend')
    expect(projectSkills.some((s) => s.name === 'README')).toBe(false)
  })

  it('创建、编辑、启用开关、回收站恢复与永久删除', () => {
    const created = createSkill(
      { scope: 'project', name: 'my-skill', description: 'demo', category: 'test', body: '# hi' },
      root
    )
    expect(created.path).toContain(join('test', 'my-skill', 'SKILL.md'))
    expect(listSkills(root).find((s) => s.path === created.path)?.category).toBe('test')

    updateSkill(created.path, { scope: 'project', name: 'my-skill', description: 'changed', body: '# changed' }, root)
    expect(readSkill(created.path, root)).toContain('# changed')

    setSkillEnabled(created.path, false, root)
    expect(listSkills(root).find((s) => s.path === created.path)?.enabled).toBe(false)
    expect(skillsDigest(root)).not.toContain('my-skill: changed')

    const trashed = trashSkill(created.path, root)
    expect(listSkillTrash(root).some((s) => s.id === trashed.id)).toBe(true)
    expect(listSkills(root).some((s) => s.path === created.path)).toBe(false)

    restoreSkillTrash(trashed.id, root)
    expect(listSkills(root).some((s) => s.path === created.path)).toBe(true)

    const second = trashSkill(created.path, root)
    purgeSkillTrash(second.id, root)
    expect(listSkillTrash(root).some((s) => s.id === second.id)).toBe(false)
  })

  it('readSkill 可以读取目录技能', () => {
    expect(readSkill(dirSkill, root)).toContain('TDD 正文')
  })

  it('导入其他 Agent 的项目技能', () => {
    const externalSkill = join(root, '.claude', 'skills', 'claude-helper', 'SKILL.md')
    mkdirSync(dirname(externalSkill), { recursive: true })
    writeFileSync(externalSkill, '---\nname: claude-helper\ndescription: from claude\n---\nhelper body')
    const found = listExternalSkills(root).find((s) => s.path === externalSkill)
    expect(found?.source).toContain('Claude Code')
    const result = importExternalSkills([externalSkill], 'project', root)
    expect(result.imported).toHaveLength(1)
    expect(listSkills(root).some((s) => s.name === 'claude-helper' && s.scope === 'project')).toBe(true)
  })

  it('识别其他 Agent 中软链接/目录联接的技能，并复制真实内容', () => {
    const linkedSource = join(root, 'linked-source')
    const externalRoot = join(root, '.gemini', 'skills')
    mkdirSync(linkedSource, { recursive: true })
    mkdirSync(externalRoot, { recursive: true })
    writeFileSync(join(linkedSource, 'SKILL.md'), '---\nname: linked-skill\ndescription: via link\n---\nlinked body')
    symlinkSync(linkedSource, join(externalRoot, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir')

    const found = listExternalSkills(root).find((s) => s.name === 'linked-skill')
    expect(found?.source).toContain('Gemini')

    const result = importExternalSkills([found!.path], 'project', root, 'linked')
    expect(result.imported).toHaveLength(1)
    const importedDir = join(root, '.lidow', 'skills', 'linked', 'linked-skill')
    expect(lstatSync(importedDir).isSymbolicLink()).toBe(false)
    expect(readSkill(join(importedDir, 'SKILL.md'), root)).toContain('linked body')
  })

  it('拒绝技能目录之外的文件', () => {
    expect(() => readSkill(join(root, 'outside.md'), root)).toThrow(/不在允许目录/)
  })
})