import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'lidow-test-echo', version: '1.0.0' })

server.tool('echo', 'Echo text back', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }]
}))

server.resource('hello', 'echo://hello', async () => ({
  contents: [{ uri: 'echo://hello', mimeType: 'text/plain', text: 'hello resource' }]
}))

server.prompt('greet', 'Greet a user', { name: z.string() }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `hi ${name}` } }]
}))

await server.connect(new StdioServerTransport())
