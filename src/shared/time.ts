const EPSILON = 1e-6

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps
}

export function frameDuration(fps: number): number {
  return 1 / fps
}

function pad(value: number, size = 2): string {
  return String(Math.floor(value)).padStart(size, '0')
}

/** Formats seconds as HH:MM:SS:FF. */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps)
  const totalFrames = Math.max(0, Math.round(seconds * fps + EPSILON))
  const frames = totalFrames % rate
  const totalSeconds = Math.floor(totalFrames / rate)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`
}

/** Short human readable duration, e.g. 4:05 or 1:02:09. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

/** Precise duration for inspector fields, e.g. 3.25s or 1:04.50. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(2)}s`
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

/**
 * Parses timecode input. Accepts HH:MM:SS:FF, MM:SS:FF, SS:FF, a plain number of seconds
 * ("12.5"), or a frame count suffixed with "f" ("48f"). Returns null for invalid input.
 */
export function parseTimecode(input: string, fps: number): number | null {
  const text = input.trim()
  if (!text) return null

  if (/^\d+f$/i.test(text)) {
    return parseInt(text, 10) / fps
  }
  if (/^\d+(\.\d+)?s?$/.test(text)) {
    return parseFloat(text)
  }

  const parts = text.split(/[:;.]/)
  if (parts.length < 2 || parts.length > 4) return null
  if (parts.some((p) => !/^\d+$/.test(p))) return null

  const numbers = parts.map((p) => parseInt(p, 10))
  while (numbers.length < 4) numbers.unshift(0)
  const [h, m, s, f] = numbers
  if (f >= Math.round(fps) || s >= 60 || m >= 60) return null
  return h * 3600 + m * 60 + s + f / fps
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity
  return 20 * Math.log10(gain)
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.pow(10, db / 20)
}
