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
      /** "translate" turns speech in any language into English text. */
      task: 'transcribe' | 'translate'
    }
  | { id: number; type: 'embed-text'; repo: string; texts: string[] }
  /** RGB frames, one after another, each width x height. */
  | { id: number; type: 'embed-frames'; repo: string; frames: Uint8Array; width: number; height: number }
  | { id: number; type: 'cutout'; repo: string; dtype: string; image: Blob }
  | {
      id: number
      type: 'matte'
      repo: string
      dtype: string
      frames: Uint8Array
      width: number
      height: number
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
  /** Unit length vectors, one after another, each `dim` long. */
  | { id: number; type: 'embeddings'; vectors: Float32Array; dim: number }
  | { id: number; type: 'cutout'; png: ArrayBuffer }
  /** One 8 bit mask per frame, width x height each. */
  | { id: number; type: 'masks'; masks: Uint8Array }
  | { id: number; type: 'error'; message: string }
