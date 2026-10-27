import { nanoid } from 'nanoid'
import type { TaskPlan, TaskItem } from '@shared/types'

/**
 * 智能任务拆解：复杂需求 → AI 产出分步清单 → 用户确认（可编辑）→ 逐项执行。
 * 计划本身也是一次对话：AI 用 planSubmit 工具提交草稿，UI 弹确认卡。
 */
export class TaskPlanStore {
  private plans = new Map<string, TaskPlan>()

  propose(sessionId: string, goal: string, items: { title: string; detail: string }[]): TaskPlan {
    const plan: TaskPlan = {
      id: `plan_${nanoid(8)}`,
      sessionId,
      goal: goal.slice(0, 500),
      items: items.slice(0, 30).map((it) => ({
        id: `task_${nanoid(6)}`,
        title: it.title.slice(0, 120),
        detail: (it.detail ?? '').slice(0, 500),
        status: 'pending' as const,
        createdAt: Date.now()
      })),
      status: 'draft',
      createdAt: Date.now()
    }
    this.plans.set(sessionId, plan)
    return plan
  }

  activeOf(sessionId: string): TaskPlan | null {
    const plan = this.plans.get(sessionId)
    return plan && plan.status !== 'done' && plan.status !== 'aborted' ? plan : null
  }

  confirm(sessionId: string, edits?: { id: string; title: string; detail: string }[]): TaskPlan | null {
    const plan = this.plans.get(sessionId)
    if (!plan || plan.status !== 'draft') return null
    if (edits) {
      plan.items = plan.items.map((it) => {
        const e = edits.find((x) => x.id === it.id)
        return e ? { ...it, title: e.title, detail: e.detail } : it
      })
    }
    plan.status = 'confirmed'
    return plan
  }

  /** 循环内推进：返回下一个待办项 */
  nextTask(sessionId: string): TaskItem | null {
    const plan = this.plans.get(sessionId)
    if (!plan || plan.status !== 'confirmed' && plan.status !== 'running') return null
    plan.status = 'running'
    return plan.items.find((it) => it.status === 'pending') ?? null
  }

  markTask(sessionId: string, taskId: string, status: TaskItem['status']): void {
    const plan = this.plans.get(sessionId)
    if (!plan) return
    plan.items = plan.items.map((it) => (it.id === taskId ? { ...it, status } : it))
    if (plan.items.every((it) => it.status === 'done' || it.status === 'skipped' || it.status === 'failed')) {
      plan.status = 'done'
    }
  }

  abort(sessionId: string): void {
    const plan = this.plans.get(sessionId)
    if (plan) plan.status = 'aborted'
  }
}
