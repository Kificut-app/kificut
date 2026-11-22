import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GenerationRequest } from '@shared/generation'
import type { Adapter, RunContext } from './types'

/* The three generation services against small local servers that follow their documented APIs. */

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => void
const routes: Route[] = []
const seen: Array<{ method: string; url: string; body: string; headers: IncomingMessage['headers'] }> = []
let server: Server
let base = ''
let google: Adapter
let fal: Adapter
let comfyui: Adapter
let falModule: typeof import('./fal')
let comfyModule: typeof import('./comfyui')

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('latin1')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body, headers: req.headers })
      for (const route of routes) {
        if (!res.writableEnded) route(req, body, res)
      }
      if (!res.writableEnded) json(res, 404, { error: { message: `No route for ${req.method} ${req.url}` } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.KIFICUT_GOOGLE_API = `${base}/google`
  process.env.KIFICUT_FAL_QUEUE = `${base}/queue`
  process.env.KIFICUT_FAL_SCHEMA = `${base}/openapi`
  process.env.KIFICUT_FAL_API = `${base}/falapi`
  google = (await import('./google')).google
  falModule = await import('./fal')
  fal = falModule.fal
  comfyModule = await import('./comfyui')
  comfyui = comfyModule.comfyui
})

afterAll(() => server.close())

function ctx(overrides: Partial<RunContext> = {}): RunContext & { messages: string[] } {
  const messages: string[] = []
  return {
    fetch: (url, init) => fetch(url, init),
    signal: new AbortController().signal,
    apiKey: 'test-key',
    progress: (message) => messages.push(message),
    messages,
    ...overrides
  }
}

const request = (overrides: Partial<GenerationRequest>): GenerationRequest => ({
  kind: 'video',
  service: 'google',
  model: 'gemini-omni-1.2-flash',
  prompt: 'A lighthouse at dusk, waves crashing',
  duration: 8,
  aspect: '16:9',
  resolution: '720p',
  ...overrides
})

describe('Google', () => {
  it('generates a scene, waits for the file and downloads it with the key', async () => {
    let checks = 0
    routes.length = 0
    routes.push((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/google/v1beta/interactions') {
        json(res, 200, {
          id: 'int-1',
          status: 'completed',
          steps: [
            { type: 'user_input', content: [{ type: 'text', text: 'ignored' }] },
            {
              type: 'model_output',
              content: [
                {
                  type: 'video',
                  mime_type: 'video/mp4',
                  uri: `${base}/google/v1beta/files/vid42:download?alt=media`
                }
              ]
            }
          ]
        })
      } else if (req.url === '/google/v1beta/files/vid42') {
        json(res, 200, { state: ++checks < 2 ? 'PROCESSING' : 'ACTIVE' })
      }
    })
    const c = ctx()
    const result = await google.run(
      request({ startImage: { data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' } }),
      c
    )
    expect(result.url).toBe(`${base}/google/v1beta/files/vid42:download?alt=media`)
    expect(result.headers).toEqual({ 'x-goog-api-key': 'test-key' })
    expect(result.extension).toBe('.mp4')
    const sent = seen.find((s) => s.url === '/google/v1beta/interactions')!
    expect(sent.headers['x-goog-api-key']).toBe('test-key')
    const body = JSON.parse(sent.body)
    expect(body.model).toBe('gemini-omni-1.2-flash')
    expect(body.response_format).toEqual({
      type: 'video',
      aspect_ratio: '16:9',
      resolution: '720p',
      duration: '8s',
      delivery: 'uri'
    })
    expect(body.input[0]).toEqual({
      type: 'image',
      data: Buffer.from('jpeg').toString('base64'),
      mime_type: 'image/jpeg'
    })
    expect(body.input[1]).toEqual({ type: 'text', text: 'A lighthouse at dusk, waves crashing' })
    expect(checks).toBe(2)
  })

  it('draws a picture returned inline', async () => {
    routes.length = 0
    seen.length = 0
    routes.push((req, _body, res) => {
      if (req.url === '/google/v1beta/interactions') {
        json(res, 200, {
          id: 'int-2',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                { type: 'image', mime_type: 'image/png', data: Buffer.from('png!').toString('base64') }
              ]
            }
          ]
        })
      }
    })
    const result = await google.run(
      request({ kind: 'image', model: 'gemini-nano-banana-2.1', aspect: '9:16' }),
      ctx()
    )
    expect(Buffer.from(result.data!).toString()).toBe('png!')
    const body = JSON.parse(seen[0].body)
    expect(body.response_format).toMatchObject({ type: 'image', aspect_ratio: '9:16' })
    expect(seen[0].headers['api-revision']).toBe('2026-05-20')
  })

  it('passes on what Google said went wrong', async () => {
    routes.length = 0
    routes.push((req, _body, res) => {
      if (req.url === '/google/v1beta/interactions')
        json(res, 400, { error: { message: 'Prompt was blocked.' } })
    })
    await expect(google.run(request({}), ctx())).rejects.toThrow('Prompt was blocked.')
    await expect(google.run(request({}), ctx({ apiKey: null }))).rejects.toThrow('Gemini API key')
  })

  it('estimates the cost from the length and resolution', async () => {
    expect(await google.estimate(request({ duration: 10 }), ctx())).toBe(
      'about $0.70 on Google ($0.07 a second)'
    )
    expect(
      await google.estimate(request({ kind: 'image', model: 'gemini-nano-banana-2.1' }), ctx())
    ).toContain('per picture')
  })
})

const KLING_SCHEMA = {
  components: {
    schemas: {
      KlingTextToVideoInput: {
        properties: {
          prompt: { type: 'string' },
          duration: { type: 'string', enum: ['3', '5', '10', '15'] },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] }
        }
      },
      KlingElementInput: { properties: { frontal_image_url: { type: 'string' } } },
      KlingTextToVideoOutput: { properties: { video: { $ref: '#/components/schemas/File' } } }
    }
  }
}
const KLING_I2V_SCHEMA = {
  components: {
    schemas: {
      KlingImageToVideoInput: {
        properties: {
          prompt: { type: 'string' },
          start_image_url: { type: 'string' },
          duration: { type: 'string', enum: ['5', '10'] }
        }
      },
      KlingImageToVideoOutput: { properties: { video: {} } }
    }
  }
}
const FLUX_SCHEMA = {
  components: {
    schemas: {
      FluxInput: {
        properties: {
          prompt: { type: 'string' },
          image_size: { anyOf: [{ enum: ['square_hd', 'landscape_16_9'] }] }
        }
      },
      FluxOutput: { properties: { images: { type: 'array' } } }
    }
  }
}

describe('fal.ai', () => {
  it('reads what a model accepts from its schema', async () => {
    routes.length = 0
    routes.push((req, _body, res) => {
      const id = new URL(req.url!, base).searchParams.get('endpoint_id')
      if (req.url!.startsWith('/openapi')) {
        if (id === 'fal-ai/kling/text-to-video') json(res, 200, KLING_SCHEMA)
        else if (id === 'fal-ai/kling/image-to-video') json(res, 200, KLING_I2V_SCHEMA)
        else if (id === 'fal-ai/flux/schnell') json(res, 200, FLUX_SCHEMA)
        else json(res, 404, {})
      }
    })
    const c = ctx()
    expect(await fal.capabilities('fal-ai/kling/text-to-video', c)).toEqual({
      kind: 'video',
      durations: [3, 5, 10, 15],
      aspects: ['16:9', '9:16', '1:1'],
      resolutions: [],
      startImage: true
    })
    expect(await fal.capabilities('fal-ai/flux/schnell', c)).toMatchObject({
      kind: 'image',
      startImage: false
    })
    await expect(fal.capabilities('fal-ai/does-not-exist', c)).rejects.toThrow('no model called')
  })

  it('queues a scene, follows its status and returns the video', async () => {
    let polls = 0
    seen.length = 0
    routes.length = 0
    routes.push((req, _body, res) => {
      const id = new URL(req.url!, base).searchParams.get('endpoint_id')
      if (req.url!.startsWith('/openapi')) {
        if (id === 'fal-ai/kling/text-to-video') json(res, 200, KLING_SCHEMA)
        else if (id === 'fal-ai/kling/image-to-video') json(res, 200, KLING_I2V_SCHEMA)
        else json(res, 404, {})
      } else if (req.method === 'POST' && req.url!.startsWith('/queue/fal-ai/kling/')) {
        json(res, 200, {
          request_id: 'r1',
          status_url: `${base}/queue/fal-ai/kling/requests/r1/status`,
          response_url: `${base}/queue/fal-ai/kling/requests/r1`,
          cancel_url: `${base}/queue/fal-ai/kling/requests/r1/cancel`
        })
      } else if (req.url === '/queue/fal-ai/kling/requests/r1/status') {
        polls++
        json(
          res,
          200,
          polls === 1
            ? { status: 'IN_QUEUE', queue_position: 2 }
            : polls === 2
              ? { status: 'IN_PROGRESS' }
              : { status: 'COMPLETED' }
        )
      } else if (req.url === '/queue/fal-ai/kling/requests/r1') {
        json(res, 200, { video: { url: `${base}/files/out.mp4`, content_type: 'video/mp4' } })
      }
    })
    const c = ctx()
    const result = await fal.run(
      request({
        service: 'fal',
        model: 'fal-ai/kling/text-to-video',
        duration: 6,
        aspect: '9:16',
        startImage: { data: 'QUJD', mimeType: 'image/png' }
      }),
      c
    )
    expect(result).toEqual({ url: `${base}/files/out.mp4`, extension: '.mp4' })
    // With a starting picture, the image-to-video sibling is used.
    const submit = seen.find((s) => s.method === 'POST')!
    expect(submit.url).toBe('/queue/fal-ai/kling/image-to-video')
    expect(submit.headers.authorization).toBe('Key test-key')
    expect(JSON.parse(submit.body)).toEqual({
      prompt: 'A lighthouse at dusk, waves crashing',
      duration: '5',
      start_image_url: 'data:image/png;base64,QUJD'
    })
    expect(c.messages).toContain("Waiting in fal.ai's queue (position 3)")
    expect(c.messages).toContain('Generating on fal.ai')
  })

  it('maps the aspect ratio to image sizes for picture models', () => {
    const input = falModule.buildInput(
      request({ kind: 'image', service: 'fal', model: 'x', aspect: '9:16' }),
      {
        input: FLUX_SCHEMA.components.schemas.FluxInput.properties as never,
        output: {}
      }
    )
    expect(input).toEqual({ prompt: 'A lighthouse at dusk, waves crashing', image_size: 'portrait_16_9' })
    expect(falModule.resultUrl({ images: [{ url: 'https://x/y.png', content_type: 'image/png' }] })).toEqual({
      url: 'https://x/y.png',
      contentType: 'image/png'
    })
  })

  it('estimates from fal.ai pricing', async () => {
    routes.length = 0
    routes.push((req, _body, res) => {
      if (req.url!.startsWith('/falapi/models/pricing')) {
        json(res, 200, { prices: [{ endpoint_id: 'm', unit_price: 0.084, unit: 'second', currency: 'USD' }] })
      }
    })
    expect(await fal.estimate(request({ service: 'fal', model: 'm', duration: 10 }), ctx())).toBe(
      'about $0.84 on fal.ai ($0.084 a second)'
    )
  })
})

describe('ComfyUI', () => {
  it('fills placeholders, keeping numbers as numbers', () => {
    const filled = comfyModule.fillWorkflow(
      JSON.stringify({
        '1': {
          inputs: {
            text: 'A {{prompt}}, cinematic',
            width: '{{width}}',
            seed: '{{seed}}',
            other: '{{unknown}}'
          }
        }
      }),
      { prompt: 'cat', width: 1280, seed: 7 }
    )
    expect(filled).toEqual({
      '1': { inputs: { text: 'A cat, cinematic', width: 1280, seed: 7, other: '{{unknown}}' } }
    })
    expect(comfyModule.frameCount(5)).toBe(121)
    expect(comfyModule.frameCount(5) % 8).toBe(1)
  })

  it('picks the saved video from the outputs', () => {
    const file = comfyModule.pickOutput(
      {
        '8': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
        '9': { images: [{ filename: 'Wan_00001.mp4', subfolder: 'video', type: 'output' }], animated: [true] }
      },
      'video'
    )
    expect(file).toEqual({ filename: 'Wan_00001.mp4', subfolder: 'video', type: 'output' })
  })

  it('uploads the picture, queues the workflow and returns the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kificut-comfy-'))
    const workflow = join(dir, 'wan.json')
    writeFileSync(
      workflow,
      JSON.stringify({
        '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
        '20': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
        '40': {
          class_type: 'EmptyLatentVideo',
          inputs: { width: '{{width}}', height: '{{height}}', length: '{{frames}}' }
        }
      })
    )
    let polls = 0
    seen.length = 0
    routes.length = 0
    routes.push((req, _body, res) => {
      if (req.url === '/comfy/upload/image')
        json(res, 200, { name: 'kificut-start.jpg', subfolder: '', type: 'input' })
      else if (req.url === '/comfy/prompt') json(res, 200, { prompt_id: 'p1', number: 1 })
      else if (req.url === '/comfy/history/p1') {
        polls++
        json(
          res,
          200,
          polls < 2
            ? {}
            : {
                p1: {
                  outputs: {
                    '50': { images: [{ filename: 'out_00001.mp4', subfolder: '', type: 'output' }] }
                  },
                  status: { status_str: 'success', completed: true }
                }
              }
        )
      }
    })
    const result = await comfyui.run(
      request({
        service: 'comfyui',
        model: 'video',
        aspect: '9:16',
        duration: 5,
        startImage: { data: 'QUJD', mimeType: 'image/jpeg' }
      }),
      ctx({ apiKey: null, comfyui: { url: `${base}/comfy`, videoWorkflow: workflow, imageWorkflow: '' } })
    )
    expect(result).toEqual({
      url: `${base}/comfy/view?filename=out_00001.mp4&subfolder=&type=output`,
      extension: '.mp4'
    })
    const queued = JSON.parse(seen.find((s) => s.url === '/comfy/prompt')!.body)
    expect(queued.prompt['6'].inputs.text).toBe('A lighthouse at dusk, waves crashing')
    expect(queued.prompt['20'].inputs.image).toBe('kificut-start.jpg')
    expect(queued.prompt['40'].inputs).toEqual({ width: 720, height: 1280, length: 121 })
    expect(seen.some((s) => s.url === '/comfy/upload/image' && s.body.includes('kificut-start.jpg'))).toBe(
      true
    )
  })

  it('reports errors from the workflow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kificut-comfy-'))
    const workflow = join(dir, 'image.json')
    writeFileSync(workflow, JSON.stringify({ '6': { inputs: { text: '{{prompt}}' } } }))
    routes.length = 0
    routes.push((req, _body, res) => {
      if (req.url === '/comfy/prompt') json(res, 200, { prompt_id: 'p2' })
      else if (req.url === '/comfy/history/p2') {
        json(res, 200, {
          p2: {
            status: {
              status_str: 'error',
              messages: [['execution_error', { exception_message: 'Out of memory' }]]
            }
          }
        })
      }
    })
    await expect(
      comfyui.run(
        request({ kind: 'image', service: 'comfyui', model: 'image' }),
        ctx({ apiKey: null, comfyui: { url: `${base}/comfy`, videoWorkflow: '', imageWorkflow: workflow } })
      )
    ).rejects.toThrow('ComfyUI stopped with an error: Out of memory')
  })
})
