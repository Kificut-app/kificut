export type TrackKind = 'video' | 'audio'
export type MediaKind = 'video' | 'audio' | 'image'
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'solid'

export interface MediaItem {
  id: string
  kind: MediaKind
  name: string
  path: string
  /** Path relative to the project file, refreshed on save. Used to relocate moved projects. */
  relativePath?: string
  /** Seconds. Zero for still images. */
  duration: number
  width: number
  height: number
  fps: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
  container: string
  size: number
}

export interface Transform {
  /** Offset from frame center, in project pixels. */
  x: number
  y: number
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  opacity: number
  flipH: boolean
  flipV: boolean
  /** Fractions of the visible width/height removed from each side. */
  cropLeft: number
  cropRight: number
  cropTop: number
  cropBottom: number
}

export interface ColorAdjust {
  brightness: number
  contrast: number
  saturation: number
  gamma: number
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  content: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  italic: boolean
  color: string
  align: TextAlign
  lineHeight: number
  letterSpacing: number
  strokeColor: string
  strokeWidth: number
  backgroundColor: string
  backgroundOpacity: number
  padding: number
  shadow: boolean
}

export interface Clip {
  id: string
  trackId: string
  kind: ClipKind
  mediaId: string | null
  name: string
  /** Position on the timeline, seconds. */
  start: number
  /** Length on the timeline, seconds. */
  duration: number
  /** Source time where the clip begins, seconds. */
  inPoint: number
  speed: number
  /** Clips sharing a link id are selected, moved, trimmed and split together. */
  linkId: string | null
  transform: Transform
  color: ColorAdjust
  /** Linear gain. 1 is unity. */
  volume: number
  fadeIn: number
  fadeOut: number
  text: TextStyle | null
  solidColor: string | null
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface Marker {
  id: string
  time: number
  label: string
  color: string
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  background: string
  sampleRate: number
}

export interface Project {
  id: string
  name: string
  settings: ProjectSettings
  media: MediaItem[]
  tracks: Track[]
  clips: Clip[]
  markers: Marker[]
  inPoint: number | null
  outPoint: number | null
  createdAt: string
  updatedAt: string
}

export interface ProjectFile {
  app: 'kificut'
  formatVersion: number
  project: Project
}

export const PROJECT_FORMAT_VERSION = 1
export const PROJECT_EXTENSION = 'kificut'

export interface ProbeResult {
  path: string
  ok: boolean
  error?: string
  media?: Omit<MediaItem, 'id'>
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface AppSettings {
  ffmpegPath: string
  ffprobePath: string
  autosave: boolean
  autosaveMinutes: number
  proxyAboveHeight: number
  previewScale: number
  showWaveforms: boolean
  showThumbnails: boolean
  /** Lets AI assistants such as Claude edit through the local connector. */
  connectorEnabled: boolean
}

export interface BinaryInfo {
  path: string
  version: string | null
  ok: boolean
}

export interface ToolInfo {
  ffmpeg: BinaryInfo
  ffprobe: BinaryInfo
}

export interface Filmstrip {
  interval: number
  frames: string[]
}

export interface Waveform {
  /** Peak values in the range 0..1. */
  peaks: Float32Array
  /** Peaks per second of source audio. */
  rate: number
}

export interface MediaFileEntry {
  path: string
  name: string
  size: number
  modified: string
}

export interface MediaFileList {
  folder: string
  files: MediaFileEntry[]
  truncated: boolean
}

export interface SampledFrame {
  /** Source time in seconds. */
  time: number
  /** Base64 JPEG. */
  data: string
}

export interface MediaAnalysis {
  /** Source times where the picture changes to a new shot. */
  scenes: number[]
  silences: Array<{ start: number; end: number }>
}

export interface AiStatus {
  enabled: boolean
  connected: boolean
  client: string | null
  /** The Claude Desktop bundle shipped with this build, if any. */
  bundleAvailable: boolean
}

export interface ProxyStatus {
  state: 'pending' | 'ready' | 'failed'
  progress: number
  path?: string
  error?: string
}
