# 后端编码规则（Lidow 项目级）

- 路由层禁止写业务逻辑，只做校验与调用 service
- 所有外部输入必须校验（zod / 手写守卫），错误信息不泄漏内部细节
- 数据库操作集中在 repositories，服务层不出现 SQL
- 日志：请求级 INFO、业务异常 WARN、系统错误 ERROR
