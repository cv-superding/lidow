# 前端项目模板

## 结构
- `src/components/` 通用组件（大写驼峰命名）
- `src/pages/` 页面级组件
- `src/hooks/` 自定义 Hook（use 前缀）
- `src/api/` 接口层
- `src/styles/` 全局样式

## 约定
- TypeScript strict；禁止 any（确需时用 unknown + 收窄）
- 组件文件名 = 组件名；一个文件一个主组件
- 样式优先 TailwindCSS 工具类，复杂动效抽 CSS
- 状态：组件内 useState / 跨组件 zustand；避免过度抽象
