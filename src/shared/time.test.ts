import { describe, expect, it } from 'vitest'
import { dbToGain, formatDuration, formatTimecode, gainToDb, parseTimecode, snapToFrame } from './time'

describe('timecode', () => {
  it('formats seconds as HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(1.5, 30)).toBe('00:00:01:15')
    expect(formatTimecode(3661 + 2 / 25, 25)).toBe('01:01:01:02')
  })

  it('does not lose a frame to floating point error', () => {
    expect(formatTimecode(0.1 + 0.2, 10)).toBe('00:00:00:03')
    expect(formatTimecode(snapToFrame(7 / 30, 30), 30)).toBe('00:00:00:07')
  })

  it('parses full and partial timecodes', () => {
    expect(parseTimecode('00:00:01:15', 30)).toBeCloseTo(1.5)
    expect(parseTimecode('1:15', 30)).toBeCloseTo(1.5)
    expect(parseTimecode('01:00:00', 30)).toBeCloseTo(60)
  })

  it('parses seconds and frame counts', () => {
    expect(parseTimecode('12.5', 30)).toBe(12.5)
    expect(parseTimecode('90f', 30)).toBe(3)
  })

  it('rejects invalid input', () => {
    expect(parseTimecode('', 30)).toBeNull()
    expect(parseTimecode('abc', 30)).toBeNull()
    expect(parseTimecode('00:00:00:30', 30)).toBeNull()
    expect(parseTimecode('00:61:00:00', 30)).toBeNull()
  })

  it('formats short durations', () => {
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})

describe('gain', () => {
  it('converts between decibels and linear gain', () => {
    expect(gainToDb(1)).toBe(0)
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(gainToDb(0.5))).toBeCloseTo(0.5)
    expect(gainToDb(0)).toBe(-Infinity)
  })
})
