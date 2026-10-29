import type { ToolDef } from './types'
import type { MemoryStore } from '@main/ecosystem/memory'
import type { TaskPlanStore } from '@main/ecosystem/taskPlan'
import { readSkill } from '@main/ecosystem/skills'
import type { TaskPlan } from '@shared/types'
import { str } from './types'

/** 生态工具：记忆读写 + 技能读取 + 计划提交（经 ctx 附加对象传入依赖） */
export interface EcosystemRefs {
  memory: MemoryStore
  plans: TaskPlanStore
  projectRoot: () => string
  currentSessionId: () => string
  /** 计划草稿提交后通知渲染层弹确认卡（否则只有重开会话才看得到） */
  onPlanProposed?: (sessionId: string, plan: TaskPlan) => void
}

export function createEcosystemTools(refs: EcosystemRefs): ToolDef[] {
  const remember: ToolDef = {
    name: 'remember',
    description: '保存一条用户长期记忆（偏好/事实/约定），跨会话生效。',
    parameters: {
      title: { type: 'string', description: '记忆标题', required: true },
      content: { type: 'string', description: '记忆内容', required: true },
      tags: { type: 'string', description: '逗号分隔标签' }
    },
    dangerLevel: 'safe',
    async run(input) {
      const tags = str(input, 'tags')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      refs.memory.add(str(input, 'title'), str(input, 'content'), tags, 'ai')
      return { ok: true, output: '记忆已保存' }
    }
  }

  const forgetMemory: ToolDef = {
    name: 'forgetMemory',
    description: '按标题关键词删除一条用户记忆。',
    parameters: { keyword: { type: 'string', description: '标题关键词', required: true } },
    dangerLevel: 'safe',
    async run(input) {
      const kw = str(input, 'keyword').toLowerCase()
      const hit = refs.memory.list().find((e) => e.title.toLowerCase().includes(kw))
      if (!hit) return { ok: false, output: '', error: `没有匹配「${kw}」的记忆` }
      refs.memory.remove(hit.id)
      return { ok: true, output: `已删除记忆：${hit.title}` }
    }
  }

  const readSkillTool: ToolDef = {
    name: 'readSkill',
    description: '读取技能完整正文（技能目录已在系统提示词中）。',
    parameters: { name: { type: 'string', description: '技能名', required: true } },
    dangerLevel: 'safe',
    async run(input, ctx) {
      // readSkill 按路径校验；此处按名字查找后调用。用工具上下文里的项目根，
      // 避免任务运行中切换活动项目后读到别的项目的技能。
      const root = ctx.projectRoot || refs.projectRoot()
      const { listSkills } = await import('@main/ecosystem/skills')
      const skill = listSkills(root).find((s) => s.name === str(input, 'name'))
      if (!skill) return { ok: false, output: '', error: `技能不存在: ${str(input, 'name')}` }
      return { ok: true, output: readSkill(skill.path, root) }
    }
  }

  const planSubmit: ToolDef = {
    name: 'planSubmit',
    description: '提交分步任务计划草稿给用户确认（复杂任务建议先拆解）。用户确认后按步骤执行。',
    parameters: {
      goal: { type: 'string', description: '总目标', required: true },
      steps: { type: 'string', description: 'JSON 数组字符串：[{"title":"…","detail":"…"}]', required: true }
    },
    dangerLevel: 'safe',
    async run(input, ctx) {
      try {
        const steps = JSON.parse(str(input, 'steps')) as { title: string; detail?: string }[]
        if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps 不能为空')
        // 会话 id 以工具上下文为准：用户在任务执行中切换活动会话也不会把计划挂错
        const sessionId = ctx.sessionId || refs.currentSessionId()
        const plan = refs.plans.propose(
          sessionId,
          str(input, 'goal'),
          steps.map((s) => ({ title: String(s.title), detail: String(s.detail ?? '') }))
        )
        refs.onPlanProposed?.(sessionId, plan)
        return { ok: true, output: '计划草稿已提交，等待用户确认。确认后按顺序逐项执行。' }
      } catch (e) {
        return { ok: false, output: '', error: `steps 必须是 JSON 数组: ${String(e)}` }
      }
    }
  }

  return [remember, forgetMemory, readSkillTool, planSubmit]
}
