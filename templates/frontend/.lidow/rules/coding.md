# 前端编码规则（Lidow 项目级）

- 组件保持纯函数；副作用收敛到 hooks
- 列表渲染必须带稳定 key，禁止用数组下标
- 事件处理函数命名 handleXxx；Hook 返回数组解构
- 请求统一走 src/api 层，组件不直接 fetch
- 错误边界：路由级必须包 ErrorBoundary
