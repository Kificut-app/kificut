import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { ToolError as RunnerToolError } from '@anthropic-ai/sdk/lib/tools/ToolError'
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultContentBlockParam
} from '@anthropic-ai/sdk/resources/beta'
import { AI_TOOLS, type ToolResult } from '@shared/ai-tools'
import type { ModelChoice, ProviderSession, TurnContext } from './types'

/*
 * Claude through the official SDK. The SDK's tool runner drives the loop: it sends the tools,
 * runs each call through Kificut's tool layer and feeds the results back until Claude is done.
 */

const MAX_TOKENS = 64000
const MAX_ITERATIONS = 60
const MAX_JSON_RETRIES = 2

/** Models that take `fallbacks: "default"`, which retries a declined request on another Claude model. */
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/

class TruncatedToolInput extends Error {}

function toBlocks(result: ToolResult): BetaToolResultContentBlockParam[] {
  return result.content.map((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: item.mimeType as 'image/jpeg' | 'image/png',
            data: item.data
          }
        }
  )
}

function firstLine(result: ToolResult): string {
  const text = result.content.find((c) => c.type === 'text')
  return text?.type === 'text' ? text.text.split('\n')[0].slice(0, 200) : ''
}

export function describeAnthropicError(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic did not accept the API key.'
  if (error instanceof Anthropic.PermissionDeniedError)
    return 'This API key is not allowed to use that model.'
  if (error instanceof Anthropic.NotFoundError) return 'Anthropic does not know that model. Pick another one.'
  if (error instanceof Anthropic.RateLimitError)
    return 'Anthropic is rate limiting this key. Wait a moment and try again.'
  if (error instanceof Anthropic.APIConnectionError)
    return 'Could not reach Anthropic. Check your internet connection.'
  if (error instanceof Anthropic.APIError) return error.message
  return null
}

export class AnthropicSession implements ProviderSession {
  private history: BetaMessageParam[] = []

  reset(): void {
    this.history = []
  }

  async run(ctx: TurnContext): Promise<void> {
    if (!ctx.apiKey) throw new Error('Add your Anthropic API key in the assistant settings.')
    const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl, maxRetries: 2 })

    const tools = AI_TOOLS.map((def) =>
      betaTool({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as { type: 'object' },
        eager_input_streaming: true,
        run: async (input, context) => {
          const callId = context?.toolUse.id ?? `${def.name}-${Date.now()}`
          ctx.emit({ type: 'tool-start', callId, name: def.name, title: def.title })
          // The tool layer checks every argument, so input the model got wrong comes back as an error result.
          const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
          const result = await ctx.callTool(def.name, args)
          ctx.emit({ type: 'tool-end', callId, ok: !result.isError, summary: firstLine(result) })
          if (result.isError) throw new RunnerToolError(toBlocks(result))
          return toBlocks(result)
        }
      })
    )

    const fallbacks = SUPPORTS_FALLBACKS.test(ctx.model)
    let runner = client.beta.messages.toolRunner(
      {
        model: ctx.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: ctx.system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: [...this.history, { role: 'user', content: ctx.userText }],
        stream: true,
        max_iterations: MAX_ITERATIONS,
        thread: false,
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      },
      { signal: ctx.signal }
    )

    let finalContent: BetaContentBlock[] | null = null
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          for await (const stream of runner) {
            stream.on('text', (delta) => ctx.emit({ type: 'text', text: delta }))
            const message = await stream.finalMessage()
            attempt = 0
            finalContent = message.content
            const hasToolUse = message.content.some((b) => b.type === 'tool_use')
            if (message.stop_reason === 'max_tokens' && hasToolUse) {
              throw new TruncatedToolInput(
                'The reply was cut off in the middle of an edit. Try a smaller request.'
              )
            }
            if (message.stop_reason === 'refusal') {
              ctx.emit({ type: 'notice', message: 'Claude declined this request.' })
              break
            }
          }
          break
        } catch (error) {
          if (
            error instanceof Anthropic.APIError ||
            error instanceof TruncatedToolInput ||
            ctx.signal.aborted ||
            attempt >= MAX_JSON_RETRIES
          ) {
            throw error
          }
          // The model wrote a tool call that could not be read. Ask again from the same point.
          runner = client.beta.messages.toolRunner({ ...runner.params }, { signal: ctx.signal })
        }
      }
    } finally {
      // Keep everything that completed, so the next message continues the same conversation.
      const messages = [...runner.params.messages]
      const last = messages[messages.length - 1]
      if (finalContent && last?.role !== 'assistant')
        messages.push({ role: 'assistant', content: finalContent })
      this.history = settle(messages)
    }
  }
}

/**
 * The conversation has to end on a finished assistant turn before the next user message. After a
 * stop or an error, drop a reply whose tool calls never ran, note where it stopped if tools did
 * run, and drop a message that never got a reply.
 */
function settle(messages: BetaMessageParam[]): BetaMessageParam[] {
  const out = [...messages]
  const hasBlock = (m: BetaMessageParam | undefined, type: string) =>
    Array.isArray(m?.content) && m.content.some((b) => b.type === type)
  if (out[out.length - 1]?.role === 'assistant' && hasBlock(out[out.length - 1], 'tool_use')) out.pop()
  const tail = out[out.length - 1]
  if (tail?.role === 'user') {
    if (hasBlock(tail, 'tool_result')) out.push({ role: 'assistant', content: 'I stopped before finishing.' })
    else out.pop()
  }
  return out
}

export async function listAnthropicModels(apiKey: string, baseUrl: string): Promise<ModelChoice[]> {
  const client = new Anthropic({ apiKey, baseURL: baseUrl, maxRetries: 1 })
  const models: ModelChoice[] = []
  for await (const model of client.models.list({ limit: 100 })) {
    models.push({ id: model.id, name: model.display_name || model.id })
  }
  return models
}
