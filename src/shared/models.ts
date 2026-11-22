/*
 * Local AI models Kificut can download and run on the user's computer. Each one is pinned to an
 * exact Hugging Face commit, and every file is checked against the hashes Hugging Face publishes.
 * Most models run in the renderer through transformers.js on WebAssembly; models marked
 * `runtime: 'native'` run in a background process with the native ONNX Runtime. Nothing leaves the
 * computer either way.
 */

export type ModelTask = 'voiceover' | 'voice-clone' | 'transcription' | 'noise' | 'search' | 'background'

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
  /** Hugging Face repository, or for models from elsewhere the folder they are stored in. */
  repo: string
  /** Hugging Face commit, or the git commit the extras are pinned to. */
  revision: string
  /** Files to fetch from the Hugging Face repository at that revision. Empty for models from elsewhere. */
  files: string[]
  /** For tasks with several models, which one is preferred when more than one is installed. */
  rank?: number
  /** Precision to load the ONNX weights at, matching the file in `files`. */
  dtype?: string
  /**
   * 'native' models run with onnxruntime-node in a utility process, for models too slow or too
   * large for WebAssembly. They are only offered where Kificut ships that runtime.
   */
  runtime?: 'native'
  /**
   * ONNX graphs (paths in `files`) whose 4 bit matmuls are switched to ONNX Runtime's fast integer
   * path once downloaded. See src/main/onnx-patch.ts.
   */
  fastMatMuls?: string[]
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

/** Where the RNNoise speech model lives in the models folder. FFmpeg's arnndn filter reads it. */
export const RNNOISE_FOLDER = 'rnnoise/somnolent-hogwash'
export const RNNOISE_FILE = 'sh.rnnn'

export const TASK_LABELS: Record<ModelTask, string> = {
  voiceover: 'Voiceover',
  'voice-clone': 'Custom voices',
  transcription: 'Speech to text',
  noise: 'Audio cleanup',
  search: 'Footage search',
  background: 'Background removal'
}

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

/** The four ONNX graphs of Chatterbox, each with its weights in a separate .onnx_data file. */
const CHATTERBOX_PARTS = ['embed_tokens', 'speech_encoder', 'language_model', 'conditional_decoder']

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
    id: 'chatterbox-turbo',
    name: 'Chatterbox Turbo',
    task: 'voice-clone',
    description:
      'Voiceovers in your own voice, or a voice you have permission to use, learned from a recording of 10 to 20 seconds. English.',
    license: 'MIT',
    approximateSize: 725_000_000,
    repo: 'ResembleAI/chatterbox-turbo-ONNX',
    revision: 'd21799bd0354adb85e348b8a0442a8405110a2cf',
    dtype: 'q4',
    runtime: 'native',
    files: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      ...CHATTERBOX_PARTS.flatMap((part) => [`onnx/${part}_q4.onnx`, `onnx/${part}_q4.onnx_data`])
    ],
    fastMatMuls: CHATTERBOX_PARTS.map((part) => `onnx/${part}_q4.onnx`),
    extras: [],
    homepage: 'https://huggingface.co/ResembleAI/chatterbox-turbo'
  },
  {
    id: 'whisper-base',
    rank: 1,
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
    rank: 2,
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
  },
  {
    id: 'rnnoise-speech',
    name: 'RNNoise',
    task: 'noise',
    description:
      'Cleans up speech recorded with steady background noise such as fans, air conditioning, hum and computers.',
    license: 'Public domain',
    approximateSize: 297_646,
    repo: 'rnnoise/somnolent-hogwash',
    revision: '3eee541a283fd3b8f81b85b1748e3b9ccbefa04d',
    files: [],
    extras: [
      {
        url: 'https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn',
        path: `${RNNOISE_FOLDER}/${RNNOISE_FILE}`,
        sha256: '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
        size: 297_646
      }
    ],
    homepage: 'https://github.com/GregorR/rnnoise-models'
  },
  {
    id: 'clip-base',
    name: 'CLIP',
    task: 'search',
    description:
      'Finds moments in your footage from a description, such as "sunset over the sea" or "a dog running".',
    license: 'MIT',
    approximateSize: 157_000_000,
    repo: 'Xenova/clip-vit-base-patch32',
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    files: [
      'config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'vocab.json',
      'merges.txt',
      'onnx/text_model_quantized.onnx',
      'onnx/vision_model_quantized.onnx'
    ],
    extras: [],
    homepage: 'https://huggingface.co/openai/clip-vit-base-patch32'
  },
  {
    id: 'modnet',
    name: 'MODNet',
    task: 'background',
    rank: 1,
    dtype: 'fp32',
    description: 'Removes the background behind people. Small and quick enough for video clips.',
    license: 'Apache-2.0',
    approximateSize: 25_889_000,
    repo: 'Xenova/modnet',
    revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
    files: ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'],
    extras: [],
    homepage: 'https://github.com/ZHKKKe/MODNet'
  },
  {
    id: 'ormbg',
    name: 'ORMBG',
    task: 'background',
    rank: 2,
    dtype: 'q8',
    description: 'Cuts out any subject in a picture, such as products, logos or pets.',
    license: 'Apache-2.0',
    approximateSize: 44_316_000,
    repo: 'onnx-community/ormbg-ONNX',
    revision: '034e2d884afbab897e10e78fc5bb566b29533fd6',
    files: ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'],
    extras: [],
    homepage: 'https://github.com/schirrmacher/ormbg'
  }
]

/** The installed model for a task, preferring the higher ranked one. */
export function bestInstalled(task: ModelTask, installed: (id: string) => boolean): LocalModelInfo | null {
  return (
    LOCAL_MODELS.filter((m) => m.task === task && installed(m.id)).sort(
      (a, b) => (b.rank ?? 0) - (a.rank ?? 0)
    )[0] ?? null
  )
}

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
