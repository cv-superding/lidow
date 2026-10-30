# HTTP API（OpenAI 兼容）

Lidow 可以作为一个本地的 **OpenAI 兼容服务**：请求经网页版 AI 处理，工具调用仍在 Lidow 所在机器执行。
适合接 Chatbox、LobeChat、IDE 插件或自动化脚本；配合 Nginx/Caddy 反代后可供局域网/其他设备使用。

## 开启

设置 → 多端同步 → **HTTP API（可反代）**：

- **启用接口服务**：打开后立即监听；修改端口/地址/Token 会自动重启服务
- **监听地址**：
  - `127.0.0.1`：仅本机（推荐，反代与 Lidow 在同一台机器）
  - `0.0.0.0`：局域网可访问（务必使用随机 Token，并在反代层加 TLS/访问控制）
- **端口**：默认 `6080`
- **Token**：首次启用自动生成，可重新生成/复制；请求头 `Authorization: Bearer <Token>`

服务启动失败（如端口被占用）会在设置页显示错误，并弹出提示。

Web/Docker 版不会读取这个设置：用 `LIDOW_WEB_SERVER=1` 启动后，`/v1` 与 Web UI 共用 `LIDOW_WEB_TOKEN`。

## 接口

### `GET /v1/models`

列出当前项目可用平台（`model` 就是这里的 `id`）：

```json
{
  "object": "list",
  "data": [{ "id": "deepseek", "object": "model", "created": 0, "owned_by": "lidow", "name": "DeepSeek" }]
}
```

### `POST /v1/chat/completions`

请求体：

```json
{
  "model": "deepseek",
  "messages": [{ "role": "user", "content": "看一下项目里的 README，总结三条" }],
  "stream": false,
  "conversation_id": "可选，复用会话",
  "metadata": { "project": "可选，项目 id/路径/名称", "account": "可选，平台账号 id" }
}
```

说明：

- `messages` 只取**最后一条 user 文本**；system/历史消息由网页端自己维护（同一个网页对话自带上下文）。多轮请用 `conversation_id` 复用会话。
- `conversation_id` 不传则新建会话；响应头 `x-lidow-conversation-id` 会返回，也可用 `X-Lidow-Conversation-Id` 头传回。非流式响应里也有 `conversation_id` 字段。
- `metadata.project` 缺省用当前项目；`metadata.account` 缺省用当前账号，若没有任何当前账号则用该平台的第一个账号。
- 也支持请求头：`X-Lidow-Project`、`X-Lidow-Account`。
- 暂不支持图片、function/tools 参数；Lidow 自己的工具由网页端 Agent 自动调用。

非流式响应（OpenAI 格式 + `conversation_id`）：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1793356346,
  "model": "deepseek",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "conversation_id": "sess_..."
}
```

`usage` 全为 0：网页版不产生按 Token 计费。

流式（`"stream": true`）返回标准 `chat.completion.chunk`，最后以 `data: [DONE]` 结束；任务执行期间每 15 秒发送一次 SSE 心跳注释。

## 示例

```bash
TOKEN=你的Token
BASE=http://127.0.0.1:6080/v1

curl -s $BASE/models -H "Authorization: Bearer $TOKEN"

curl -s $BASE/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"只回复 OK"}]}'

# 流式
curl -N $BASE/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"用一句话介绍自己"}],"stream":true}'
```

OpenAI SDK（Node）：

```js
const client = new OpenAI({ baseURL: 'http://127.0.0.1:6080/v1', apiKey: process.env.LIDOW_TOKEN })
const r = await client.chat.completions.create({
  model: 'deepseek',
  messages: [{ role: 'user', content: '只回复 OK' }]
})
```

## 反向代理

Nginx（只反代 API 时）：

```nginx
location /v1/ {
  proxy_pass http://127.0.0.1:6080;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
  proxy_buffering off;        # SSE 必须
  proxy_cache off;
  proxy_read_timeout 900s;    # 长任务/工具调用
}
```

Caddy：

```caddy
example.com {
  reverse_proxy 127.0.0.1:6080 {
    flush_interval -1          # SSE 不缓冲
  }
}
```

Caddy 默认对 text/event-stream 关闭缓冲；长任务较多时再调大 transport 的 `read_timeout`。

## 限制与安全

- **同平台串行**：同一平台/账号同时只跑一个任务，API 会自动排队；不同平台可并行。任务耗时受网页版回复速度影响。
- **工具在本机执行**：API 触发的 Agent 可以读写文件、执行命令，权限与审批遵循 Lidow 的设置（建议先在工作台里确认一次工具权限）。
- **平台需已登录**：先在 Lidow 网页里登录对应平台；接口不会替你完成登录。
- **回复识别依赖平台适配器**：能正常在 Lidow 里回传回复的平台才能用于 API。当前 ChatGPT 的新 Workspace 界面尚未适配消息 DOM，可能返回空回复；建议先用网页端发一条消息确认。
- **不要把端口直接裸露到公网**：API 具备本机执行能力；反代请加 HTTPS 与额外鉴权，并保持 Token 足够随机。
