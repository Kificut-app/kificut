/*
 * The user's own voices for voiceovers. Each one is a short recording that Chatterbox Turbo
 * imitates; nothing is trained. Voices are stored in the user data folder and never leave the
 * computer.
 */

/** Ids of custom voices start with this, so they never clash with Kokoro voice ids. */
export const CUSTOM_VOICE_PREFIX = 'my-'
const CUSTOM_VOICE_ID = /^my-[0-9a-f]{8}$/

export function isCustomVoiceId(id: string): boolean {
  return CUSTOM_VOICE_ID.test(id)
}

/** The model that speaks custom voices. */
export const VOICE_CLONE_MODEL = 'chatterbox-turbo'

/** Chatterbox works at 24 kHz, for the reference recording and for what it says. */
export const VOICE_SAMPLE_RATE = 24_000
/** Less than this and the voice is not recognisable. */
export const MIN_REFERENCE_SECONDS = 5
/** Chatterbox only listens to the first part of a long reference, so the rest is not kept. */
export const MAX_REFERENCE_SECONDS = 20
export const MAX_VOICE_NAME = 40

export interface CustomVoice {
  id: string
  name: string
  createdAt: string
  /** Seconds of reference audio kept after trimming silence. */
  duration: number
  source: 'recording' | 'file'
  /** When the user confirmed it is their voice or they have permission to use it. */
  consentAt: string
  /** The trimmed reference recording, a 24 kHz mono WAV file. */
  referencePath: string
}

export type VoiceSource =
  /** Audio recorded in Kificut, in any format FFmpeg reads (MediaRecorder gives WebM with Opus). */
  | { kind: 'recording'; data: Uint8Array }
  /** Part of a file on disk, such as the clip selected on the timeline. Seconds in the source. */
  | { kind: 'file'; path: string; start?: number; duration?: number }

export interface CreateVoiceRequest {
  name: string
  source: VoiceSource
  /** The user confirmed it is their own voice or they have the speaker's permission. */
  consent: boolean
}

export interface VoiceSupport {
  supported: boolean
  /** Why custom voices are not available on this computer. */
  reason?: string
}

/** Something to read aloud when recording a voice: about 20 seconds at a natural pace. */
export const READING_TEXT =
  'The morning light came through the window as I opened my notebook. I like to start every project ' +
  "with a plan, a cup of coffee and a few quiet minutes. Today we're going to look at what worked, " +
  "what didn't, and what I would do differently next time."

export interface SpeechChunk {
  text: string
  /** Seconds of silence to add after this chunk: short between sentences, longer between paragraphs. */
  pause: number
}

const SENTENCE_PAUSE = 0.12
const PARAGRAPH_PAUSE = 0.45
/** Shorter pieces (often an abbreviation like "Dr.") are joined to the next sentence. */
const MIN_PIECE = 12

/**
 * Splits a script into sentence sized chunks for Chatterbox, which speaks one chunk at a time.
 * Sentences longer than `maxChars` are split at a comma or similar, or failing that at a space.
 */
export function splitForSpeech(text: string, maxChars = 250): SpeechChunk[] {
  const chunks: SpeechChunk[] = []
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) ?? [paragraph]
    const pieces: string[] = []
    let carry = ''
    for (let i = 0; i < sentences.length; i++) {
      const sentence = (carry ? `${carry} ${sentences[i].trim()}` : sentences[i].trim()).trim()
      if (!sentence) continue
      if (sentence.length < MIN_PIECE && i < sentences.length - 1) {
        carry = sentence
        continue
      }
      carry = ''
      pieces.push(...splitLong(sentence, maxChars))
    }
    if (carry) pieces.push(...splitLong(carry, maxChars))
    pieces.forEach((piece, i) => {
      chunks.push({ text: piece, pause: i === pieces.length - 1 ? PARAGRAPH_PAUSE : SENTENCE_PAUSE })
    })
  }
  if (chunks.length > 0) chunks[chunks.length - 1].pause = 0
  return chunks
}

function splitLong(sentence: string, maxChars: number): string[] {
  const out: string[] = []
  let rest = sentence
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1)
    // Prefer a clause break in the second half of the window, then any space.
    const clause = Math.max(...[', ', '; ', ': ', ' - '].map((mark) => window.lastIndexOf(mark)))
    const cut = clause > maxChars / 2 ? clause + 1 : window.lastIndexOf(' ')
    const at = cut > 0 ? cut : maxChars
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}
