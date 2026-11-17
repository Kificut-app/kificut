import { AI_TOOLS, type ToolResult } from '@shared/ai-tools'
import type { ModelChoice, ProviderSession, TurnContext } from './types'

/*
 * Any provider with an OpenAI style chat completions API: OpenAI, Gemini, OpenRouter, Ollama,
 * LM Studio, vLLM and so on. Kificut runs the tool loop itself.
 */

const MAX_ROUNDS = 60

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  error?: { message?: string }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

const TOOLS = AI_TOOLS.map((def) => ({
  type: 'function' as const,
  function: { name: def.name, description: def.description, parameters: def.inputSchema }
}))

function headers(apiKey: string | null, baseUrl: string): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) result.Authorization = `Bearer ${apiKey}`
  if (baseUrl.startsWith('https://openrouter.ai/')) {
    // OpenRouter shows these on its app listings.
    result['HTTP-Referer'] = 'https://github.com/Kificut-app/kificut'
    result['X-Title'] = 'Kificut'
  }
  return result
}

async function failure(response: Response, baseUrl: string): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; message?: string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '')
  } catch {
    // Not JSON; the status says enough.
  }
  const status = response.status
  if (status === 401 || status === 403) {
    return new ProviderError(
      `The provider did not accept the API key.${detail ? ` (${detail})` : ''}`,
      status
    )
  }
  if (status === 404) {
    return new ProviderError(
      detail || `Nothing answered at ${baseUrl}. Check the address and the model name.`,
      status
    )
  }
  if (status === 429)
    return new ProviderError(detail || 'The provider is rate limiting this key. Try again soon.', status)
  return new ProviderError(detail || `The provider returned HTTP ${status}.`, status)
}

function unreachable(error: unknown, baseUrl: string): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  return new ProviderError(`Could not reach ${baseUrl}. Check the address, and that the server is running.`)
}

/** Reads a server sent events stream and returns the data of each event. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let end: number
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '')
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) yield data
    }
    if (done) {
      const rest = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (rest) yield rest
      return
    }
  }
}

function toolText(result: ToolResult): string {
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n')
  return text || (result.isError ? 'The tool failed.' : 'Done.')
}

function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || typeof m.content === 'string') return m
    const text = m.content.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : ''))
    return { role: 'user', content: `${text.join('\n')}\n(Images left out: this model cannot read them.)` }
  })
}

export class OpenAiSession implements ProviderSession {
  private history: ChatMessage[] = []
  private imagesUnsupported = false

  reset(): void {
    this.history = []
    this.imagesUnsupported = false
  }

  /** The conversation so far, for tests. */
  get messages(): readonly ChatMessage[] {
    return this.history
  }

  private async complete(
    ctx: TurnContext,
    messages: ChatMessage[]
  ): Promise<{ text: string; toolCalls: ToolCall[]; finish: string | null }> {
    let response: Response
    try {
      response = await fetch(`${ctx.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(ctx.apiKey, ctx.baseUrl),
        body: JSON.stringify({
          model: ctx.model,
          messages: [{ role: 'system', content: ctx.system }, ...messages],
          tools: TOOLS,
          stream: true
        }),
        signal: ctx.signal
      })
    } catch (error) {
      throw unreachable(error, ctx.baseUrl)
    }
    if (!response.ok || !response.body) throw await failure(response, ctx.baseUrl)

    let text = ''
    let finish: string | null = null
    const calls = new Map<number, ToolCall>()
    let lastIndex = -1
    for await (const data of events(response.body)) {
      if (data === '[DONE]') break
      let chunk: StreamChunk
      try {
        chunk = JSON.parse(data) as StreamChunk
      } catch {
        continue
      }
      if (chunk.error) throw new ProviderError(chunk.error.message ?? 'The provider reported an error.')
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta
      if (delta?.content) {
        text += delta.content
        ctx.emit({ type: 'text', text: delta.content })
      }
      for (const part of delta?.tool_calls ?? []) {
        // Some servers leave out the index when they send each call whole.
        const index = part.index ?? (part.id ? lastIndex + 1 : Math.max(lastIndex, 0))
        lastIndex = Math.max(lastIndex, index)
        const call = calls.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' }
        }
        if (part.id) call.id = part.id
        if (part.function?.name) call.function.name += part.function.name
        if (part.function?.arguments) call.function.arguments += part.function.arguments
        calls.set(index, call)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${Date.now()}_${index}` }))
      .filter((call) => call.function.name)
    return { text, toolCalls, finish }
  }

  async run(ctx: TurnContext): Promise<void> {
    if (!ctx.baseUrl) throw new ProviderError('Enter the address of the server in the assistant settings.')
    if (!ctx.model) throw new ProviderError('Choose a model in the assistant settings.')

    const turn: ChatMessage[] = [{ role: 'user', content: ctx.userText }]
    /** How much of the turn is complete: the user message plus finished tool rounds. */
    let committed = 1
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let reply: Awaited<ReturnType<OpenAiSession['complete']>>
        const messages = [...this.history, ...turn]
        try {
          reply = await this.complete(ctx, this.imagesUnsupported ? withoutImages(messages) : messages)
        } catch (error) {
          const hasImages = messages.some((m) => m.role === 'user' && Array.isArray(m.content))
          if (
            !(error instanceof ProviderError) ||
            error.status !== 400 ||
            !hasImages ||
            this.imagesUnsupported
          ) {
            throw error
          }
          // Probably a model that cannot see images. Send the same request without them.
          this.imagesUnsupported = true
          ctx.emit({
            type: 'notice',
            message: 'This model cannot see images, so frames are sent as text only.'
          })
          reply = await this.complete(ctx, withoutImages(messages))
        }

        turn.push({
          role: 'assistant',
          content: reply.text || null,
          ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {})
        })
        if (reply.toolCalls.length === 0) {
          committed = turn.length
          return
        }
        if (reply.finish === 'length') {
          throw new ProviderError('The reply was cut off in the middle of an edit. Try a smaller request.')
        }

        const images: ContentPart[] = []
        for (const call of reply.toolCalls) {
          ctx.emit({
            type: 'tool-start',
            callId: call.id,
            name: call.function.name,
            title: call.function.name
          })
          let args: Record<string, unknown>
          try {
            const parsed: unknown = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {}
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('not an object')
            args = parsed as Record<string, unknown>
          } catch {
            turn.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ INVALID_JSON: call.function.arguments })
            })
            ctx.emit({
              type: 'tool-end',
              callId: call.id,
              ok: false,
              summary: 'The arguments were not valid JSON.'
            })
            continue
          }
          const result = await ctx.callTool(call.function.name, args)
          const text = toolText(result)
          turn.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.isError ? `Error: ${text}` : text
          })
          ctx.emit({
            type: 'tool-end',
            callId: call.id,
            ok: !result.isError,
            summary: text.split('\n')[0].slice(0, 200)
          })
          for (const item of result.content) {
            if (item.type === 'image') {
              images.push({
                type: 'image_url',
                image_url: { url: `data:${item.mimeType};base64,${item.data}` }
              })
            }
          }
        }
        // Tool messages can only hold text, so images from the tools follow as a user message.
        if (images.length) {
          turn.push({
            role: 'user',
            content: [{ type: 'text', text: 'Images returned by the tools above:' }, ...images]
          })
        }
        committed = turn.length
      }
      ctx.emit({ type: 'notice', message: 'Stopped after many steps. Send another message to continue.' })
      turn.push({ role: 'assistant', content: 'I stopped after many steps.' })
      committed = turn.length
    } finally {
      // Keep the finished part of the turn so the conversation can continue from it.
      const kept = turn.slice(0, committed)
      if (kept.length > 1) {
        const last = kept[kept.length - 1]
        if (last.role !== 'assistant' || last.tool_calls)
          kept.push({ role: 'assistant', content: 'I stopped before finishing.' })
        this.history.push(...kept)
      }
    }
  }
}

const NOT_CHAT =
  /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search|davinci|babbage|rerank/i

export async function listOpenAiModels(baseUrl: string, apiKey: string | null): Promise<ModelChoice[]> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: headers(apiKey, baseUrl),
      signal: AbortSignal.timeout(15000)
    })
  } catch (error) {
    throw unreachable(error, baseUrl)
  }
  if (!response.ok) throw await failure(response, baseUrl)
  const body = (await response.json()) as { data?: Array<{ id: string; name?: string }> }
  return (body.data ?? [])
    .map((m) => ({ id: m.id.replace(/^models\//, ''), name: m.name || m.id.replace(/^models\//, '') }))
    .filter((m) => !NOT_CHAT.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
}
