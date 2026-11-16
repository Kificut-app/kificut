import type {
  Clip,
  ColorAdjust,
  MediaItem,
  Project,
  ProjectSettings,
  TextStyle,
  Track,
  TrackKind,
  Transform
} from '@shared/types'

export function uid(prefix = ''): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix + random.slice(0, 12)
}

export function defaultTransform(): Transform {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    flipH: false,
    flipV: false,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0
  }
}

export function defaultColor(): ColorAdjust {
  return { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    content: 'Your text here',
    fontFamily: 'Inter',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    strokeColor: '#000000',
    strokeWidth: 0,
    backgroundColor: '#000000',
    backgroundOpacity: 0,
    padding: 24,
    shadow: true,
    ...overrides
  }
}

export interface ResolutionPreset {
  id: string
  label: string
  detail: string
  width: number
  height: number
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: '1080p', label: 'Landscape', detail: '1920 × 1080', width: 1920, height: 1080 },
  { id: '4k', label: '4K UHD', detail: '3840 × 2160', width: 3840, height: 2160 },
  { id: 'vertical', label: 'Vertical', detail: '1080 × 1920', width: 1080, height: 1920 },
  { id: 'square', label: 'Square', detail: '1080 × 1080', width: 1080, height: 1080 },
  { id: '720p', label: 'HD 720p', detail: '1280 × 720', width: 1280, height: 720 },
  { id: 'portrait45', label: 'Portrait 4:5', detail: '1080 × 1350', width: 1080, height: 1350 }
]

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]

export function defaultSettings(): ProjectSettings {
  return { width: 1920, height: 1080, fps: 30, background: '#000000', sampleRate: 48000 }
}

export function createTrack(kind: TrackKind, name: string): Track {
  return { id: uid('t'), kind, name, muted: false, hidden: false, locked: false }
}

export function createProject(name: string, settings: Partial<ProjectSettings> = {}): Project {
  const now = new Date().toISOString()
  return {
    id: uid('p'),
    name: name.trim() || 'Untitled Project',
    settings: { ...defaultSettings(), ...settings },
    media: [],
    tracks: [
      createTrack('video', 'V1'),
      createTrack('video', 'V2'),
      createTrack('audio', 'A1'),
      createTrack('audio', 'A2')
    ],
    clips: [],
    markers: [],
    inPoint: null,
    outPoint: null,
    createdAt: now,
    updatedAt: now
  }
}

export function createClip(
  fields: Partial<Clip> & Pick<Clip, 'trackId' | 'kind' | 'start' | 'duration'>
): Clip {
  return {
    id: uid('c'),
    mediaId: null,
    name: '',
    inPoint: 0,
    speed: 1,
    linkId: null,
    transform: defaultTransform(),
    color: defaultColor(),
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    text: null,
    solidColor: null,
    ...fields
  }
}

export const DEFAULT_STILL_DURATION = 5

export function clipsForMedia(
  media: MediaItem,
  videoTrackId: string | null,
  audioTrackId: string | null,
  start: number
): Clip[] {
  const name = media.name.replace(/\.[^.]+$/, '')
  if (media.kind === 'image') {
    if (!videoTrackId) return []
    return [
      createClip({
        kind: 'image',
        mediaId: media.id,
        name,
        trackId: videoTrackId,
        start,
        duration: DEFAULT_STILL_DURATION
      })
    ]
  }
  if (media.kind === 'audio') {
    if (!audioTrackId) return []
    return [
      createClip({
        kind: 'audio',
        mediaId: media.id,
        name,
        trackId: audioTrackId,
        start,
        duration: media.duration
      })
    ]
  }
  const clips: Clip[] = []
  const linkId = media.hasAudio && videoTrackId && audioTrackId ? uid('l') : null
  if (videoTrackId) {
    clips.push(
      createClip({
        kind: 'video',
        mediaId: media.id,
        name,
        trackId: videoTrackId,
        start,
        duration: media.duration,
        linkId
      })
    )
  }
  if (media.hasAudio && audioTrackId) {
    clips.push(
      createClip({
        kind: 'audio',
        mediaId: media.id,
        name,
        trackId: audioTrackId,
        start,
        duration: media.duration,
        linkId
      })
    )
  }
  return clips
}

export interface TextPreset {
  id: string
  label: string
  style: Partial<TextStyle>
  /** Vertical position as a fraction of frame height from center. */
  y: number
  x?: number
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', label: 'Title', style: { content: 'Title', fontSize: 140, fontWeight: 800 }, y: 0 },
  {
    id: 'subtitle',
    label: 'Subtitle',
    style: { content: 'Subtitle text', fontSize: 54, fontWeight: 500, shadow: true },
    y: 0.36
  },
  {
    id: 'lower-third',
    label: 'Lower third',
    style: {
      content: 'Jamie Rivera\nProducer',
      fontSize: 48,
      fontWeight: 600,
      align: 'left',
      backgroundOpacity: 0.72,
      backgroundColor: '#101014',
      padding: 28,
      shadow: false
    },
    y: 0.3,
    x: -0.28
  },
  {
    id: 'caption',
    label: 'Caption',
    style: {
      content: 'Caption',
      fontSize: 44,
      fontWeight: 600,
      color: '#111111',
      backgroundColor: '#ffffff',
      backgroundOpacity: 1,
      padding: 18,
      shadow: false
    },
    y: 0.38
  },
  {
    id: 'outline',
    label: 'Outline',
    style: {
      content: 'OUTLINE',
      fontSize: 120,
      fontWeight: 900,
      strokeWidth: 6,
      strokeColor: '#000000',
      shadow: false
    },
    y: 0
  },
  {
    id: 'serif',
    label: 'Serif',
    style: { content: 'A quiet morning', fontFamily: 'Georgia', fontSize: 96, fontWeight: 400, italic: true },
    y: 0
  }
]

export const SOLID_PRESETS = [
  '#000000',
  '#ffffff',
  '#1f2a44',
  '#c0392b',
  '#f2b134',
  '#2e8b57',
  '#6c5ce7',
  '#ff7a59'
]
