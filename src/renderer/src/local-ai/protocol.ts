import type { TranscriptSegment } from '@shared/models'

export type EngineRequest =
  | { id: number; type: 'voiceover'; text: string; voice: string; speed: number }
  | {
      id: number
      type: 'transcribe'
      modelId: string
      repo: string
      audio: Float32Array
      language: string | null
    }

/** A request before the engine assigns its id. */
export type EngineRequestBody = EngineRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never

export type EngineResponse =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'voiceover'; audio: Float32Array; sampleRate: number }
  | { id: number; type: 'transcribe'; language: string | null; segments: TranscriptSegment[] }
  | { id: number; type: 'error'; message: string }
