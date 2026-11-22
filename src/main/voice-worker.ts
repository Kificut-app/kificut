import { AutoProcessor, ChatterboxModel, Tensor, env, type Processor } from 'transformers-v4'
import type { VoiceWorkerRequest, VoiceWorkerResponse } from './voice-engine'

/*
 * The utility process behind custom voices (see voice-engine.ts). It loads Chatterbox Turbo with
 * onnxruntime-node from the installed model files, listens to a voice's reference recording once,
 * and speaks scripts sentence by sentence. It never goes online.
 */

env.allowRemoteModels = false
env.allowLocalModels = true
env.useFSCache = false

/** Speech tokens come at 25 a second, so this allows 40 seconds for one sentence. */
const MAX_TOKENS = 1000

type SpeakerConditioning = Awaited<ReturnType<ChatterboxModel['encode_speech']>>

let loaded: { key: string; processor: Processor; model: ChatterboxModel } | null = null
let voice: { key: string; conditioning: SpeakerConditioning } | null = null

const post = (message: VoiceWorkerResponse) => process.parentPort.postMessage(message)

async function load(request: VoiceWorkerRequest) {
  const key = `${request.modelsRoot}|${request.repo}|${request.dtype}|${request.threads}`
  if (loaded?.key === key) return loaded
  post({ id: request.id, type: 'status', message: 'Loading Chatterbox Turbo' })
  env.localModelPath = request.modelsRoot
  const processor = await AutoProcessor.from_pretrained(request.repo)
  const model = (await ChatterboxModel.from_pretrained(request.repo, {
    device: 'cpu',
    dtype: request.dtype as 'q4',
    session_options: { intraOpNumThreads: request.threads }
  })) as ChatterboxModel
  loaded = { key, processor, model }
  voice = null
  return loaded
}

async function speak(request: VoiceWorkerRequest): Promise<void> {
  const { processor, model } = await load(request)

  if (voice?.key !== request.voiceKey) {
    post({ id: request.id, type: 'status', message: 'Listening to the voice' })
    const audio = new Tensor('float32', request.reference, [1, request.reference.length])
    voice = { key: request.voiceKey, conditioning: await model.encode_speech(audio) }
  }

  const sampleRate = 24_000
  const parts: Float32Array[] = []
  for (const [i, chunk] of request.chunks.entries()) {
    post({
      id: request.id,
      type: 'status',
      message:
        request.chunks.length > 1 ? `Speaking sentence ${i + 1} of ${request.chunks.length}` : 'Speaking'
    })
    const inputs = await processor(chunk.text)
    const waveform = (await model.generate({
      ...inputs,
      ...voice.conditioning,
      max_new_tokens: MAX_TOKENS
    })) as Tensor
    parts.push(waveform.data as Float32Array)
    if (chunk.pause > 0) parts.push(new Float32Array(Math.round(chunk.pause * sampleRate)))
  }

  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    samples.set(part, at)
    at += part.length
  }
  post({ id: request.id, type: 'audio', samples, sampleRate })
}

// One request at a time, in the order they arrive.
let queue: Promise<void> = Promise.resolve()

process.parentPort.on('message', (event: { data: VoiceWorkerRequest }) => {
  const request = event.data
  queue = queue.then(() =>
    speak(request).catch((error: unknown) => {
      post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  )
})
