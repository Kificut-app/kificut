import { describe, expect, it } from 'vitest'
import { KOKORO_VOICES } from './models'
import { isCustomVoiceId, splitForSpeech } from './voices'

describe('isCustomVoiceId', () => {
  it('accepts only my- followed by 8 hex digits', () => {
    expect(isCustomVoiceId('my-0a1b2c3d')).toBe(true)
    expect(isCustomVoiceId('my-0A1B2C3D')).toBe(false)
    expect(isCustomVoiceId('my-0a1b2c3')).toBe(false)
    expect(isCustomVoiceId('my-../../etc')).toBe(false)
    expect(isCustomVoiceId('af_heart')).toBe(false)
  })

  it('never matches a Kokoro voice', () => {
    expect(KOKORO_VOICES.some((v) => isCustomVoiceId(v.id))).toBe(false)
  })
})

describe('splitForSpeech', () => {
  it('splits sentences with a short pause, paragraphs with a longer one and none at the end', () => {
    const chunks = splitForSpeech(
      'Welcome back. Today we cut a travel video!\n\nFirst, drop the clips in. Then trim.'
    )
    expect(chunks.map((c) => c.text)).toEqual([
      'Welcome back.',
      'Today we cut a travel video!',
      'First, drop the clips in.',
      'Then trim.'
    ])
    expect(chunks.map((c) => c.pause)).toEqual([0.12, 0.45, 0.12, 0])
  })

  it('joins very short pieces such as abbreviations to the next sentence', () => {
    expect(splitForSpeech('Ask Dr. Smith about it. She knows.').map((c) => c.text)).toEqual([
      'Ask Dr. Smith about it.',
      'She knows.'
    ])
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitForSpeech('He said "stop." Then he left (quietly.) The end.').map((c) => c.text)).toEqual([
      'He said "stop."',
      'Then he left (quietly.)',
      'The end.'
    ])
  })

  it('keeps text without an end mark and collapses whitespace', () => {
    expect(splitForSpeech('  no full stop here\nat all  ')).toEqual([
      { text: 'no full stop here at all', pause: 0 }
    ])
  })

  it('splits long sentences at a comma, or else at a space, within the limit', () => {
    const long = `${'word '.repeat(30).trim()}, ${'more '.repeat(30).trim()}.`
    const chunks = splitForSpeech(long, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true)
    expect(chunks[0].text.endsWith(',')).toBe(true)
    expect(chunks.map((c) => c.text).join(' ')).toBe(long)

    const noBreaks = 'a'.repeat(450)
    const pieces = splitForSpeech(noBreaks, 200)
    expect(pieces.map((c) => c.text.length)).toEqual([200, 200, 50])
  })

  it('returns nothing for blank text', () => {
    expect(splitForSpeech(' \n\n \t')).toEqual([])
  })
})
