import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Logger } from '../infra/log'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8'
}

export interface WebServerOptions {
  root: string
  port: number
  host: string
  token?: string
  invoke: (method: string, args: unknown[]) => unknown
  /** OpenAI 兼容接口（/v1/*）；返回 false 表示该路径不归它处理 */
  openai?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
}

/**
 * Web 版服务：静态前端 + HTTP API + SSE 事件流。
 * 不依赖 Express/ws，容器里少一层依赖；SSE 足够把 main 的事件单向推给浏览器。
 */
export class WebServer {
  private server = createServer((req, res) => void this.handle(req, res))
  private clients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout

  constructor(private readonly opts: WebServerOptions) {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n')
        } catch {
          this.clients.delete(res)
        }
      }
    }, 20_000)
    this.heartbeat.unref()
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.opts.port, this.opts.host, () => resolvePromise())
    })
    Logger.info('web', `Web 版监听 http://${this.opts.host}:${this.opts.port}`)
  }

  broadcast(event: unknown): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    this.server.close()
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    return bearer === this.opts.token || url.searchParams.get('token') === this.opts.token
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }
    if (url.pathname.startsWith('/v1/')) {
      if (!this.authorized(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ error: { message: 'unauthorized', type: 'authentication_error' } })
        )
        return
      }
      if (this.opts.openai) {
        const handled = await this.opts.openai(req, res, url)
        if (handled) return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found_error' } }))
      return
    }
    if (url.pathname === '/api/events') {
      if (!this.authorized(req, url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write('retry: 2000\n\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }
    if (url.pathname === '/api/invoke') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (!this.authorized(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}') as { method?: unknown; args?: unknown }
        const method = String(parsed.method ?? '')
        if (!method) throw new Error('缺少 method')
        const args = Array.isArray(parsed.args) ? parsed.args : []
        const result = await this.opts.invoke(method, args)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, result }))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }
    this.serveStatic(url.pathname, res)
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const root = resolve(this.opts.root)
    const decoded = decodeURIComponent(pathname)
    const target = resolve(join(root, normalize(decoded)))
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(403).end()
      return
    }
    let file = target
    try {
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    } catch {
      file = join(root, 'index.html')
    }
    if (!existsSync(file)) file = join(root, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404).end('web build not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable'
    })
    createReadStream(file).pipe(res)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // 剪贴板图片以 data URL 走通用 invoke，base64 会把体积放大约 1/3
      if (size > 24 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
