import type { ToolDef } from './types'
import { readTool, writeTool, editTool, globTool, grepTool, deleteFileTool } from './fs'
import { bashTool, pwshTool } from './exec'
import { webFetchTool, webSearchTool, todoWriteTool, injectJsTool } from './net'
import { mysqlTool } from './mysql'

export type { ToolDef, ToolContext, ToolOutput } from './types'

const BUILT_IN: ToolDef[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  deleteFileTool,
  bashTool,
  pwshTool,
  webFetchTool,
  webSearchTool,
  todoWriteTool,
  injectJsTool,
  mysqlTool
]

/** 工具注册表：内置 + MCP + DSH 插件工具统一在此注册 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  constructor() {
    for (const t of BUILT_IN) this.register(t)
  }

  register(def: ToolDef): void {
    this.tools.set(def.name, def)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  all(): ToolDef[] {
    return [...this.tools.values()]
  }

  /** 生成系统提示词里的工具说明段 */
  describeForPrompt(): string {
    return this.all()
      .map((t) => {
        const params = Object.entries(t.parameters)
          .map(([k, v]) => `${k}: ${v.type}${v.required ? '' : '?'} — ${v.description}`)
          .join('; ')
        return `- ${t.name}(${params}): ${t.description}`
      })
      .join('\n')
  }
}
