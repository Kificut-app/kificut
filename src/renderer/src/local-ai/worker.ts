/// <reference lib="webworker" />
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  env,
  pipeline,
  RawImage,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type BackgroundRemovalPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor
} from '@huggingface/transformers'
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
    task: request.task
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

/* Footage search with CLIP */

const cached = new Map<string, Promise<unknown>>()

/** Loads something once per key and keeps it; a failed load is retried next time. */
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let loading = cached.get(key) as Promise<T> | undefined
  if (!loading) {
    loading = load()
    loading.catch(() => cached.delete(key))
    cached.set(key, loading)
  }
  return loading
}

function normalizeRows(data: Float32Array, dim: number): Float32Array {
  const out = new Float32Array(data.length)
  for (let row = 0; row < data.length / dim; row++) {
    let sum = 0
    for (let i = 0; i < dim; i++) sum += data[row * dim + i] ** 2
    const scale = 1 / Math.max(Math.sqrt(sum), 1e-12)
    for (let i = 0; i < dim; i++) out[row * dim + i] = data[row * dim + i] * scale
  }
  return out
}

async function embedText(request: Extract<EngineRequest, { type: 'embed-text' }>): Promise<void> {
  const [tokenizer, model] = await Promise.all([
    once(`${request.repo}:tokenizer`, () => AutoTokenizer.from_pretrained(request.repo)),
    once(`${request.repo}:text`, () =>
      CLIPTextModelWithProjection.from_pretrained(request.repo, { dtype: 'q8', device: 'wasm' })
    )
  ])
  const inputs = (tokenizer as PreTrainedTokenizer)(request.texts, { padding: true, truncation: true })
  const { text_embeds } = (await (model as PreTrainedModel)(inputs)) as { text_embeds: Tensor }
  const dim = text_embeds.dims[text_embeds.dims.length - 1]
  const vectors = normalizeRows(text_embeds.data as Float32Array, dim)
  post({ id: request.id, type: 'embeddings', vectors, dim }, [vectors.buffer])
}

async function embedFrames(request: Extract<EngineRequest, { type: 'embed-frames' }>): Promise<void> {
  const [processor, model] = await Promise.all([
    once(`${request.repo}:processor`, () => AutoProcessor.from_pretrained(request.repo)),
    once(`${request.repo}:vision`, () =>
      CLIPVisionModelWithProjection.from_pretrained(request.repo, { dtype: 'q8', device: 'wasm' })
    )
  ])
  const frameBytes = request.width * request.height * 3
  const count = Math.floor(request.frames.length / frameBytes)
  const parts: Float32Array[] = []
  let dim = 0
  const BATCH = 8
  for (let start = 0; start < count; start += BATCH) {
    const images = []
    for (let i = start; i < Math.min(count, start + BATCH); i++) {
      const pixels = new Uint8ClampedArray(
        request.frames.buffer,
        request.frames.byteOffset + i * frameBytes,
        frameBytes
      )
      images.push(new RawImage(pixels, request.width, request.height, 3))
    }
    const inputs = await (processor as Processor)(images)
    const { image_embeds } = (await (model as PreTrainedModel)(inputs)) as { image_embeds: Tensor }
    dim = image_embeds.dims[image_embeds.dims.length - 1]
    parts.push(normalizeRows(image_embeds.data as Float32Array, dim))
    post({
      id: request.id,
      type: 'status',
      message: `Looking at frames (${Math.min(count, start + BATCH)} of ${count})`
    })
  }
  const vectors = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    vectors.set(part, offset)
    offset += part.length
  }
  post({ id: request.id, type: 'embeddings', vectors, dim }, [vectors.buffer])
}

/* Background removal */

function cutter(repo: string, dtype: string): Promise<BackgroundRemovalPipeline> {
  return once(`${repo}:cutout:${dtype}`, () => {
    const create = pipeline as unknown as (
      task: 'background-removal',
      model: string,
      options: Record<string, unknown>
    ) => Promise<BackgroundRemovalPipeline>
    return create('background-removal', repo, { dtype, device: 'wasm' })
  })
}

async function cutout(request: Extract<EngineRequest, { type: 'cutout' }>): Promise<void> {
  post({ id: request.id, type: 'status', message: 'Loading the model' })
  const remove = await cutter(request.repo, request.dtype)
  post({ id: request.id, type: 'status', message: 'Finding the subject' })
  const [result] = (await remove(await RawImage.fromBlob(request.image))) as RawImage[]
  const png = await (await result.toBlob('image/png')).arrayBuffer()
  post({ id: request.id, type: 'cutout', png }, [png])
}

/**
 * Masks for video frames. MODNet is run directly at the frame size (a multiple of 32), which is far
 * quicker than letting the pipeline scale every frame up to 512 pixels first.
 */
async function matte(request: Extract<EngineRequest, { type: 'matte' }>): Promise<void> {
  const model = (await once(`${request.repo}:matte:${request.dtype}`, () =>
    AutoModel.from_pretrained(request.repo, { dtype: request.dtype as 'fp32', device: 'wasm' })
  )) as PreTrainedModel
  const { width, height } = request
  const pixels = width * height
  const count = Math.floor(request.frames.length / (pixels * 3))
  const masks = new Uint8Array(count * pixels)
  const input = new Float32Array(3 * pixels)
  for (let i = 0; i < count; i++) {
    const offset = i * pixels * 3
    // RGB bytes to planar floats in [-1, 1], as MODNet was trained.
    for (let p = 0; p < pixels; p++) {
      for (let c = 0; c < 3; c++) input[c * pixels + p] = request.frames[offset + p * 3 + c] / 127.5 - 1
    }
    const outputs = (await model({ input: new Tensor('float32', input, [1, 3, height, width]) })) as Record<
      string,
      Tensor
    >
    const alpha = Object.values(outputs)[0].data as Float32Array
    for (let p = 0; p < pixels; p++)
      masks[i * pixels + p] = Math.max(0, Math.min(255, Math.round(alpha[p] * 255)))
  }
  post({ id: request.id, type: 'masks', masks }, [masks.buffer])
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const request = event.data
  try {
    if (request.type === 'voiceover') await voiceover(request)
    else if (request.type === 'transcribe') await transcribe(request)
    else if (request.type === 'embed-text') await embedText(request)
    else if (request.type === 'embed-frames') await embedFrames(request)
    else if (request.type === 'cutout') await cutout(request)
    else await matte(request)
  } catch (error) {
    post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
