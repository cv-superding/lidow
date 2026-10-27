# Lidow 自身开发规则（dogfooding）

本仓库用自己的 .lidow 体系管理 AI 协作规则。

- 架构分层不可破坏：main / preload / overlay / renderer 四端职责见 docs/architecture.md
- 新增 IPC 方法必须：shared/ipc.ts 契约 → handlers.ts 注册 → preload 零改动（Proxy 自动映射）
- 新增工具必须：ToolDef 结构 + registry 注册（自动进系统提示词与工具卡片）+ 危险级别标注
- 安全红线：不动 security/ 下检测逻辑的白名单语义；新正则必须带单测（test/commandGuard*.test.ts）
- 提示词改动集中 prompt/protocol.ts 与 prompt/build.ts；禁止在工具实现里拼提示词
- DSH 新服务：native 优先；泛用兜底须在 docs/dsh-coverage.md 标注档位
- 每次交付跑四道验证：typecheck / lint / test / build，全绿才算完成
