import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolResult } from '@shared/ai-tools'
import { AnthropicSession } from './anthropic'
import { OpenAiSession } from './openai'
import type { TurnContext } from './types'

/* Both adapters against small local servers that speak each API's streaming format. */

type Handler = (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => void

let server: Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

async function serve(handler: Handler): Promise<{ url: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      requests.push(body)
      handler(body, res, req)
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests }
}

function sse(res: ServerResponse, events: Array<[string | null, unknown]>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const [name, data] of events) {
    res.write(
      `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
    )
  }
  res.end()
}

function context(url: string, overrides: Partial<TurnContext> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const events: Array<Record<string, unknown>> = []
  const ctx: TurnContext = {
    apiKey: 'test-key',
    baseUrl: url,
    model: 'test-model',
    system: 'You edit videos.',
    userText: 'What is in my project?',
    signal: new AbortController().signal,
    callTool: async (name, args): Promise<ToolResult> => {
      calls.push({ name, args })
      return {
        content: [
          { type: 'text', text: 'The open project: "Trip".' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }
        ]
      }
    },
    emit: (event) => events.push(event as Record<string, unknown>),
    ...overrides
  }
  return { ctx, calls, events }
}

/* Anthropic */

function anthropicMessage(
  id: string,
  blocks: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >,
  stopReason: string
): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 }
        }
      }
    ]
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
      ])
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }
      ])
    } else {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
        }
      ])
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        }
      ])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 }
    }
  ])
  events.push(['message_stop', { type: 'message_stop' }])
  return events
}

describe('AnthropicSession', () => {
  it('runs tools through Kificut and keeps the conversation', async () => {
    let turn = 0
    const { url, requests } = await serve((_body, res) => {
      turn++
      if (turn === 1) {
        sse(
          res,
          anthropicMessage(
            'msg_1',
            [
              { type: 'text', text: 'Let me look.' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_project', input: {} }
            ],
            'tool_use'
          )
        )
      } else {
        sse(res, anthropicMessage(`msg_${turn}`, [{ type: 'text', text: 'It has one clip.' }], 'end_turn'))
      }
    })
    const session = new AnthropicSession()
    const { ctx, calls, events } = context(url, { model: 'claude-opus-5-5' })
    await session.run(ctx)

    expect(calls).toEqual([{ name: 'get_project', args: {} }])
    const text = events.filter((e) => e.type === 'text').map((e) => e.text)
    expect(text.join('')).toBe('Let me look.It has one clip.')
    expect(events.find((e) => e.type === 'tool-start')).toMatchObject({
      callId: 'toolu_1',
      name: 'get_project'
    })
    expect(events.find((e) => e.type === 'tool-end')).toMatchObject({
      ok: true,
      summary: 'The open project: "Trip".'
    })

    // The first request carries the tools, the cached system prompt and the default refusal fallback.
    const first = requests[0]
    expect((first.tools as unknown[]).length).toBeGreaterThan(20)
    expect((first.tools as Array<Record<string, unknown>>)[0].eager_input_streaming).toBe(true)
    expect(first.system).toEqual([
      { type: 'text', text: 'You edit videos.', cache_control: { type: 'ephemeral' } }
    ])
    expect(first.fallbacks).toBe('default')
    expect(first.stream).toBe(true)

    // The second request answers the tool call with text and the image.
    const second = requests[1].messages as Array<{ role: string; content: unknown }>
    const results = second[second.length - 1].content as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(JSON.stringify(results[0].content)).toContain('"type":"image"')

    // A follow-up message continues the same conversation.
    await session.run({ ...ctx, userText: 'Thanks' })
    const third = requests[2].messages as Array<{ role: string; content: unknown }>
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(third[4].content).toBe('Thanks')
  })

  it('reports tool errors to Claude as errors', async () => {
    let turn = 0
    const { url, requests } = await serve((_body, res) => {
      turn++
      sse(
        res,
        turn === 1
          ? anthropicMessage(
              'm1',
              [{ type: 'tool_use', id: 'toolu_9', name: 'delete_clips', input: { clip_ids: ['x'] } }],
              'tool_use'
            )
          : anthropicMessage('m2', [{ type: 'text', text: 'That clip does not exist.' }], 'end_turn')
      )
    })
    const { ctx, events } = context(url, {
      model: 'claude-haiku-5-5',
      callTool: async () => ({ content: [{ type: 'text', text: 'No clip with id x.' }], isError: true })
    })
    await new AnthropicSession().run(ctx)
    const results = (requests[1].messages as Array<{ content: Array<Record<string, unknown>> }>).at(
      -1
    )!.content
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true })
    expect(events.find((e) => e.type === 'tool-end')).toMatchObject({ ok: false })
    // Haiku has no server side fallback.
    expect(requests[0].fallbacks).toBeUndefined()
  })

  it('surfaces a rejected key as an API error', async () => {
    const { url } = await serve((_body, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' }
        })
      )
    })
    const { ctx } = context(url)
    await expect(new AnthropicSession().run(ctx)).rejects.toMatchObject({ status: 401 })
  })
})

/* OpenAI compatible */

function openAiChunks(parts: Array<Record<string, unknown>>, finish: string): Array<[null, unknown]> {
  const chunks: Array<[null, unknown]> = parts.map((delta) => [
    null,
    { choices: [{ index: 0, delta, finish_reason: null }] }
  ])
  chunks.push([null, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }])
  chunks.push([null, '[DONE]'])
  return chunks
}

describe('OpenAiSession', () => {
  it('streams text, runs tool calls split over chunks, and keeps the conversation', async () => {
    let turn = 0
    const { url, requests } = await serve((_body, res, req) => {
      expect(req.url).toBe('/v1/chat/completions')
      expect(req.headers.authorization).toBe('Bearer test-key')
      turn++
      if (turn === 1) {
        sse(
          res,
          openAiChunks(
            [
              { role: 'assistant', content: 'Checking. ' },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'view_frame', arguments: '{"ti' }
                  }
                ]
              },
              { tool_calls: [{ index: 0, function: { arguments: 'me": 2}' } }] }
            ],
            'tool_calls'
          )
        )
      } else {
        sse(res, openAiChunks([{ content: 'Looks good.' }], 'stop'))
      }
    })
    const session = new OpenAiSession()
    const { ctx, calls, events } = context(`${url}/v1`)
    await session.run(ctx)

    expect(calls).toEqual([{ name: 'view_frame', args: { time: 2 } }])
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join('')
    ).toBe('Checking. Looks good.')

    const first = requests[0]
    expect(first.model).toBe('test-model')
    expect((first.messages as Array<{ role: string }>)[0]).toEqual({
      role: 'system',
      content: 'You edit videos.'
    })
    expect((first.tools as Array<{ type: string }>)[0].type).toBe('function')

    // Tool results go back as a tool message, the image as a user message after it.
    const second = requests[1].messages as Array<Record<string, unknown>>
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(second[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_a',
      content: 'The open project: "Trip".'
    })
    expect(JSON.stringify(second[4].content)).toContain('data:image/jpeg;base64,aGVsbG8=')

    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
  })

  it('answers unreadable tool arguments with an error instead of running the tool', async () => {
    let turn = 0
    const { url, requests } = await serve((_body, res) => {
      turn++
      sse(
        res,
        turn === 1
          ? openAiChunks(
              [
                {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'add_text', arguments: '{"text": "Hi' } }
                  ]
                }
              ],
              'tool_calls'
            )
          : openAiChunks([{ content: 'Retrying.' }], 'stop')
      )
    })
    const { ctx, calls } = context(url)
    await new OpenAiSession().run(ctx)
    expect(calls).toEqual([])
    const toolMessage = (requests[1].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'tool'
    )
    expect(JSON.parse(toolMessage!.content as string)).toEqual({ INVALID_JSON: '{"text": "Hi' })
  })

  it('drops images for models that reject them', async () => {
    let turn = 0
    const { url, requests } = await serve((body, res) => {
      turn++
      const hasImage = JSON.stringify(body.messages).includes('image_url')
      if (turn === 1) {
        sse(
          res,
          openAiChunks(
            [{ tool_calls: [{ index: 0, id: 'c1', function: { name: 'view_frame', arguments: '{}' } }] }],
            'tool_calls'
          )
        )
      } else if (hasImage) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'image input is not supported' } }))
      } else {
        sse(res, openAiChunks([{ content: 'Done.' }], 'stop'))
      }
    })
    const { ctx, events } = context(url)
    await new OpenAiSession().run(ctx)
    expect(requests).toHaveLength(3)
    expect(events.some((e) => e.type === 'notice')).toBe(true)
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join('')
    ).toBe('Done.')
  })

  it('explains a rejected key and an unreachable server', async () => {
    const { url } = await serve((_body, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }))
    })
    await expect(new OpenAiSession().run(context(url).ctx)).rejects.toThrow('did not accept the API key')
    await expect(new OpenAiSession().run(context('http://127.0.0.1:9').ctx)).rejects.toThrow(
      'Could not reach'
    )
  })

  it('keeps finished tool rounds when stopped', async () => {
    const controller = new AbortController()
    let turn = 0
    const { url } = await serve((_body, res) => {
      turn++
      if (turn === 1) {
        sse(
          res,
          openAiChunks(
            [{ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_project', arguments: '{}' } }] }],
            'tool_calls'
          )
        )
      } else {
        controller.abort()
        res.destroy()
      }
    })
    const session = new OpenAiSession()
    const { ctx } = context(url, { signal: controller.signal })
    await expect(session.run(ctx)).rejects.toThrow()
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(session.messages.at(-1)).toEqual({ role: 'assistant', content: 'I stopped before finishing.' })
  })
})
