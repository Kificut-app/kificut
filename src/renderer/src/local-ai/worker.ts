/// <reference lib="webworker" />
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'
import wasmUrl from 'ort-dist/ort-wasm-simd-threaded.jsep.wasm?url'
import wasmGlueUrl from 'ort-dist/ort-wasm-simd-threaded.jsep.mjs?url'
import { getLocalModel, MODELS_URL } from '@shared/models'
import type { EngineRequest, EngineResponse } from './protocol'

/*
 * Runs local models off the main thread. Everything is read from the models:// store; requests to
 * the internet are refused, so nothing about the user's media leaves the computer.
 */

const KOKORO = getLocalModel('kokoro-82m')!
const VOICES_ONLINE = `https://huggingface.co/${KOKORO.repo}/resolve/main/voices/`

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = MODELS_URL
env.useBrowserCache = false
const wasm = env.backends.onnx.wasm!
wasm.wasmPaths = {
  wasm: new URL(wasmUrl, self.location.href).href,
  mjs: new URL(wasmGlueUrl, self.location.href).href
}
// Several threads when shared memory is available (Kificut turns it on), leaving cores for playback.
if (typeof SharedArrayBuffer !== 'undefined') {
  wasm.numThreads = Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
}

const realFetch = self.fetch.bind(self)
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  // kokoro-js looks for voices on Hugging Face; serve the installed copies instead.
  if (url.startsWith(VOICES_ONLINE)) {
    return realFetch(`${MODELS_URL}${KOKORO.repo}/voices/${url.slice(VOICES_ONLINE.length)}`, init)
  }
  if (/^https?:/i.test(url) && !url.startsWith(self.location.origin)) {
    return Promise.reject(new Error(`Local models do not use the internet (blocked ${url}).`))
  }
  return realFetch(input, init)
}

const post = (message: EngineResponse, transfer: Transferable[] = []) => self.postMessage(message, transfer)

let kokoro: Promise<KokoroTTS> | null = null
const recognizers = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>()

function loadKokoro(id: number): Promise<KokoroTTS> {
  if (!kokoro) {
    post({ id, type: 'status', message: 'Loading the Kokoro voice model' })
    kokoro = KokoroTTS.from_pretrained(KOKORO.repo, { dtype: 'q8', device: 'wasm' })
    kokoro.catch(() => (kokoro = null))
  }
  return kokoro
}

function loadRecognizer(
  id: number,
  modelId: string,
  repo: string
): Promise<AutomaticSpeechRecognitionPipeline> {
  let loading = recognizers.get(modelId)
  if (!loading) {
    post({ id, type: 'status', message: 'Loading the speech recognition model' })
    // pipeline()'s overloads are too large for TypeScript to resolve here, so call it through a narrow type.
    const createPipeline = pipeline as unknown as (
      task: 'automatic-speech-recognition',
      model: string,
      options: Record<string, unknown>
    ) => Promise<AutomaticSpeechRecognitionPipeline>
    loading = createPipeline('automatic-speech-recognition', repo, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm'
    })
    loading.catch(() => recognizers.delete(modelId))
    recognizers.set(modelId, loading)
  }
  return loading
}

async function voiceover(request: Extract<EngineRequest, { type: 'voiceover' }>): Promise<void> {
  const tts = await loadKokoro(request.id)
  post({ id: request.id, type: 'status', message: 'Speaking' })
  // Long text is spoken sentence by sentence, then joined. The splitter must be closed up front:
  // when stream() is given a plain string it never closes it and waits on the last sentence forever.
  const sentences = new TextSplitterStream()
  sentences.push(request.text)
  sentences.close()
  const parts: Float32Array[] = []
  let sampleRate = 24000
  for await (const chunk of tts.stream(sentences, { voice: request.voice as never, speed: request.speed })) {
    parts.push(chunk.audio.audio)
    sampleRate = chunk.audio.sampling_rate
    post({ id: request.id, type: 'status', message: `Speaking (${parts.length})` })
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const audio = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    audio.set(part, offset)
    offset += part.length
  }
  post({ id: request.id, type: 'voiceover', audio, sampleRate }, [audio.buffer])
}

interface WhisperParts {
  processor: (audio: Float32Array) => Promise<{ input_features: Tensor }>
  model: {
    forward(inputs: Record<string, Tensor>): Promise<{ logits: Tensor }>
    generation_config: {
      is_multilingual?: boolean
      lang_to_id?: Record<string, number>
      decoder_start_token_id: number
    }
  }
}

/**
 * Whisper picks the language from the first 30 seconds: after the start token, the language token
 * with the highest score wins. transformers.js does not do this itself and assumes English.
 */
async function detectLanguage(
  recognizer: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array
): Promise<string> {
  const { processor, model } = recognizer as unknown as WhisperParts
  const config = model.generation_config
  if (!config.is_multilingual || !config.lang_to_id) return 'en'
  const { input_features } = await processor(audio.subarray(0, 30 * 16000))
  const start = new Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1])
  const { logits } = await model.forward({ input_features, decoder_input_ids: start })
  const scores = logits.data as Float32Array
  const offset = scores.length - logits.dims[logits.dims.length - 1]
  let best = 'en'
  let bestScore = -Infinity
  for (const [token, id] of Object.entries(config.lang_to_id)) {
    const score = scores[offset + id]
    if (score > bestScore) {
      bestScore = score
      best = token.replace(/^<\|/, '').replace(/\|>$/, '')
    }
  }
  return best
}

async function transcribe(request: Extract<EngineRequest, { type: 'transcribe' }>): Promise<void> {
  const recognizer = await loadRecognizer(request.id, request.modelId, request.repo)
  let language = request.language
  if (!language) {
    post({ id: request.id, type: 'status', message: 'Detecting the language' })
    language = await detectLanguage(recognizer, request.audio)
  }
  post({ id: request.id, type: 'status', message: 'Transcribing' })
  const output = await recognizer(request.audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language,
    task: 'transcribe'
  })
  const result = Array.isArray(output) ? output[0] : output
  const chunks =
    (result as { chunks?: Array<{ text: string; timestamp: [number, number | null] }> }).chunks ?? []
  const duration = request.audio.length / 16000
  const segments = chunks
    .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? duration, text: c.text.trim() }))
    .filter((s) => s.text.length > 0)
  post({ id: request.id, type: 'transcribe', language, segments })
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const request = event.data
  try {
    if (request.type === 'voiceover') await voiceover(request)
    else await transcribe(request)
  } catch (error) {
    post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
