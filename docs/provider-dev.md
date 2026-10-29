# Provider 开发指南

Provider = 一个 AI 网页平台 + DOM 适配器。Lidow 不调用平台 API（零 Token 成本），
而是注入 overlay 驱动网页本身的输入框与消息区。

## 内置 Provider

DeepSeek / Claude / ChatGPT / Gemini / 豆包 / 通义千问 / 文心一言 / Kimi / 智谱清言。
选择器取自 cuckoo-code 实测值，平台改版后可在设置中编辑。

## 自定义 Provider

两种方式：

1. **设置页**：添加平台（名称 + 首页 URL + 选择器组）
2. **插件**：`manifest.json` 中 `platform` 字段指向 ProviderDescriptor JSON

## DomAdapter 字段

```ts
interface DomAdapter {
  input: string[]          // 聊天输入框（候选列表，命中即用）
  send: string[]           // 发送按钮；全部失效回退模拟 Enter
  messages: string[]       // 消息容器
  bubble: string[]         // 单条 AI 气泡
  streamingFlag: string[]  // 生成中标志（通常是停止按钮；存在=仍在生成）
  newChat: string[]        // 新建会话
  loginFlag: string[]      // 已登录标志
}
```

## 调试

1. 打开对应平台标签页，用 injectJS 工具验证选择器：
   ```lidow
   {"tool":"injectJS","input":{"code":"document.querySelector('textarea')?.placeholder"}}
   ```
2. 修改后在设置 → 平台与账号 → 更新适配器，webview 重新加载即生效。

## 已知坑（来自上游实践）

- **ProseMirror（ChatGPT/Claude）**：不能用 paste 事件（会被识别为文件附件导致空发送），
  必须走 `document.execCommand('insertText')`（overlay 已内置该回退链）。
- **React 受控 textarea**：需 native setter + input 事件（overlay 已内置）。
- **流结束判定**：`streamingFlag` 消失后再等 900ms 文本稳定才算结束，防抖动。
