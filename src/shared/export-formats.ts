export type ExportFormatId = 'mp4-h264' | 'mp4-h265' | 'webm-vp9' | 'mov-prores' | 'gif' | 'mp3' | 'wav'
export type ExportQuality = 'high' | 'standard' | 'small'

export interface ExportFormat {
  id: ExportFormatId
  label: string
  detail: string
  extension: string
  video: boolean
  audio: boolean
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: 'mp4-h264',
    label: 'MP4 (H.264)',
    detail: 'Plays everywhere. Best for sharing and uploads.',
    extension: 'mp4',
    video: true,
    audio: true
  },
  {
    id: 'mp4-h265',
    label: 'MP4 (HEVC)',
    detail: 'Smaller files at the same quality. Slower to encode.',
    extension: 'mp4',
    video: true,
    audio: true
  },
  {
    id: 'webm-vp9',
    label: 'WebM (VP9)',
    detail: 'Open format for the web.',
    extension: 'webm',
    video: true,
    audio: true
  },
  {
    id: 'mov-prores',
    label: 'QuickTime (ProRes 422)',
    detail: 'Intermediate codec for further editing. Large files.',
    extension: 'mov',
    video: true,
    audio: true
  },
  {
    id: 'gif',
    label: 'Animated GIF',
    detail: 'Short loops without sound.',
    extension: 'gif',
    video: true,
    audio: false
  },
  {
    id: 'mp3',
    label: 'MP3 audio',
    detail: 'Audio only, compressed.',
    extension: 'mp3',
    video: false,
    audio: true
  },
  {
    id: 'wav',
    label: 'WAV audio',
    detail: 'Audio only, uncompressed 16-bit PCM.',
    extension: 'wav',
    video: false,
    audio: true
  }
]

export function getExportFormat(id: ExportFormatId): ExportFormat {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0]
}

export interface ExportSettings {
  format: ExportFormatId
  width: number
  height: number
  fps: number
  quality: ExportQuality
  audioBitrate: number
  /** Timeline range to render, in seconds. */
  start: number
  end: number
  outputPath: string
}

export interface ExportProgress {
  /** 0..1 */
  progress: number
  /** Seconds of output rendered so far. */
  time: number
  speed: number | null
  etaSeconds: number | null
}

export interface ExportResult {
  ok: boolean
  cancelled?: boolean
  error?: string
  outputPath?: string
  elapsed?: number
}
