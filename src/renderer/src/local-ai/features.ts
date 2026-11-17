import type { Clip, MediaItem } from '@shared/types'
import {
  bestInstalled,
  DEFAULT_VOICE,
  getLocalModel,
  KOKORO_VOICES,
  LOCAL_MODELS,
  type LocalModelInfo,
  type ModelTask,
  type Transcript,
  type TranscriptSegment
} from '@shared/models'
import { findMoments, type Moment } from '@shared/search'
import { encodeWav } from '../lib/wav'
import { mediaUrl } from '../lib/media'
import { beginTask } from '../store/ui'
import { localEngine } from './engine'

const MB = (bytes: number) => (bytes < 1e6 ? 'under 1 MB' : `${Math.round(bytes / 1e6)} MB`)

/** What to install for a task, written for an assistant (it can install with install_ai_model). */
function missingMessage(task: ModelTask): string {
  const options = LOCAL_MODELS.filter((m) => m.task === task)
    .map((m) => `${m.id} (${m.name}, ${MB(m.approximateSize)}: ${m.description.replace(/\.$/, '')})`)
    .join('; or ')
  const what: Record<ModelTask, string> = {
    voiceover: 'The voiceover model is',
    transcription: 'No speech recognition model is',
    noise: 'The noise reduction model is',
    search: 'The footage search model is',
    background: 'No background removal model is'
  }
  return `${what[task]} not installed yet. With the user's agreement, install ${options} with install_ai_model, or they can install it from the AI button in Kificut.`
}

/** Raised when a feature needs a model that is not installed yet. */
export class ModelMissingError extends Error {
  constructor(readonly task: ModelTask) {
    super(missingMessage(task))
  }
}

async function installedIds(): Promise<Set<string>> {
  const statuses = await window.kificut.models.list()
  return new Set(statuses.filter((s) => s.state === 'installed').map((s) => s.id))
}

/** The best installed model for a task, or a ModelMissingError. */
async function requireModel(task: ModelTask, only?: string): Promise<LocalModelInfo> {
  const installed = await installedIds()
  const model = only
    ? installed.has(only)
      ? getLocalModel(only)!
      : null
    : bestInstalled(task, (id) => installed.has(id))
  if (!model) throw new ModelMissingError(task)
  return model
}

/** The most accurate installed speech model, or null. */
export async function transcriptionModel(): Promise<string | null> {
  const installed = await installedIds()
  return bestInstalled('transcription', (id) => installed.has(id))?.id ?? null
}

export interface Voiceover {
  path: string
  duration: number
}

export async function createVoiceover(
  text: string,
  voice = DEFAULT_VOICE,
  speed = 1,
  onStatus?: (message: string) => void
): Promise<Voiceover> {
  if (!text.trim()) throw new Error('There is no text to speak.')
  if (!KOKORO_VOICES.some((v) => v.id === voice)) throw new Error(`Unknown voice "${voice}".`)
  if (!(await installedIds()).has('kokoro-82m')) throw new ModelMissingError('voiceover')
  const task = beginTask('Voiceover')
  try {
    const { audio, sampleRate } = await localEngine.voiceover(text.trim(), voice, speed, (message) => {
      task.update(message)
      onStatus?.(message)
    })
    const name = KOKORO_VOICES.find((v) => v.id === voice)!.name
    const path = await window.kificut.media.saveGenerated(
      `Voiceover ${name} - ${text.trim().slice(0, 32)}.wav`,
      encodeWav(audio, sampleRate)
    )
    return { path, duration: audio.length / sampleRate }
  } finally {
    task.end()
  }
}

const transcripts = new Map<string, Promise<Transcript>>()

/** Transcribes a media file with the best installed model. Results are kept for the session. */
export async function transcribeMedia(
  media: MediaItem,
  language: string | null = null,
  onStatus?: (message: string) => void,
  task: 'transcribe' | 'translate' = 'transcribe'
): Promise<Transcript> {
  if (!media.hasAudio) throw new Error(`${media.name} has no sound to transcribe.`)
  const modelId = await transcriptionModel()
  if (!modelId) throw new ModelMissingError('transcription')
  const key = `${media.path}|${modelId}|${language ?? ''}|${task}`
  let job = transcripts.get(key)
  if (!job) {
    job = (async () => {
      const progress = beginTask(`${task === 'translate' ? 'Translating' : 'Transcribing'} ${media.name}`)
      const report = (message: string) => {
        progress.update(message)
        onStatus?.(message)
      }
      try {
        report('Reading the audio')
        const audio = await window.kificut.media.decodeAudio(media.path, 16000)
        return await localEngine.transcribe(modelId, audio, language, report, task)
      } finally {
        progress.end()
      }
    })()
    transcripts.set(key, job)
    job.catch(() => transcripts.delete(key))
  }
  return job
}

export interface CaptionCue {
  start: number
  duration: number
  text: string
}

/**
 * Maps transcript segments (source time) onto a clip on the timeline, keeping only what the clip
 * actually shows and accounting for trims and speed changes.
 */
export function captionsForClip(
  clip: Clip,
  segments: TranscriptSegment[],
  minDuration: number
): CaptionCue[] {
  const sourceStart = clip.inPoint
  const sourceEnd = clip.inPoint + clip.duration * clip.speed
  const cues: CaptionCue[] = []
  for (const segment of segments) {
    const from = Math.max(segment.start, sourceStart)
    const to = Math.min(segment.end, sourceEnd)
    if (to - from <= 0.05 || !segment.text) continue
    const start = clip.start + (from - sourceStart) / clip.speed
    const end = clip.start + (to - sourceStart) / clip.speed
    cues.push({ start, duration: Math.max(minDuration, end - start), text: segment.text })
  }
  // Never let one caption run into the next.
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].duration = Math.min(cues[i].duration, Math.max(minDuration, cues[i + 1].start - cues[i].start))
  }
  return cues
}

export function modelName(id: string): string {
  return getLocalModel(id)?.name ?? id
}

/* Footage search */

interface SearchIndex {
  times: number[]
  dim: number
  vectors: Float32Array
}

const indexes = new Map<string, Promise<SearchIndex>>()

function toBase64(vectors: Float32Array): string {
  const bytes = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function fromBase64(text: string): Float32Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

/** What a file looks like over time, built once per file and cached on disk. */
function searchIndex(media: MediaItem, model: LocalModelInfo): Promise<SearchIndex> {
  const key = `${media.path}|${model.id}`
  let job = indexes.get(key)
  if (!job) {
    job = (async () => {
      const stored = await window.kificut.localAi.readSearchIndex(media.path, model.id)
      if (stored) {
        const parsed = JSON.parse(stored) as { times: number[]; dim: number; vectors: string }
        return { times: parsed.times, dim: parsed.dim, vectors: fromBase64(parsed.vectors) }
      }
      const progress = beginTask(`Indexing ${media.name}`)
      try {
        progress.update('Reading frames')
        const frames = await window.kificut.localAi.searchFrames(media.path, media.duration)
        const { vectors, dim } = await localEngine.embedFrames(
          model.repo,
          frames.data,
          frames.width,
          frames.height,
          (message) => progress.update(message)
        )
        const index = { times: frames.times, dim, vectors }
        await window.kificut.localAi.writeSearchIndex(
          media.path,
          model.id,
          JSON.stringify({ times: index.times, dim, vectors: toBase64(vectors) })
        )
        return index
      } finally {
        progress.end()
      }
    })()
    indexes.set(key, job)
    job.catch(() => indexes.delete(key))
  }
  return job
}

export interface Shot extends Moment {
  media: MediaItem
}

/** Moments in the given files that look like the description, best first. */
export async function findShots(query: string, media: MediaItem[], limit = 8): Promise<Shot[]> {
  const description = query.trim()
  if (!description) throw new Error('Describe what to look for.')
  const model = await requireModel('search')
  const visual = media.filter((m) => m.hasVideo)
  if (visual.length === 0) return []
  // CLIP matches a plain description and "a photo of ..." a little differently; use both.
  const text = await localEngine.embedText(model.repo, [description, `a photo of ${description}`])
  const query1 = text.vectors.subarray(0, text.dim)
  const query2 = text.vectors.subarray(text.dim, text.dim * 2)
  const scored = []
  for (const item of visual) {
    const index = await searchIndex(item, model)
    const scores = index.times.map((_, frame) => {
      let a = 0
      let b = 0
      for (let k = 0; k < index.dim; k++) {
        const v = index.vectors[frame * index.dim + k]
        a += v * query1[k]
        b += v * query2[k]
      }
      return (a + b) / 2
    })
    scored.push({ key: item.id, times: index.times, scores, duration: item.duration })
  }
  return findMoments(scored, limit).map((moment) => ({
    ...moment,
    media: visual.find((m) => m.id === moment.key)!
  }))
}

/* Noise reduction */

const cleaned = new Map<string, Promise<string>>()

/** A copy of the file's sound with background noise removed. Kept for the session per file and strength. */
export async function cleanAudio(media: MediaItem, strength = 0.85): Promise<string> {
  if (!media.hasAudio) throw new Error(`${media.name} has no sound to clean up.`)
  await requireModel('noise')
  const key = `${media.path}|${strength.toFixed(2)}`
  let job = cleaned.get(key)
  if (!job) {
    job = (async () => {
      const progress = beginTask(`Reducing noise in ${media.name}`)
      const off = window.kificut.localAi.onNoiseProgress((path, fraction) => {
        if (path === media.path) progress.update(`${Math.round(fraction * 100)}%`)
      })
      try {
        return await window.kificut.localAi.reduceNoise(media.path, strength, media.duration)
      } finally {
        off()
        progress.end()
      }
    })()
    cleaned.set(key, job)
    job.catch(() => cleaned.delete(key))
  }
  return job
}

/* Background removal */

/** A PNG of the picture with its background removed, saved next to Kificut's other generated files. */
export async function cutoutImage(media: MediaItem): Promise<string> {
  if (media.kind !== 'image') throw new Error('Pictures only. For video, use background removal on the clip.')
  const model = await requireModel('background')
  const progress = beginTask(`Removing the background from ${media.name}`)
  try {
    const image = await (await fetch(mediaUrl(media.path))).blob()
    const png = await localEngine.cutout(model.repo, model.dtype ?? 'fp32', image, (message) =>
      progress.update(message)
    )
    const base = media.name.replace(/\.[^.]+$/, '')
    return await window.kificut.media.saveGenerated(`${base} (no background).png`, new Uint8Array(png))
  } finally {
    progress.end()
  }
}

/**
 * A copy of part of a video with the background behind people removed, as WebM with transparency.
 * Every frame goes through MODNet, so this takes a few seconds of work per second of video.
 */
export async function removeVideoBackground(
  media: MediaItem,
  start: number,
  duration: number,
  onProgress?: (fraction: number) => void
): Promise<string> {
  if (media.kind !== 'video') throw new Error('This works on video clips.')
  const model = await requireModel('background', 'modnet')
  const progress = beginTask(`Removing the background from ${media.name}`)
  const session = await window.kificut.localAi.startMatte(
    media.path,
    start,
    duration,
    media.fps || 30,
    media.width,
    media.height
  )
  let done = 0
  try {
    for (;;) {
      const frames = await window.kificut.localAi.readMatteFrames(session.id, 8)
      if (frames.length === 0) break
      const masks = await localEngine.matte(
        model.repo,
        model.dtype ?? 'fp32',
        frames,
        session.width,
        session.height
      )
      await window.kificut.localAi.writeMatteMasks(session.id, masks)
      done += masks.length / (session.width * session.height)
      const fraction = Math.min(1, done / session.frames)
      progress.update(`${Math.round(fraction * 100)}%`)
      onProgress?.(fraction)
    }
    progress.update('Finishing the video')
    return await window.kificut.localAi.finishMatte(session.id)
  } catch (error) {
    await window.kificut.localAi.cancelMatte(session.id)
    throw error
  } finally {
    progress.end()
  }
}
