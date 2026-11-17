/*
 * Local AI models Kificut can download and run on the user's computer. Each one is pinned to an
 * exact Hugging Face commit, and every file is checked against the hashes Hugging Face publishes.
 * Models run in the renderer through transformers.js (WebGPU when available, WebAssembly
 * otherwise), so nothing leaves the computer.
 */

export type ModelTask = 'voiceover' | 'transcription'

/** A file fetched from somewhere other than the model repository, with a pinned hash. */
export interface ExtraFile {
  url: string
  /** Where it is stored, relative to the models folder. */
  path: string
  sha256: string
  size: number
}

export interface LocalModelInfo {
  id: string
  name: string
  task: ModelTask
  description: string
  license: string
  /** Approximate download size in bytes, for display before the file list is fetched. */
  approximateSize: number
  repo: string
  revision: string
  files: string[]
  extras: ExtraFile[]
  homepage: string
}

export interface KokoroVoice {
  id: string
  name: string
  accent: 'American' | 'British'
  gender: 'Female' | 'Male'
}

const VOICE_DATA: Array<[string, string, string, string]> = [
  ['af_heart', 'Heart', 'en-us', 'Female'],
  ['af_alloy', 'Alloy', 'en-us', 'Female'],
  ['af_aoede', 'Aoede', 'en-us', 'Female'],
  ['af_bella', 'Bella', 'en-us', 'Female'],
  ['af_jessica', 'Jessica', 'en-us', 'Female'],
  ['af_kore', 'Kore', 'en-us', 'Female'],
  ['af_nicole', 'Nicole', 'en-us', 'Female'],
  ['af_nova', 'Nova', 'en-us', 'Female'],
  ['af_river', 'River', 'en-us', 'Female'],
  ['af_sarah', 'Sarah', 'en-us', 'Female'],
  ['af_sky', 'Sky', 'en-us', 'Female'],
  ['am_adam', 'Adam', 'en-us', 'Male'],
  ['am_echo', 'Echo', 'en-us', 'Male'],
  ['am_eric', 'Eric', 'en-us', 'Male'],
  ['am_fenrir', 'Fenrir', 'en-us', 'Male'],
  ['am_liam', 'Liam', 'en-us', 'Male'],
  ['am_michael', 'Michael', 'en-us', 'Male'],
  ['am_onyx', 'Onyx', 'en-us', 'Male'],
  ['am_puck', 'Puck', 'en-us', 'Male'],
  ['am_santa', 'Santa', 'en-us', 'Male'],
  ['bf_emma', 'Emma', 'en-gb', 'Female'],
  ['bf_isabella', 'Isabella', 'en-gb', 'Female'],
  ['bf_alice', 'Alice', 'en-gb', 'Female'],
  ['bf_lily', 'Lily', 'en-gb', 'Female'],
  ['bm_george', 'George', 'en-gb', 'Male'],
  ['bm_lewis', 'Lewis', 'en-gb', 'Male'],
  ['bm_daniel', 'Daniel', 'en-gb', 'Male'],
  ['bm_fable', 'Fable', 'en-gb', 'Male']
]

export const KOKORO_VOICES: KokoroVoice[] = VOICE_DATA.map(([id, name, lang, gender]) => ({
  id,
  name,
  accent: lang === 'en-gb' ? 'British' : 'American',
  gender: gender as KokoroVoice['gender']
}))

export const DEFAULT_VOICE = 'af_heart'

/**
 * eSpeak NG, which Kokoro uses to turn text into phonemes, is GPL licensed. It is downloaded with
 * the Kokoro model instead of being shipped inside Kificut.
 */
export const PHONEMIZER_PATH = 'phonemizer/phonemizer-1.2.1.js'

const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',
  'vocab.json',
  'merges.txt',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]

export const LOCAL_MODELS: LocalModelInfo[] = [
  {
    id: 'kokoro-82m',
    name: 'Kokoro',
    task: 'voiceover',
    description: 'Natural sounding English voiceovers from text, with 28 American and British voices.',
    license: 'Apache-2.0, eSpeak NG under GPL-3.0',
    approximateSize: 108_000_000,
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
      ...KOKORO_VOICES.map((v) => `voices/${v.id}.bin`)
    ],
    extras: [
      {
        url: 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js',
        path: PHONEMIZER_PATH,
        sha256: '193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec',
        size: 1_322_380
      }
    ],
    homepage: 'https://huggingface.co/hexgrad/Kokoro-82M'
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    task: 'transcription',
    description: 'Fast speech to text in about 100 languages. Good for captions and finding what was said.',
    license: 'MIT',
    approximateSize: 82_000_000,
    repo: 'onnx-community/whisper-base',
    revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
    files: WHISPER_FILES,
    extras: [],
    homepage: 'https://huggingface.co/openai/whisper-base'
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    task: 'transcription',
    description: 'More accurate speech to text than Base, at about three times the size and time.',
    license: 'MIT',
    approximateSize: 254_000_000,
    repo: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    files: WHISPER_FILES,
    extras: [],
    homepage: 'https://huggingface.co/openai/whisper-small'
  }
]

export function getLocalModel(id: string): LocalModelInfo | undefined {
  return LOCAL_MODELS.find((m) => m.id === id)
}

export interface ModelStatus {
  id: string
  state: 'not-installed' | 'downloading' | 'installed' | 'error'
  /** Bytes downloaded and expected while downloading. */
  received: number
  total: number
  /** Bytes on disk once installed. */
  size: number
  error?: string
}

/** URL prefix the renderer uses to read installed model files. */
export const MODELS_URL = 'models://store/'

export interface TranscriptSegment {
  /** Seconds in the source file. */
  start: number
  end: number
  text: string
}

export interface Transcript {
  modelId: string
  language: string | null
  segments: TranscriptSegment[]
}
