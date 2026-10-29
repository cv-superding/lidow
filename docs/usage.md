# Lidow 使用手册

## 1. 安装与启动

```bash
git clone <repo> && cd lidow
npm install
npm run dev          # 开发模式（热更新）
npm run dist:win     # 打包 Windows 安装包 + 便携版
npm run dist:mac     # 打包 macOS universal dmg + zip（Intel + Apple Silicon）
```

依赖 Node ≥ 20.19。首次启动会创建 `%APPDATA%/lidow/`（Windows）作为数据目录。

## 2. 第一次使用（5 分钟上手）

1. **打开项目**：工作台 → 「打开项目目录」选择一个文件夹（或从模板初始化：前端/后端/脚本骨架 + 最佳实践规则自动落盘到 `.lidow/rules/`）
2. **选择平台**：点 DeepSeek / Claude / ChatGPT / Gemini / 豆包 / 通义千问 / 文心一言 / Kimi / 智谱清言 任一标签，在网页里登录你的账号（每个账号独立分区，互不串扰；多账号在「设置 → 平台与账号」添加切换）
   > Google 账号登录受 Google 安全策略限制，无法在应用内浏览器完成（会提示「此浏览器或应用可能不安全」）。请返回后用**邮箱/密码**登录；页面顶部出现提示条时，也可点「在系统浏览器打开」查看 Google 的原始页面。
3. **发任务**：右侧 Harness 面板输入任务（`/` 唤起指令菜单）。AI 会输出 ```lidow 工具调用块，Lidow 解析后本地执行、结果回传，直到任务完成
4. **看结果**：工具执行以卡片呈现——diff 视图（edit）、实时终端（bash）、表格（mysql）、文件列表（glob）

## 3. 核心视图

| 视图 | 用途 |
| --- | --- |
| 工作台 | 平台标签页（沉浸 webview）+ Harness 对话面板 |
| 会话 | 历史会话（血缘/分叉/压缩标记）、导出 Markdown 到 `.lidow/exports/` |
| 文件 | 项目文件树 + 只读预览 |
| 任务 | 人机共用待办看板：AI 用 todoWrite 同步进度，你可添加/改状态/清理 |
| 插件 | 已安装插件管理 + GitHub/Gitee 市场搜索安装 + DSH 覆盖率 |
| 记忆 | 跨会话长期记忆（AI 的 remember/forgetMemory 也写这里） |
| 知识库 | 挂载本地文档目录（md/txt/代码…），AI 经 kbSearch 检索 |
| 审计 | 全部文件写入/删除/命令留痕；文件操作可单步回滚 |
| 设置 | 主题主色、安全（确认门/SSRF/拦截正则/安全MOD）、平台账号、MCP、同步、热键、更新 |

## 4. 常用操作

- **斜杠指令**：`/new` 新会话 · `/compact` 压缩上下文 · `/plan` 让 AI 先拆解计划 · `/memory` 让 AI 沉淀记忆 · 自定义指令（设置外的快捷指令存储）
- **停止**：ChatPanel 停止按钮（断网页生成）/ 「全部停止」（断工具+循环）/ 悬浮球右键三层菜单
- **纯净模式**：左栏底部 ⛶，只留对话内容
- **全局热键**：默认 `Alt+Shift+L` 唤起 / `Alt+Shift+N` 新会话 / `Alt+Shift+S` 全部停止 / `Alt+Shift+P` 纯净模式（设置里可改）
- **多端同步**：设置里贴入飞书/企业微信/钉钉群机器人 webhook，任务事件自动推送

## 5. AI 可用的工具（19 个）

read · write · edit（保换行+diff 卡片）· glob · grep · bash · pwsh · webFetch · webSearch · deleteFile · todoWrite（同步任务看板）· planSubmit（计划确认卡）· injectJS（网页内执行）· mysql（.lidow/mysql.json 配置）· clipboard · screenshot · sysinfo · mcpCall · kbSearch · remember/forgetMemory/readSkill

## 6. 扩展

- **技能**：`~/.lidow/skills/`（用户级）或项目 `.lidow/skills/` 放 SKILL.md（frontmatter: name/description）
- **规则**：`.lidow/rules/*.md` 注入系统提示词
- **MCP**：设置 → MCP 服务器，Claude Desktop 配置格式（command/args/env 或 url）
- **插件**：市场搜 `lidow-plugin` topic；插件可打包技能/规则/MCP/自定义平台/网页脚本/DSH 服务（见 docs/plugin-dev.md）
- **DSH 插件**：119 Context 服务全覆盖（三档实现，见 docs/dsh-coverage.md）

## 7. 安全机制

- 危险命令（rm 语义解析、管道注入、根目录通配）→ 确认卡；被拒绝时 AI 会换方案
- SSRF 防护：webFetch 拦截私网/回环/元数据地址（重定向逐跳校验）
- 工具路径锁定项目目录；产物目录（node_modules/dist…）默认禁写
- 设置里可配「AI 回复拦截」正则（命中即不执行工具）与安全 MOD（拒绝改写，上限防循环）

## 8. 故障排查

- **填入失败/抓不到回复**：平台改版导致选择器过期 → 设置 → 平台与账号 → 更新适配器（选择器组）；或用 injectJS 在页面里现场验证
- **日志**：`%APPDATA%/lidow/logs/lidow.log`
- **登录问题**（如 ChatGPT 风控）：切换账号分区重试；登录态每账号独立保存
