# 插件开发指南

## 插件结构

```
my-plugin/
├─ manifest.json      # 必需
├─ skills/*.md        # 可选：随插件安装的技能
├─ agents/*.md        # 可选：子代理
├─ rules/*.md         # 可选：规则
├─ mcp.json           # 可选：MCP 服务器配置（Claude Desktop 格式）
├─ platform.json      # 可选：自定义 Provider
├─ web-script.js      # 可选：注入 AI 网页的脚本
└─ dsh.js             # 可选：DSH 服务扩展，导出 register(ctx)
```

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "……",
  "author": "…",
  "category": "productivity",
  "provides": ["skills", "mcp"],
  "dsh": "dsh.js"
}
```

## DSH 服务扩展示例（dsh.js）

```js
export function register(ctx) {
  // ctx.tools / ctx.fs / ctx.shell / ctx.storage / ctx.slots …
  ctx.slots.register({ id: 'my-panel', area: 'sidebar', title: '我的面板' })
}
```

可用服务见 `docs/dsh-coverage.md` 已实现清单。

## 发布

1. 推送仓库到 GitHub / Gitee
2. 添加 topic：`lidow-plugin`（分类可加 `lidow-<category>`）
3. 市场搜索即自动发现；用户一键安装（zip 下载 → 解压 → 依赖检测）

## 依赖检测

安装后自动校验 `entry` / `dsh` 文件存在性；缺失项在插件卡片显示问题清单。
