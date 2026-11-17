import type { Clip, MediaItem } from '@shared/types'
import {
  DEFAULT_VOICE,
  getLocalModel,
  KOKORO_VOICES,
  LOCAL_MODELS,
  type Transcript,
  type TranscriptSegment
} from '@shared/models'
import { encodeWav } from '../lib/wav'
import { beginTask } from '../store/ui'
import { localEngine } from './engine'

/** Raised when a feature needs a model that is not installed yet. */
export class ModelMissingError extends Error {
  constructor(readonly task: 'voiceover' | 'transcription') {
    super(
      task === 'voiceover'
        ? "The Kokoro voice model is not installed yet (a 108 MB download). With the user's agreement, install it with install_ai_model, or they can install it from the AI button in Kificut."
        : "No speech recognition model is installed yet. With the user's agreement, install one with install_ai_model (whisper-base is 81 MB), or they can install it from the AI button in Kificut."
    )
  }
}

async function installedIds(): Promise<Set<string>> {
  const statuses = await window.kificut.models.list()
  return new Set(statuses.filter((s) => s.state === 'installed').map((s) => s.id))
}

/** The most accurate installed speech model, or null. */
export async function transcriptionModel(): Promise<string | null> {
  const installed = await installedIds()
  const candidates = LOCAL_MODELS.filter((m) => m.task === 'transcription' && installed.has(m.id))
  return candidates.sort((a, b) => b.approximateSize - a.approximateSize)[0]?.id ?? null
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
  onStatus?: (message: string) => void
): Promise<Transcript> {
  if (!media.hasAudio) throw new Error(`${media.name} has no sound to transcribe.`)
  const modelId = await transcriptionModel()
  if (!modelId) throw new ModelMissingError('transcription')
  const key = `${media.path}|${modelId}|${language ?? ''}`
  let job = transcripts.get(key)
  if (!job) {
    job = (async () => {
      const task = beginTask(`Transcribing ${media.name}`)
      const report = (message: string) => {
        task.update(message)
        onStatus?.(message)
      }
      try {
        report('Reading the audio')
        const audio = await window.kificut.media.decodeAudio(media.path, 16000)
        return await localEngine.transcribe(modelId, audio, language, report)
      } finally {
        task.end()
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
