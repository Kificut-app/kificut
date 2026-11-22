/*
 * Generating scenes (short video clips) and pictures with AI services. Google and fal.ai run in
 * the cloud with the user's own key and bill per clip or picture; ComfyUI runs on the user's own
 * graphics card. Keys stay in the main process, like the assistant's.
 */

export type GenerationService = 'google' | 'fal' | 'comfyui'
export type GenerationKind = 'video' | 'image'
export type AspectRatio = '16:9' | '9:16' | '1:1'

export interface ServiceInfo {
  id: GenerationService
  name: string
  needsKey: boolean
  /** Where to get a key or set the service up. */
  helpUrl: string
  pricingUrl: string
  hint: string
}

export const GENERATION_SERVICES: ServiceInfo[] = [
  {
    id: 'google',
    name: 'Google',
    needsKey: true,
    helpUrl: 'https://aistudio.google.com/apikey',
    pricingUrl: 'https://ai.google.dev/pricing',
    hint: 'Gemini Omni Flash for scenes with sound, Nano Banana for pictures. Uses your Gemini API key.'
  },
  {
    id: 'fal',
    name: 'fal.ai',
    needsKey: true,
    helpUrl: 'https://fal.ai/dashboard/keys',
    pricingUrl: 'https://fal.ai/pricing',
    hint: 'One key for many models, such as Wan, Kling and FLUX.'
  },
  {
    id: 'comfyui',
    name: 'ComfyUI',
    needsKey: false,
    helpUrl: 'https://github.com/comfyanonymous/ComfyUI',
    pricingUrl: '',
    hint: 'Your own workflows on your own graphics card. Free, and nothing leaves your network.'
  }
]

export function getService(id: string): ServiceInfo | undefined {
  return GENERATION_SERVICES.find((s) => s.id === id)
}

export interface ModelSuggestion {
  id: string
  name: string
  kind: GenerationKind
}

export const GOOGLE_VIDEO_MODEL = 'gemini-omni-1.2-flash'
export const GOOGLE_IMAGE_MODEL = 'gemini-nano-banana-2.1'

/** Models offered in the model picker. fal.ai takes any of its endpoint ids as well. */
export const SUGGESTED_MODELS: Record<Exclude<GenerationService, 'comfyui'>, ModelSuggestion[]> = {
  google: [
    { id: GOOGLE_VIDEO_MODEL, name: 'Gemini Omni Flash', kind: 'video' },
    { id: GOOGLE_IMAGE_MODEL, name: 'Nano Banana 2.1', kind: 'image' }
  ],
  fal: [
    { id: 'alibaba/wan-3.0/text-to-video', name: 'Wan 3.0', kind: 'video' },
    { id: 'fal-ai/kling-video/v3/standard/text-to-video', name: 'Kling 3 Standard', kind: 'video' },
    { id: 'fal-ai/flux/schnell', name: 'FLUX.1 schnell', kind: 'image' },
    { id: 'fal-ai/flux/dev', name: 'FLUX.1 dev', kind: 'image' }
  ]
}

/** What a model accepts, so the panel only offers options that work. */
export interface ModelCapabilities {
  kind: GenerationKind
  /** Allowed lengths in seconds for video. */
  durations: number[]
  aspects: AspectRatio[]
  resolutions: string[]
  /** Whether a starting picture can be given. */
  startImage: boolean
}

export interface StartImage {
  /** Base64 JPEG or PNG. */
  data: string
  mimeType: string
}

export interface GenerationRequest {
  kind: GenerationKind
  service: GenerationService
  model: string
  prompt: string
  /** Seconds, for video. */
  duration: number
  aspect: AspectRatio
  /** For video, such as "720p". */
  resolution?: string
  startImage?: StartImage
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface GenerationJob {
  id: number
  kind: GenerationKind
  prompt: string
  service: GenerationService
  model: string
  state: JobState
  /** What is happening now, such as "Waiting in the queue". */
  message: string
  /** 0 to 1 when the service reports it. */
  progress: number | null
  /** The saved file once done. */
  path: string | null
  error: string | null
  startedAt: number
  /** A note on what it should cost, from before it started. */
  estimate: string
}

export interface GenerationSettings {
  googleKey: boolean
  falKey: boolean
  /** False when keys are kept for this session only (no secure system key store). */
  keysPersisted: boolean
  comfyuiUrl: string
  /** ComfyUI workflows in API format, with {{prompt}} and the other placeholders. */
  comfyuiVideoWorkflow: string
  comfyuiImageWorkflow: string
}

export interface GenerationSettingsUpdate {
  googleKey?: string | null
  falKey?: string | null
  comfyuiUrl?: string
  comfyuiVideoWorkflow?: string
  comfyuiImageWorkflow?: string
}

/** Pixel size for an aspect ratio at a resolution such as "720p" (the short side). */
export function frameSize(aspect: AspectRatio, resolution = '720p'): { width: number; height: number } {
  const short = parseInt(resolution, 10) || 720
  const long = Math.round((short * 16) / 9 / 16) * 16
  if (aspect === '1:1') return { width: short, height: short }
  return aspect === '16:9' ? { width: long, height: short } : { width: short, height: long }
}

/** The supported aspect ratio closest to a width and height. */
export function nearestAspect(width: number, height: number, allowed: AspectRatio[]): AspectRatio {
  const ratio = width / Math.max(1, height)
  const value = (a: AspectRatio) => (a === '16:9' ? 16 / 9 : a === '9:16' ? 9 / 16 : 1)
  return (
    [...allowed].sort(
      (a, b) => Math.abs(Math.log(value(a) / ratio)) - Math.abs(Math.log(value(b) / ratio))
    )[0] ?? '16:9'
  )
}

/** The allowed value closest to the wanted one. */
export function nearest(values: number[], wanted: number): number {
  return [...values].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0] ?? wanted
}
