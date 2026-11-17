// The Kificut connector for Claude Desktop: an MCP server that hands Claude's tool calls to the
// Kificut app running on the same computer. stdout carries the protocol, so log to stderr only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AI_INSTRUCTIONS, AI_TOOLS } from '@shared/ai-tools'
import { KificutClient } from './kificut-client'

declare const __VERSION__: string

const server = new Server(
  { name: 'kificut', title: 'Kificut', version: __VERSION__ },
  { capabilities: { tools: {} }, instructions: AI_INSTRUCTIONS }
)

function clientName(): string {
  const name = server.getClientVersion()?.name ?? ''
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code'
  if (/claude/i.test(name)) return 'Claude'
  return name || 'An assistant'
}

const kificut = new KificutClient(clientName)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AI_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations }
  }))
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await kificut.call(request.params.name, request.params.arguments ?? {})
  return { content: result.content, ...(result.isError ? { isError: true } : {}) }
})

async function main(): Promise<void> {
  // Used by the build to write the bundle manifest from the same tool list.
  if (process.argv.includes('--print-tools')) {
    process.stdout.write(JSON.stringify(AI_TOOLS.map(({ name, description }) => ({ name, description }))))
    return
  }
  await server.connect(new StdioServerTransport())
  const shutdown = () => {
    kificut.close()
    process.exit(0)
  }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error('Kificut connector failed to start:', error)
  process.exit(1)
})
