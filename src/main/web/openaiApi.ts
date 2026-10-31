import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatTurn, Session } from '@shared/types'
import { parseToolCalls } from '@main/bridge/parser'

export interface OpenAiModel {
  id: string
  name: string
}

export interface OpenAiEvent {
  type: string
  sessionId: string
  text?: string
}

export interface OpenAiHost {
  listModels(): OpenAiModel[]
  resolveProject(ref?: string): { id: string; name: string } | null
  createSession(projectId: string, providerId: string, accountId?: string): Session
  getSession(sessionId: string): Session | null
  ensureAttached(sessionId: string): Promise<boolean>
  run(sessionId: string, prompt: string): Promise<void>
  stop(sessionId: string): void
  onEvent(listener: (event: OpenAiEvent) => void): () => void
}

interface ChatMessage {
  role?: unknown
  content?: unknown
}

interface ChatRequest {
  model?: unknown
  messages?: unknown
  stream?: unknown
  conversation_id?: unknown
  metadata?: { project?: unknown; account?: unknown } | null
}

interface ApiError extends Error {
  status: number
  type: string
}

function apiError(status: number, message: string, type = 'invalid_request_error'): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  err.type = type
  return err
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function errorBody(err: unknown): {
  error: { message: string; type: string; code: string | null }
} {
  const e = err as Partial<ApiError>
  const message = e instanceof Error ? e.message : typeof err === 'string' ? err : '请求失败'
  const type = typeof e.type === 'string' ? e.type : 'server_error'
  return { error: { message, type, code: null } }
}

function readJson(req: IncomingMessage): Promise<ChatRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(apiError(413, '请求体过大（最大 2MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? (JSON.parse(raw) as ChatRequest) : {})
      } catch {
        reject(apiError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** OpenAI 的 content 既可以是字符串，也可以是 text part 数组 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        return String((part as { text?: unknown }).text ?? '')
      }
      return ''
    })
    .join('')
}

export function extractPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as ChatMessage
    if (!msg || typeof msg !== 'object') continue
    if (String(msg.role ?? '') !== 'user') continue
    const text = messageText(msg.content).trim()
    if (text) return text
  }
  return ''
}

function assistantTurnsFrom(session: Session | null, from: number): ChatTurn[] {
  if (!session) return []
  return session.turns.filter((t) => t.role === 'assistant').slice(from)
}

export function assistantSnapshot(session: Session | null, from: number): string {
  return assistantTurnsFrom(session, from)
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function assistantCount(session: Session | null): number {
  return session ? session.turns.filter((t) => t.role === 'assistant').length : 0
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function chunkPayload(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })
}

/**
 * OpenAI 兼容层：把 /v1/chat/completions 映射到 Lidow 的网页 Agent 循环。
 * - 只发最后一条 user 消息（网页端自带上下文），system/历史消息忽略
 * - 流式：转发 turn-chunk 的增量；非流式：等任务结束取最终 assistant 文本
 * - 同一平台的请求串行，避免多个会话抢同一个网页
 */
export function createOpenAiHandler(
  host: OpenAiHost
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const queues = new Map<string, Promise<void>>()
  /** 同一会话可能有多个流式消费者：先断开的那个不能停掉别人的任务 */
  const streamConsumers = new Map<string, number>()
  const acquireStream = (sessionId: string): void => {
    streamConsumers.set(sessionId, (streamConsumers.get(sessionId) ?? 0) + 1)
  }
  /** 返回 true 表示这是最后一个消费者 */
  const releaseStream = (sessionId: string): boolean => {
    const n = streamConsumers.get(sessionId) ?? 0
    if (n <= 1) {
      streamConsumers.delete(sessionId)
      return true
    }
    streamConsumers.set(sessionId, n - 1)
    return false
  }

  const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(task)
    const guarded = next.then(
      () => undefined,
      () => undefined
    )
    queues.set(key, guarded)
    return next.finally(() => {
      if (queues.get(key) === guarded) queues.delete(key)
    })
  }

  return async (req, res, url): Promise<boolean> => {
    if (url.pathname === '/v1/models') {
      if (req.method !== 'GET') {
        json(res, 405, errorBody(apiError(405, '仅支持 GET')))
        return true
      }
      const data = host.listModels().map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'lidow',
        name: m.name
      }))
      json(res, 200, { object: 'list', data })
      return true
    }

    if (url.pathname !== '/v1/chat/completions') {
      if (url.pathname.startsWith('/v1/')) {
        json(res, 404, errorBody(apiError(404, `未知接口 ${url.pathname}`, 'not_found_error')))
        return true
      }
      return false
    }
    if (req.method !== 'POST') {
      json(res, 405, errorBody(apiError(405, '仅支持 POST')))
      return true
    }

    let body: ChatRequest
    try {
      body = await readJson(req)
    } catch (err) {
      json(res, (err as ApiError).status ?? 400, errorBody(err))
      return true
    }

    const modelKey = String(body.model ?? '')
      .trim()
      .replace(/^lidow[/-]/i, '')
    const models = host.listModels()
    const provider =
      models.find((m) => m.id === modelKey) ??
      models.find((m) => m.name.toLowerCase() === modelKey.toLowerCase())
    if (!provider) {
      json(res, 404, errorBody(apiError(404, `未知模型：${modelKey || '(空)'}`, 'model_not_found')))
      return true
    }

    const prompt = extractPrompt(body.messages)
    if (!prompt) {
      json(res, 400, errorBody(apiError(400, 'messages 里没有可发送的 user 文本')))
      return true
    }

    const header = (name: string): string => String(req.headers[name] ?? '').trim()
    const conversationId = String(
      body.conversation_id ?? header('x-lidow-conversation-id') ?? ''
    ).trim()
    const projectRef = String(body.metadata?.project ?? header('x-lidow-project') ?? '').trim()
    const accountId =
      String(body.metadata?.account ?? header('x-lidow-account') ?? '').trim() || undefined

    let session: Session
    try {
      if (conversationId) {
        const found = host.getSession(conversationId)
        if (!found) throw apiError(404, `会话不存在：${conversationId}`, 'not_found_error')
        if (found.providerId !== provider.id) {
          throw apiError(
            400,
            `会话 ${conversationId} 属于平台 ${found.providerId}，与 model=${provider.id} 不一致`
          )
        }
        if (!host.resolveProject(found.projectId)) {
          throw apiError(400, '会话所属项目不可用，请在 Lidow 重新打开工作区')
        }
        session = found
      } else {
        const project = host.resolveProject(projectRef || undefined)
        if (!project) {
          throw apiError(
            400,
            '没有可用的工作区：请先在 Lidow 打开一个项目，或用 metadata.project 指定项目 id/路径'
          )
        }
        session = host.createSession(project.id, provider.id, accountId)
      }
    } catch (err) {
      json(res, (err as ApiError).status ?? 500, errorBody(err))
      return true
    }

    const sessionId = session.id
    const providerKey = `${provider.id}:${session.accountId ?? accountId ?? 'default'}`
    const stream = body.stream === true
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = String(body.model ?? provider.id)
    res.setHeader('x-lidow-conversation-id', sessionId)

    if (!stream) {
      try {
        const content = await enqueue(providerKey, async () => {
          const attached = await host.ensureAttached(sessionId)
          if (!attached)
            throw apiError(503, '网页未连接：请确认平台已登录且页面能正常打开', 'server_error')
          const baseline = assistantCount(host.getSession(sessionId))
          await host.run(sessionId, prompt)
          const final = assistantSnapshot(host.getSession(sessionId), baseline)
          if (!final)
            throw apiError(502, 'AI 没有产生回复（页面未登录/被中断/平台异常）', 'server_error')
          return final
        })
        json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          conversation_id: sessionId
        })
      } catch (err) {
        json(res, (err as ApiError).status ?? 500, errorBody(err))
      }
      return true
    }

    // ---- SSE ----
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    let closed = false
    let ended = false
    let released = false
    acquireStream(sessionId)
    const releaseConsumer = (): void => {
      if (released) return
      released = true
      if (releaseStream(sessionId)) {
        try {
          host.stop(sessionId)
        } catch {
          /* 页面已关闭 */
        }
      }
    }
    res.on('close', () => {
      closed = true
      releaseConsumer()
    })
    const write = (text: string): void => {
      // ended 只用于防止重复收尾；结束帧本身还要写出去
      if (closed) return
      try {
        res.write(text)
      } catch {
        closed = true
      }
    }
    const send = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
      write(`data: ${chunkPayload(id, created, model, delta, finishReason)}\n\n`)
    }
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000)
    heartbeat.unref?.()
    const finish = (): void => {
      if (ended) return
      ended = true
      clearInterval(heartbeat)
      send({}, 'stop')
      write('data: [DONE]\n\n')
      if (!closed) res.end()
      releaseConsumer()
    }
    const fail = (err: unknown): void => {
      if (ended) return
      ended = true
      clearInterval(heartbeat)
      write(`data: ${JSON.stringify(errorBody(err))}\n\n`)
      write('data: [DONE]\n\n')
      if (!closed) res.end()
      releaseConsumer()
    }

    send({ role: 'assistant', content: '' })

    void enqueue(providerKey, async () => {
      if (closed) return
      const attached = await host.ensureAttached(sessionId)
      if (!attached)
        throw apiError(503, '网页未连接：请确认平台已登录且页面能正常打开', 'server_error')

      const baseline = assistantCount(host.getSession(sessionId))
      let sent = ''
      let lastPartial = ''
      let accumulated = ''
      let runError: unknown = null
      const unsubscribe = host.onEvent((event) => {
        if (event.type !== 'turn-chunk' || event.sessionId !== sessionId) return
        const raw = typeof event.text === 'string' ? event.text : ''
        if (!raw) return
        const cleaned = parseToolCalls(raw).cleanText.trimEnd()
        if (!cleaned) return
        if (cleaned.startsWith(lastPartial)) {
          const delta = cleaned.slice(lastPartial.length)
          if (delta) {
            send({ content: delta })
            accumulated += delta
          }
          lastPartial = cleaned
          sent = accumulated
          return
        }
        if (lastPartial.startsWith(cleaned)) {
          lastPartial = cleaned
          return
        }
        // 新一轮（工具调用后的下一段回答）：用空行分隔
        const sep = accumulated ? '\n\n' : ''
        send({ content: sep + cleaned })
        accumulated += sep + cleaned
        lastPartial = cleaned
        sent = accumulated
      })

      try {
        await host.run(sessionId, prompt)
      } catch (err) {
        runError = err
      } finally {
        unsubscribe()
      }
      if (runError) throw runError

      // 流式期间只拿到增量，最后用落盘文本补齐（工具块已被清理）
      const final = assistantSnapshot(host.getSession(sessionId), baseline)
      if (final && final !== sent) {
        if (final.startsWith(sent)) {
          const delta = final.slice(sent.length)
          if (delta) send({ content: delta })
        } else {
          const common = commonPrefixLength(sent, final)
          const delta = final.slice(common)
          if (delta) send({ content: delta })
        }
      }
      if (!final)
        throw apiError(502, 'AI 没有产生回复（页面未登录/被中断/平台异常）', 'server_error')
    })
      .then(() => finish())
      .catch((err) => fail(err))

    return true
  }
}
