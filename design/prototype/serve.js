const http = require('http')
const fs = require('fs')
const path = require('path')

const root = __dirname
const port = Number(process.argv[2] || 4173)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(root, url === '/' ? 'index.html' : url)
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
      res.end(data)
    })
  })
  .listen(port, '127.0.0.1', () => console.log(`prototype on http://127.0.0.1:${port}`))
