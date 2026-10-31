import { nanoid } from 'nanoid'
import { Logger } from './log'

export interface Job {
  id: string
  name: string
  /** intervalMs 或 cron 表达式（Lidow 精简支持：intervalMs / 每日 HH:mm） */
  schedule: { kind: 'interval'; intervalMs: number } | { kind: 'daily'; at: string }
  /** 任务动作：经 DSH ctx.shell 执行的命令或回调 id */
  action: string
  enabled: boolean
  lastRunAt?: number
  lastStatus?: 'ok' | 'error' | 'running'
  lastError?: string
}

/**
 * DSH B3 底座：作业调度器（进程内）。
 * jobs / jobController / schedule / scheduler 服务共享此运行时。
 */
export class JobScheduler {
  private jobs = new Map<string, Job>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private runner?: (job: Job) => Promise<void>

  setRunner(fn: (job: Job) => Promise<void>): void {
    this.runner = fn
  }

  create(name: string, schedule: Job['schedule'], action: string): Job {
    const job: Job = { id: `job_${nanoid(6)}`, name, schedule, action, enabled: true }
    this.jobs.set(job.id, job)
    if (schedule.kind === 'interval') this.startTimer(job)
    else this.scheduleDaily(job)
    return job
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  remove(id: string): boolean {
    const t = this.timers.get(id)
    if (t) clearInterval(t)
    this.timers.delete(id)
    return this.jobs.delete(id)
  }

  /** jobController：启停 */
  setEnabled(id: string, enabled: boolean): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.enabled = enabled
    const t = this.timers.get(id)
    if (t) {
      clearInterval(t)
      this.timers.delete(id)
    }
    if (enabled) {
      if (job.schedule.kind === 'interval') this.startTimer(job)
      else this.scheduleDaily(job)
    }
    return true
  }

  /** 手动触发一次 */
  async trigger(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job || !this.runner) return false
    await this.runOnce(job)
    return true
  }

  private startTimer(job: Job): void {
    const raw = job.schedule.kind === 'interval' ? Number(job.schedule.intervalMs) : 60_000
    // NaN 会让 setInterval 退化成 1ms 死循环：插件传来非法值时必须回退默认
    const ms = Number.isFinite(raw) ? Math.max(60_000, raw) : 60_000
    const t = setInterval(() => void this.runOnce(job), ms)
    this.timers.set(job.id, t)
  }

  private scheduleDaily(job: Job): void {
    if (job.schedule.kind !== 'daily') return
    const m = /^(\d{1,2}):(\d{2})$/.exec(job.schedule.at.trim())
    const hh = m ? Number(m[1]) : NaN
    const mm = m ? Number(m[2]) : NaN
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) {
      // 非法时间会让 target 变成 Invalid Date、setTimeout(NaN) 立刻执行并递归自身
      Logger.warn('jobs', `作业 ${job.name} 的每日时间无效: ${job.schedule.at}（已跳过调度）`)
      return
    }
    const target = new Date()
    target.setHours(hh, mm, 0, 0)
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1)
    const delay = target.getTime() - Date.now()
    const t = setTimeout(() => {
      void this.runOnce(job)
      this.scheduleDaily(job) // 递归排下一天
    }, delay)
    // setTimeout 存入 timers 统一管理（clearInterval 对 timeout 同样生效于 node）
    this.timers.set(job.id, t as unknown as ReturnType<typeof setInterval>)
  }

  private async runOnce(job: Job): Promise<void> {
    if (!job.enabled || !this.runner) return
    job.lastRunAt = Date.now()
    job.lastStatus = 'running'
    try {
      await this.runner(job)
      job.lastStatus = 'ok'
      job.lastError = undefined
    } catch (e) {
      job.lastStatus = 'error'
      job.lastError = String(e instanceof Error ? e.message : e)
      Logger.warn('jobs', `作业 ${job.name} 失败: ${job.lastError}`)
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearInterval(t)
    this.timers.clear()
  }
}
