import { readFile } from 'node:fs/promises'
import { frameSize, type GenerationRequest, type ModelCapabilities } from '@shared/generation'
import { failure, ServiceError, sleep, type Adapter, type GeneratedFile, type RunContext } from './types'

/*
 * ComfyUI on the user's own machine. The user exports a workflow in API format (Workflow >
 * Export (API)) and puts placeholders where Kificut should fill in values:
 *
 *   {{prompt}}  {{negative_prompt}}  {{width}}  {{height}}  {{frames}}  {{fps}}  {{seconds}}
 *   {{seed}}  {{image}}
 *
 * A field that is exactly a placeholder gets a number where that makes sense. {{image}} is the
 * starting picture, uploaded to ComfyUI first, for a LoadImage node.
 */

const FPS = 24
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|gif)$/i
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i

interface OutputFile {
  filename: string
  subfolder?: string
  type?: string
}

function settingsFor(ctx: RunContext) {
  if (!ctx.comfyui?.url)
    throw new ServiceError('Enter the address of your ComfyUI server in AI > Generation.')
  return ctx.comfyui
}

async function workflow(kind: GenerationRequest['kind'], ctx: RunContext): Promise<string> {
  const settings = settingsFor(ctx)
  const path = kind === 'video' ? settings.videoWorkflow : settings.imageWorkflow
  if (!path) {
    throw new ServiceError(
      `Choose a ComfyUI ${kind === 'video' ? 'video' : 'picture'} workflow in AI > Generation.`
    )
  }
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new ServiceError(`Could not read the workflow at ${path}.`)
  }
}

/** Frames for a length, as 8n + 1, which suits both Wan (4n + 1) and LTX (8n + 1). */
export function frameCount(seconds: number, fps = FPS): number {
  return Math.max(9, Math.round((seconds * fps) / 8) * 8 + 1)
}

/** Fills the placeholders in a workflow. Numbers stay numbers when a field is only a placeholder. */
export function fillWorkflow(json: string, values: Record<string, string | number>): unknown {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(value)
      if (whole && whole[1] in values) return values[whole[1]]
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match
      )
    }
    if (Array.isArray(value)) return value.map(fill)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
    }
    return value
  }
  return fill(JSON.parse(json))
}

/** The files a finished prompt produced, preferring video for a scene. */
export function pickOutput(
  outputs: Record<string, Record<string, unknown>>,
  kind: GenerationRequest['kind']
): OutputFile | null {
  const files: OutputFile[] = []
  for (const node of Object.values(outputs)) {
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (item && typeof item === 'object' && typeof (item as OutputFile).filename === 'string') {
          files.push(item as OutputFile)
        }
      }
    }
  }
  const wanted = kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS
  const saved = files.filter((f) => f.type !== 'temp')
  return saved.find((f) => wanted.test(f.filename)) ?? files.find((f) => wanted.test(f.filename)) ?? null
}

async function uploadImage(request: GenerationRequest, base: string, ctx: RunContext): Promise<string> {
  const image = request.startImage!
  const form = new FormData()
  const extension = image.mimeType === 'image/png' ? 'png' : 'jpg'
  form.append(
    'image',
    new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }),
    `kificut-start.${extension}`
  )
  form.append('overwrite', 'true')
  const response = await ctx.fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: ctx.signal })
  if (!response.ok) throw await failure(response, 'ComfyUI')
  const uploaded = (await response.json()) as { name: string; subfolder?: string }
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

export const comfyui: Adapter = {
  async capabilities(model, ctx): Promise<ModelCapabilities> {
    const kind = model === 'image' ? 'image' : 'video'
    const text = await workflow(kind, ctx).catch(() => '')
    return {
      kind,
      durations: kind === 'video' ? Array.from({ length: 10 }, (_, i) => i + 1) : [],
      aspects: ['16:9', '9:16', '1:1'],
      resolutions: kind === 'video' ? ['480p', '720p'] : [],
      startImage: text.includes('{{image}}')
    }
  },

  async estimate() {
    return 'free, on your ComfyUI'
  },

  async run(request, ctx): Promise<GeneratedFile> {
    const base = settingsFor(ctx).url.replace(/\/+$/, '')
    const text = await workflow(request.kind, ctx)
    if (request.startImage && !text.includes('{{image}}')) {
      throw new ServiceError(
        'This ComfyUI workflow has no {{image}} placeholder, so it cannot start from a picture.'
      )
    }
    const size = frameSize(
      request.aspect,
      request.kind === 'image' ? '1024p' : (request.resolution ?? '720p')
    )
    const values: Record<string, string | number> = {
      prompt: request.prompt,
      negative_prompt: 'blurry, distorted, low quality, watermark, text',
      width: size.width,
      height: size.height,
      seconds: request.duration,
      fps: FPS,
      frames: frameCount(request.duration),
      seed: Math.floor(Math.random() * 2 ** 31)
    }
    if (request.startImage) values.image = await uploadImage(request, base, ctx)

    ctx.progress('Sending the workflow to ComfyUI')
    const submit = await ctx.fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fillWorkflow(text, values), client_id: 'kificut' }),
      signal: ctx.signal
    })
    if (!submit.ok) {
      const error = await failure(submit, 'ComfyUI')
      throw new ServiceError(`ComfyUI did not accept the workflow: ${error.message}`)
    }
    const { prompt_id: id } = (await submit.json()) as { prompt_id: string }
    ctx.signal.addEventListener(
      'abort',
      () => void ctx.fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => undefined),
      { once: true }
    )

    for (;;) {
      const response = await ctx.fetch(`${base}/history/${id}`, { signal: ctx.signal })
      if (!response.ok) throw await failure(response, 'ComfyUI')
      const history = (await response.json()) as Record<
        string,
        {
          outputs?: Record<string, Record<string, unknown>>
          status?: {
            status_str?: string
            completed?: boolean
            messages?: Array<[string, { exception_message?: string }]>
          }
        }
      >
      const entry = history[id]
      if (entry?.status?.status_str === 'error') {
        const reason = entry.status.messages?.find(([type]) => type === 'execution_error')?.[1]
          ?.exception_message
        throw new ServiceError(`ComfyUI stopped with an error${reason ? `: ${reason.trim()}` : '.'}`)
      }
      if (entry && (entry.status?.completed || entry.status?.status_str === 'success')) {
        const file = pickOutput(entry.outputs ?? {}, request.kind)
        if (!file)
          throw new ServiceError(
            `The workflow finished without saving a ${request.kind === 'video' ? 'video' : 'picture'}.`
          )
        const query = new URLSearchParams({
          filename: file.filename,
          subfolder: file.subfolder ?? '',
          type: file.type ?? 'output'
        })
        const extension =
          /\.[a-z0-9]+$/i.exec(file.filename)?.[0]?.toLowerCase() ??
          (request.kind === 'video' ? '.mp4' : '.png')
        return { url: `${base}/view?${query}`, extension }
      }
      ctx.progress('Running on ComfyUI')
      await sleep(2000, ctx.signal)
    }
  }
}
