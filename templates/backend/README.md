# 后端服务模板

## 结构
- `src/routes/` 路由定义（只做参数校验与转发）
- `src/services/` 业务逻辑
- `src/repositories/` 数据访问
- `src/middlewares/` 中间件（鉴权/限流/错误处理）
- `src/config/` 配置加载

## 约定
- 环境变量经 config 层读取，禁止散落 process.env
- 统一错误类型 AppError(code, message, status)
- 响应格式统一 { code, data, message }
