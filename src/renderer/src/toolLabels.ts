/** 工具名 → 中文标签（活动流里优先展示用户能看懂的动作） */
const TOOL_LABELS: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  deleteFile: '删除文件',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '终端命令',
  pwsh: 'PowerShell',
  webFetch: '抓取网页',
  webSearch: '联网搜索',
  todoWrite: '更新任务',
  mysql: '数据库查询',
  injectJS: '注入脚本',
  screenshot: '截屏',
  clipboard: '剪贴板',
  sysinfo: '系统信息',
  remember: '保存记忆',
  forgetMemory: '删除记忆',
  readSkill: '读取技能',
  planSubmit: '提交计划',
  runAgent: '子代理',
  mcpCall: 'MCP 调用',
  kbSearch: '知识库检索'
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}
