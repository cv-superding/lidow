import { describe, expect, it } from 'vitest'
import { parseGitHubRepoUrl, selectSkillRoots } from '../src/main/ecosystem/skillInstall'

describe('GitHub 技能安装解析', () => {
  it('解析仓库地址与 tree 目录', () => {
    expect(parseGitHubRepoUrl('https://github.com/Leonxlnx/taste-skill')).toMatchObject({
      owner: 'Leonxlnx',
      repo: 'taste-skill'
    })
    expect(parseGitHubRepoUrl('https://github.com/acme/skills/tree/dev/packs/writing')).toMatchObject({
      owner: 'acme',
      repo: 'skills',
      ref: 'dev',
      subdir: 'packs/writing'
    })
    expect(parseGitHubRepoUrl('acme/skills')).toMatchObject({ owner: 'acme', repo: 'skills' })
    // 用户消息里常见的包裹符号
    expect(parseGitHubRepoUrl('{https://github.com/Leonxlnx/taste-skill}')).toMatchObject({
      owner: 'Leonxlnx',
      repo: 'taste-skill'
    })
    expect(parseGitHubRepoUrl('https://github.com/Leonxlnx/taste-skill。')).toMatchObject({
      owner: 'Leonxlnx',
      repo: 'taste-skill'
    })
  })

  it('拒绝非 GitHub 地址', () => {
    expect(() => parseGitHubRepoUrl('https://example.com/a/b')).toThrow(/github\.com/)
    expect(() => parseGitHubRepoUrl('https://github.com/only-owner')).toThrow(/仓库/)
  })

  it('从 tree 中选择 SKILL.md 根目录', () => {
    const paths = [
      'README.md',
      'SKILL.md',
      'alpha/SKILL.md',
      'alpha/scripts/run.sh',
      'packs/writing/SKILL.md',
      'packs/writing/references/style.md'
    ]
    expect(selectSkillRoots(paths).sort()).toEqual(['', 'alpha', 'packs/writing'])
    expect(selectSkillRoots(paths, 'alpha')).toEqual([''])
    expect(selectSkillRoots(paths, 'packs')).toEqual(['writing'])
  })
})
