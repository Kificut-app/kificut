import {
  GOOGLE_IMAGE_MODEL,
  type AspectRatio,
  type GenerationRequest,
  type ModelCapabilities
} from '@shared/generation'
import {
  failure,
  money,
  ServiceError,
  sleep,
  type Adapter,
  type GeneratedFile,
  type RunContext
} from './types'

/*
 * Google's Interactions API: Gemini Omni Flash makes video with sound, Nano Banana makes
 * pictures. A request returns when the result is ready; video comes back as a file to download.
 */

const BASE = process.env.KIFICUT_GOOGLE_API || 'https://generativelanguage.googleapis.com'

/** Approximate price per second of video by resolution, from Google's pricing page (November 2026). */
const VIDEO_PRICE: Record<string, number> = { '360p': 0.023, '720p': 0.07, '1080p': 0.104, '4k': 0.209 }
const IMAGE_PRICE = 0.0336

function isImageModel(model: string): boolean {
  return /image|banana/i.test(model)
}

interface ContentPart {
  type: string
  data?: string
  uri?: string
  mime_type?: string
  text?: string
}

interface Interaction {
  id?: string
  status?: string
  steps?: Array<{ type?: string; content?: ContentPart[] }>
  /** Google documents these as SDK only, but one of its REST examples reads them; accepted too. */
  output_video?: ContentPart
  output_image?: ContentPart
  error?: { message?: string }
}

function headers(ctx: RunContext, extra: Record<string, string> = {}): Record<string, string> {
  if (!ctx.apiKey) throw new ServiceError('Add your Gemini API key in AI > Generation.')
  return { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey, ...extra }
}

function input(request: GenerationRequest): ContentPart[] {
  const parts: ContentPart[] = []
  if (request.startImage) {
    parts.push({ type: 'image', data: request.startImage.data, mime_type: request.startImage.mimeType })
  }
  parts.push({ type: 'text', text: request.prompt })
  return parts
}

/** The first generated part of a kind in the interaction's model output. */
function output(interaction: Interaction, kind: 'video' | 'image'): ContentPart | null {
  const direct = kind === 'video' ? interaction.output_video : interaction.output_image
  if (direct && (direct.data || direct.uri)) return direct
  for (const step of interaction.steps ?? []) {
    if (step.type && step.type !== 'model_output') continue
    const found = step.content?.find((part) => part.type === kind && (part.data || part.uri))
    if (found) return found
  }
  return null
}

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

async function create(
  body: unknown,
  ctx: RunContext,
  extraHeaders: Record<string, string> = {}
): Promise<Interaction> {
  const response = await ctx.fetch(`${BASE}/v1beta/interactions`, {
    method: 'POST',
    headers: headers(ctx, extraHeaders),
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  if (!response.ok) throw await failure(response, 'Google')
  const interaction = (await response.json()) as Interaction
  if (interaction.status && interaction.status !== 'completed') {
    throw new ServiceError(interaction.error?.message || `Google could not make it (${interaction.status}).`)
  }
  return interaction
}

/** Waits until a delivered file can be downloaded, then returns its download address. */
async function readyFile(uri: string, ctx: RunContext): Promise<string> {
  const id = /\/files\/([^:/?]+)/.exec(uri)?.[1]
  if (!id) return uri
  for (let attempt = 0; attempt < 240; attempt++) {
    const response = await ctx.fetch(`${BASE}/v1beta/files/${id}`, {
      headers: headers(ctx),
      signal: ctx.signal
    })
    if (!response.ok) throw await failure(response, 'Google')
    const file = (await response.json()) as { state?: string; error?: { message?: string } }
    if (!file.state || file.state === 'ACTIVE') break
    if (file.state === 'FAILED')
      throw new ServiceError(file.error?.message || 'Google could not prepare the video.')
    ctx.progress('Preparing the video for download')
    await sleep(2500, ctx.signal)
  }
  return `${BASE}/v1beta/files/${id}:download?alt=media`
}

export const google: Adapter = {
  async capabilities(model: string): Promise<ModelCapabilities> {
    if (isImageModel(model)) {
      return {
        kind: 'image',
        durations: [],
        aspects: ['16:9', '9:16', '1:1'],
        resolutions: [],
        startImage: true
      }
    }
    return {
      kind: 'video',
      durations: Array.from({ length: 13 }, (_, i) => i + 3),
      aspects: ['16:9', '9:16'] as AspectRatio[],
      resolutions: ['360p', '720p', '1080p', '4k'],
      startImage: true
    }
  },

  async estimate(request) {
    if (request.kind === 'image') return `about ${money(IMAGE_PRICE)} per picture on Google`
    const perSecond = VIDEO_PRICE[request.resolution ?? '720p'] ?? VIDEO_PRICE['720p']
    return `about ${money(perSecond * request.duration)} on Google (${money(perSecond)} a second)`
  },

  async run(request, ctx): Promise<GeneratedFile> {
    if (request.kind === 'image') {
      ctx.progress('Drawing the picture')
      const interaction = await create(
        {
          model: request.model || GOOGLE_IMAGE_MODEL,
          input: input(request),
          response_format: {
            type: 'image',
            mime_type: 'image/png',
            aspect_ratio: request.aspect,
            image_size: '1K'
          }
        },
        ctx,
        { 'Api-Revision': '2026-05-20' }
      )
      const image = output(interaction, 'image')
      if (!image?.data)
        throw new ServiceError('Google did not return a picture. Try describing it differently.')
      return { data: decode(image.data), extension: image.mime_type === 'image/jpeg' ? '.jpg' : '.png' }
    }

    ctx.progress('Generating the scene. This usually takes a minute or two.')
    const interaction = await create(
      {
        model: request.model,
        input: input(request),
        response_format: {
          type: 'video',
          aspect_ratio: request.aspect === '9:16' ? '9:16' : '16:9',
          resolution: request.resolution ?? '720p',
          duration: `${Math.round(request.duration)}s`,
          delivery: 'uri'
        }
      },
      ctx
    )
    const video = output(interaction, 'video')
    if (!video) throw new ServiceError('Google did not return a video. Try describing the scene differently.')
    if (video.data) return { data: decode(video.data), extension: '.mp4' }
    const url = await readyFile(video.uri!, ctx)
    return { url, headers: { 'x-goog-api-key': ctx.apiKey! }, extension: '.mp4' }
  }
}
