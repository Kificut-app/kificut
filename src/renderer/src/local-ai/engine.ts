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
    onStatus?: (message: string) => void
  ): Promise<Transcript> {
    const model = getLocalModel(modelId)
    if (!model) throw new Error('Unknown speech recognition model.')
    const response = await this.send(
      { type: 'transcribe', modelId, repo: model.repo, audio, language },
      onStatus,
      [audio.buffer]
    )
    if (response.type !== 'transcribe') throw new Error('Unexpected reply from the speech model.')
    return { modelId, language: response.language, segments: response.segments }
  }
}

export const localEngine = new LocalEngine()
