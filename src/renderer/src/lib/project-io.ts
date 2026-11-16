import {
  PROJECT_FORMAT_VERSION,
  type Clip,
  type MediaItem,
  type Project,
  type ProjectFile,
  type Track
} from '@shared/types'
import {
  createTrack,
  defaultColor,
  defaultSettings,
  defaultTextStyle,
  defaultTransform,
  uid
} from './factory'

export function toProjectFile(project: Project): ProjectFile {
  return { app: 'kificut', formatVersion: PROJECT_FORMAT_VERSION, project }
}

type Loose<T> = { [K in keyof T]?: unknown }

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Validates a parsed project file and fills in anything missing, so files written by older
 * versions (or edited by hand) still open.
 */
export function parseProjectFile(data: unknown): Project {
  const file = data as Partial<ProjectFile>
  if (!file || file.app !== 'kificut' || typeof file.project !== 'object' || !file.project) {
    throw new Error('This file is not a Kificut project.')
  }
  if ((file.formatVersion ?? 1) > PROJECT_FORMAT_VERSION) {
    throw new Error('This project was saved by a newer version of Kificut. Please update to open it.')
  }

  const raw = file.project as Loose<Project>
  const settingsRaw = (raw.settings ?? {}) as Loose<Project['settings']>
  const defaults = defaultSettings()

  const media: MediaItem[] = (Array.isArray(raw.media) ? raw.media : []).map((m: Loose<MediaItem>) => ({
    id: str(m.id, uid('m')),
    kind: m.kind === 'audio' || m.kind === 'image' ? m.kind : 'video',
    name: str(m.name, 'Media'),
    path: str(m.path, ''),
    relativePath: typeof m.relativePath === 'string' ? m.relativePath : undefined,
    duration: num(m.duration, 0),
    width: num(m.width, 0),
    height: num(m.height, 0),
    fps: num(m.fps, 30),
    hasVideo: bool(m.hasVideo, m.kind !== 'audio'),
    hasAudio: bool(m.hasAudio, m.kind !== 'image'),
    videoCodec: typeof m.videoCodec === 'string' ? m.videoCodec : null,
    audioCodec: typeof m.audioCodec === 'string' ? m.audioCodec : null,
    container: str(m.container, ''),
    size: num(m.size, 0)
  }))

  const tracks: Track[] = (Array.isArray(raw.tracks) ? raw.tracks : []).map((t: Loose<Track>, i: number) => ({
    id: str(t.id, uid('t')),
    kind: t.kind === 'audio' ? 'audio' : 'video',
    name: str(t.name, `Track ${i + 1}`),
    muted: bool(t.muted, false),
    hidden: bool(t.hidden, false),
    locked: bool(t.locked, false)
  }))
  const trackIds = new Set(tracks.map((t) => t.id))

  const clips: Clip[] = (Array.isArray(raw.clips) ? raw.clips : [])
    .map((c: Loose<Clip>): Clip => ({
      id: str(c.id, uid('c')),
      trackId: str(c.trackId, ''),
      kind: (['video', 'audio', 'image', 'text', 'solid'] as const).includes(c.kind as Clip['kind'])
        ? (c.kind as Clip['kind'])
        : 'video',
      mediaId: typeof c.mediaId === 'string' ? c.mediaId : null,
      name: str(c.name, ''),
      start: Math.max(0, num(c.start, 0)),
      duration: Math.max(0.01, num(c.duration, 1)),
      inPoint: Math.max(0, num(c.inPoint, 0)),
      speed: Math.min(16, Math.max(0.1, num(c.speed, 1))),
      linkId: typeof c.linkId === 'string' ? c.linkId : null,
      transform: { ...defaultTransform(), ...((c.transform as object) ?? {}) },
      color: { ...defaultColor(), ...((c.color as object) ?? {}) },
      volume: Math.max(0, num(c.volume, 1)),
      fadeIn: Math.max(0, num(c.fadeIn, 0)),
      fadeOut: Math.max(0, num(c.fadeOut, 0)),
      text: c.text ? defaultTextStyle(c.text as object) : null,
      solidColor: typeof c.solidColor === 'string' ? c.solidColor : null
    }))
    .filter((c) => trackIds.has(c.trackId))

  return {
    id: str(raw.id, uid('p')),
    name: str(raw.name, 'Untitled Project'),
    settings: {
      width: num(settingsRaw.width, defaults.width),
      height: num(settingsRaw.height, defaults.height),
      fps: num(settingsRaw.fps, defaults.fps),
      background: str(settingsRaw.background, defaults.background),
      sampleRate: num(settingsRaw.sampleRate, defaults.sampleRate)
    },
    media,
    tracks: tracks.length ? tracks : [createTrack('video', 'V1'), createTrack('audio', 'A1')],
    clips,
    markers: (Array.isArray(raw.markers) ? raw.markers : []).map((m: Loose<Project['markers'][number]>) => ({
      id: str(m.id, uid('k')),
      time: Math.max(0, num(m.time, 0)),
      label: str(m.label, ''),
      color: str(m.color, '#f5c451')
    })),
    inPoint: typeof raw.inPoint === 'number' ? raw.inPoint : null,
    outPoint: typeof raw.outPoint === 'number' ? raw.outPoint : null,
    createdAt: str(raw.createdAt, new Date().toISOString()),
    updatedAt: str(raw.updatedAt, new Date().toISOString())
  }
}
