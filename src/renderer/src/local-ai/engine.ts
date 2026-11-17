import { getLocalModel, type Transcript } from '@shared/models'
import type { EngineRequestBody, EngineResponse } from './protocol'

type Pending = {
  resolve: (response: EngineResponse) => void
  reject: (error: Error) => void
  onStatus?: (message: string) => void
}

/** Talks to the local model worker. The worker is created on first use and kept for later calls. */
class LocalEngine {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<EngineResponse>) => {
        const message = event.data
        const call = this.pending.get(message.id)
        if (!call) return
        if (message.type === 'status') {
          call.onStatus?.(message.message)
          return
        }
        this.pending.delete(message.id)
        if (message.type === 'error') call.reject(new Error(message.message))
        else call.resolve(message)
      }
      this.worker.onerror = (event) => {
        const error = new Error(event.message || 'The local model engine stopped.')
        for (const call of this.pending.values()) call.reject(error)
        this.pending.clear()
        this.worker?.terminate()
        this.worker = null
      }
    }
    return this.worker
  }

  private send(
    request: EngineRequestBody,
    onStatus?: (message: string) => void,
    transfer: Transferable[] = []
  ) {
    const id = this.nextId++
    return new Promise<EngineResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStatus })
      this.ensureWorker().postMessage({ ...request, id }, transfer)
    })
  }

  async voiceover(
    text: string,
    voice: string,
    speed: number,
    onStatus?: (message: string) => void
  ): Promise<{ audio: Float32Array; sampleRate: number }> {
    const response = await this.send({ type: 'voiceover', text, voice, speed }, onStatus)
    if (response.type !== 'voiceover') throw new Error('Unexpected reply from the voice model.')
    return { audio: response.audio, sampleRate: response.sampleRate }
  }

  async transcribe(
    modelId: string,
    audio: Float32Array,
    language: string | null,
    onStatus?: (message: string) => void,
    task: 'transcribe' | 'translate' = 'transcribe'
  ): Promise<Transcript> {
    const model = getLocalModel(modelId)
    if (!model) throw new Error('Unknown speech recognition model.')
    const response = await this.send(
      { type: 'transcribe', modelId, repo: model.repo, audio, language, task },
      onStatus,
      [audio.buffer]
    )
    if (response.type !== 'transcribe') throw new Error('Unexpected reply from the speech model.')
    return { modelId, language: response.language, segments: response.segments }
  }

  async embedText(repo: string, texts: string[]): Promise<{ vectors: Float32Array; dim: number }> {
    const response = await this.send({ type: 'embed-text', repo, texts })
    if (response.type !== 'embeddings') throw new Error('Unexpected reply from the search model.')
    return { vectors: response.vectors, dim: response.dim }
  }

  async embedFrames(
    repo: string,
    frames: Uint8Array,
    width: number,
    height: number,
    onStatus?: (message: string) => void
  ): Promise<{ vectors: Float32Array; dim: number }> {
    const response = await this.send({ type: 'embed-frames', repo, frames, width, height }, onStatus, [
      frames.buffer
    ])
    if (response.type !== 'embeddings') throw new Error('Unexpected reply from the search model.')
    return { vectors: response.vectors, dim: response.dim }
  }

  async cutout(
    repo: string,
    dtype: string,
    image: Blob,
    onStatus?: (message: string) => void
  ): Promise<ArrayBuffer> {
    const response = await this.send({ type: 'cutout', repo, dtype, image }, onStatus)
    if (response.type !== 'cutout') throw new Error('Unexpected reply from the background model.')
    return response.png
  }

  async matte(
    repo: string,
    dtype: string,
    frames: Uint8Array,
    width: number,
    height: number
  ): Promise<Uint8Array> {
    const response = await this.send({ type: 'matte', repo, dtype, frames, width, height }, undefined, [
      frames.buffer
    ])
    if (response.type !== 'masks') throw new Error('Unexpected reply from the background model.')
    return response.masks
  }
}

export const localEngine = new LocalEngine()
