# 自动化脚本模板

## 结构
- `main.py` 入口（argparse）
- `core.py` 核心逻辑（可单测的纯函数）
- `utils.py` 工具函数
- `requirements.txt` 依赖

## 约定
- 类型标注完整（typing）；函数职责单一
- 输出用 logging 而非 print；重要节点落日志
- 长任务支持断点与幂等重跑
