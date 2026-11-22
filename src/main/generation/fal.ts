import { nearest, type AspectRatio, type GenerationRequest, type ModelCapabilities } from '@shared/generation'
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
 * fal.ai's queue API. Models differ in what they accept, so Kificut reads each model's published
 * OpenAPI schema and only sends the fields it has. Any fal.ai endpoint id works, including models
 * released after this was written.
 */

const QUEUE = process.env.KIFICUT_FAL_QUEUE || 'https://queue.fal.run'
const SCHEMA = process.env.KIFICUT_FAL_SCHEMA || 'https://fal.ai/api/openapi/queue/openapi.json'
const API = process.env.KIFICUT_FAL_API || 'https://api.fal.ai/v1'

interface Property {
  type?: string
  enum?: Array<string | number>
  anyOf?: Property[]
  minimum?: number
  maximum?: number
  default?: unknown
}

interface ModelSchema {
  input: Record<string, Property>
  output: Record<string, Property>
}

const schemas = new Map<string, Promise<ModelSchema | null>>()

/** The model's input and output fields, or null when fal.ai does not know the endpoint. */
export function modelSchema(model: string, ctx: RunContext): Promise<ModelSchema | null> {
  let loading = schemas.get(model)
  if (!loading) {
    loading = (async () => {
      const response = await ctx.fetch(`${SCHEMA}?endpoint_id=${encodeURIComponent(model)}`, {
        signal: ctx.signal
      })
      if (response.status === 404 || response.status === 400) return null
      if (!response.ok) throw await failure(response, 'fal.ai')
      const doc = (await response.json()) as {
        components?: { schemas?: Record<string, { properties?: Record<string, Property> }> }
      }
      const all = Object.entries(doc.components?.schemas ?? {})
      // The model's own input has a prompt or an image; helper schemas (such as Kling's elements) do not.
      const input = all.find(
        ([name, s]) =>
          name.endsWith('Input') && s.properties && ('prompt' in s.properties || 'image_url' in s.properties)
      )
      const output = all.find(([name, s]) => name.endsWith('Output') && s.properties)
      if (!input || !output) return null
      return { input: input[1].properties!, output: output[1].properties! }
    })()
    loading.catch(() => schemas.delete(model))
    schemas.set(model, loading)
  }
  return loading
}

function enumOf(property?: Property): Array<string | number> {
  if (!property) return []
  if (property.enum) return property.enum
  for (const option of property.anyOf ?? []) if (option.enum) return option.enum
  return []
}

function rangeOf(property?: Property): { min: number; max: number } | null {
  if (!property) return null
  const options = [property, ...(property.anyOf ?? [])]
  const numeric = options.find((o) => o.type === 'integer' || o.type === 'number')
  if (!numeric) return null
  return { min: numeric.minimum ?? 1, max: numeric.maximum ?? 10 }
}

const IMAGE_FIELDS = ['start_image_url', 'image_url', 'first_frame_url', 'first_frame_image_url']
const SIZE_FOR: Record<AspectRatio, string> = {
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '1:1': 'square_hd'
}

function imageField(schema: ModelSchema): string | null {
  return IMAGE_FIELDS.find((field) => field in schema.input) ?? null
}

/** For a text-to-video model and a starting picture, its image-to-video sibling if fal.ai has one. */
async function endpointFor(
  request: GenerationRequest,
  ctx: RunContext
): Promise<{ id: string; schema: ModelSchema }> {
  const schema = await modelSchema(request.model, ctx)
  if (!schema) throw new ServiceError(`fal.ai has no model called "${request.model}".`)
  if (!request.startImage || imageField(schema)) return { id: request.model, schema }
  if (request.model.includes('text-to-video')) {
    const sibling = request.model.replace('text-to-video', 'image-to-video')
    const siblingSchema = await modelSchema(sibling, ctx).catch(() => null)
    if (siblingSchema && imageField(siblingSchema)) return { id: sibling, schema: siblingSchema }
  }
  throw new ServiceError(
    `${request.model} cannot start from a picture. Choose another model or leave the picture out.`
  )
}

function durationsOf(schema: ModelSchema): number[] {
  const values = enumOf(schema.input.duration)
    .map(Number)
    .filter((n) => Number.isFinite(n))
  if (values.length) return values.sort((a, b) => a - b)
  const range = rangeOf(schema.input.duration)
  if (range) {
    const out: number[] = []
    for (let n = Math.ceil(range.min); n <= Math.min(range.max, 30); n++) out.push(n)
    return out
  }
  return [5]
}

/** The request as this model's input fields. */
export function buildInput(request: GenerationRequest, schema: ModelSchema): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: request.prompt }
  const fields = schema.input
  if (request.kind === 'video' && fields.duration) {
    const choices = enumOf(fields.duration)
    const length = nearest(durationsOf(schema), request.duration)
    // Some models take the duration as a string from a list, others as a number.
    input.duration = choices.length && typeof choices[0] === 'string' ? String(length) : length
  }
  if (fields.aspect_ratio) {
    const choices = enumOf(fields.aspect_ratio).map(String)
    if (choices.includes(request.aspect)) input.aspect_ratio = request.aspect
  } else if (fields.image_size) {
    input.image_size = SIZE_FOR[request.aspect]
  }
  if (request.resolution && fields.resolution) {
    const choices = enumOf(fields.resolution).map(String)
    if (choices.includes(request.resolution)) input.resolution = request.resolution
  }
  if (request.startImage) {
    const field = imageField(schema)
    if (field) input[field] = `data:${request.startImage.mimeType};base64,${request.startImage.data}`
  }
  return input
}

/** The URL of the generated file in a result, whatever the model calls it. */
export function resultUrl(result: unknown): { url: string; contentType?: string } | null {
  const record = result as Record<string, unknown>
  const file = (value: unknown) => {
    const item = value as { url?: string; content_type?: string } | undefined
    return item?.url ? { url: item.url, contentType: item.content_type } : null
  }
  return (
    file(record.video) ??
    file(Array.isArray(record.videos) ? record.videos[0] : undefined) ??
    file(Array.isArray(record.images) ? record.images[0] : undefined) ??
    file(record.image) ??
    null
  )
}

function extensionFor(url: string, contentType: string | undefined, kind: GenerationRequest['kind']): string {
  const fromType = contentType?.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov')
  if (fromType && /^[a-z0-9]{2,4}$/.test(fromType)) return `.${fromType}`
  const fromUrl = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url)?.[1]
  return fromUrl ? `.${fromUrl.toLowerCase()}` : kind === 'video' ? '.mp4' : '.png'
}

function auth(ctx: RunContext): Record<string, string> {
  if (!ctx.apiKey) throw new ServiceError('Add your fal.ai API key in AI > Generation.')
  return { Authorization: `Key ${ctx.apiKey}` }
}

export const fal: Adapter = {
  async capabilities(model, ctx): Promise<ModelCapabilities> {
    const schema = await modelSchema(model, ctx)
    if (!schema) throw new ServiceError(`fal.ai has no model called "${model}".`)
    const video = 'video' in schema.output || 'videos' in schema.output
    let aspects = enumOf(schema.input.aspect_ratio)
      .map(String)
      .filter((a): a is AspectRatio => a === '16:9' || a === '9:16' || a === '1:1')
    if (!aspects.length && schema.input.image_size) aspects = ['16:9', '9:16', '1:1']
    let startImage = Boolean(imageField(schema))
    if (!startImage && model.includes('text-to-video')) {
      const sibling = await modelSchema(model.replace('text-to-video', 'image-to-video'), ctx).catch(
        () => null
      )
      startImage = Boolean(sibling && imageField(sibling))
    }
    return {
      kind: video ? 'video' : 'image',
      durations: video ? durationsOf(schema) : [],
      aspects: aspects.length ? aspects : ['16:9'],
      resolutions: enumOf(schema.input.resolution).map(String),
      startImage
    }
  },

  async estimate(request, ctx) {
    try {
      const response = await ctx.fetch(
        `${API}/models/pricing?endpoint_id=${encodeURIComponent(request.model)}`,
        {
          headers: auth(ctx),
          signal: ctx.signal
        }
      )
      if (!response.ok) throw await failure(response, 'fal.ai')
      const body = (await response.json()) as {
        prices?: Array<{ unit_price: number; unit: string; currency: string }>
      }
      const price = body.prices?.[0]
      if (!price) throw new Error('no price')
      const unit = price.unit.toLowerCase()
      const currency = price.currency === 'USD' ? '' : ` ${price.currency}`
      if (/second/.test(unit) && request.kind === 'video') {
        return `about ${money(price.unit_price * request.duration)}${currency} on fal.ai (${money(price.unit_price)} a second)`
      }
      if (/video|image|generation|request/.test(unit))
        return `about ${money(price.unit_price)}${currency} on fal.ai`
      return `${money(price.unit_price)}${currency} per ${price.unit} on fal.ai`
    } catch {
      return "billed by fal.ai at the model's price"
    }
  },

  async run(request, ctx): Promise<GeneratedFile> {
    const { id, schema } = await endpointFor(request, ctx)
    const submit = await ctx.fetch(`${QUEUE}/${id}`, {
      method: 'POST',
      headers: { ...auth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(buildInput(request, schema)),
      signal: ctx.signal
    })
    if (!submit.ok) throw await failure(submit, 'fal.ai')
    const queued = (await submit.json()) as {
      status_url?: string
      response_url?: string
      cancel_url?: string
    }
    if (!queued.status_url || !queued.response_url)
      throw new ServiceError('fal.ai did not accept the request.')

    const cancel = () => {
      if (queued.cancel_url)
        void ctx.fetch(queued.cancel_url, { method: 'PUT', headers: auth(ctx) }).catch(() => undefined)
    }
    ctx.signal.addEventListener('abort', cancel, { once: true })

    for (;;) {
      const response = await ctx.fetch(queued.status_url, { headers: auth(ctx), signal: ctx.signal })
      if (!response.ok) throw await failure(response, 'fal.ai')
      const status = (await response.json()) as { status?: string; queue_position?: number; error?: string }
      if (status.status === 'COMPLETED') break
      if (status.error) throw new ServiceError(status.error)
      ctx.progress(
        status.status === 'IN_QUEUE'
          ? `Waiting in fal.ai's queue${status.queue_position ? ` (position ${status.queue_position + 1})` : ''}`
          : 'Generating on fal.ai'
      )
      await sleep(2000, ctx.signal)
    }

    const response = await ctx.fetch(queued.response_url, { headers: auth(ctx), signal: ctx.signal })
    if (!response.ok) throw await failure(response, 'fal.ai')
    const result = await response.json()
    const file = resultUrl(result)
    if (!file)
      throw new ServiceError('fal.ai finished but returned no file. Try again or choose another model.')
    return { url: file.url, extension: extensionFor(file.url, file.contentType, request.kind) }
  }
}
