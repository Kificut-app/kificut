/*
 * Recording the screen, a camera, or both. Kificut captures each source into its own MP4 file, all
 * starting at the same instant, so the screen, the camera and the voice stay in sync on the
 * timeline and stay separately editable. See src/main/recorder.ts and src/renderer/src/recorder.
 */

export type RecordingMode = 'screen' | 'camera' | 'screen-camera'
export type Resolution = 'original' | '2160' | '1440' | '1080' | '720'
export type CameraResolution = '720' | '1080'
export type FrameRate = 30 | 60
export type RecordingQuality = 'standard' | 'high'
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type PipSize = 'small' | 'medium' | 'large'

export interface DisplayInfo {
  id: number
  /** Size in physical pixels. */
  width: number
  height: number
  scaleFactor: number
  /** Position and size in screen coordinates (DIP), for placing windows on it. */
  bounds: { x: number; y: number; width: number; height: number }
  primary: boolean
}

export interface CaptureSource {
  /** desktopCapturer source id. */
  id: string
  name: string
  kind: 'screen' | 'window'
  display: DisplayInfo | null
  /** A small picture of the source as a data URL. */
  thumbnail: string
  icon: string | null
}

/** Part of a screen, as fractions of its width and height. */
export interface AreaRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RecordingOptions {
  mode: RecordingMode
  screen: {
    sourceId: string
    name: string
    kind: 'screen' | 'window'
    displayId: number | null
    /** Only part of the screen, for screens. */
    area: AreaRect | null
  } | null
  camera: { deviceId: string; label: string; resolution: CameraResolution } | null
  microphone: { deviceId: string; label: string; noiseSuppression: boolean } | null
  /** Sound playing on the computer (Windows only). */
  systemAudio: boolean
  resolution: Resolution
  fps: FrameRate
  quality: RecordingQuality
  /** Seconds before recording starts; 0 for none. */
  countdown: number
  /** Minimize Kificut while the screen is recorded. */
  hideKificut: boolean
  /** The floating bar with the timer and buttons. */
  showControls: boolean
  /** A floating picture of the camera while recording. */
  cameraPreview: boolean
  /** Where the camera goes over the screen recording on the timeline. */
  pip: { corner: PipCorner; size: PipSize }
}

export interface RecorderSupport {
  platform: 'darwin' | 'win32' | 'linux' | string
  /**
   * The system's own dialog chooses the screen or window when recording starts (Linux on Wayland,
   * through PipeWire and the desktop portal). Kificut cannot list sources or record an area then.
   */
  systemPicker: boolean
  /** Electron can record the computer's sound here. */
  systemAudio: boolean
  /** Kificut's own floating windows stay out of screen recordings (Windows 10 2004 and later). */
  controlsHiddenFromCapture: boolean
  /** macOS privacy settings; 'granted' elsewhere. */
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  recordingsFolder: string
  /** Free space where recordings are saved, in bytes, or null when unknown. */
  freeBytes: number | null
}

/** The screen source id used when the system's dialog picks the screen or window. */
export const SYSTEM_PICKER_SOURCE = 'system-picker'

/**
 * A Wayland session, where Chromium captures the screen through PipeWire and the desktop portal
 * instead of X11. Mirrors WebRTC's own test: XDG_SESSION_TYPE is wayland and WAYLAND_DISPLAY is set.
 */
export function isWaylandSession(env: Record<string, string | undefined>): boolean {
  return (env.XDG_SESSION_TYPE ?? '').startsWith('wayland') && !!env.WAYLAND_DISPLAY
}

export type TrackSource = 'screen' | 'camera' | 'microphone' | 'system'
export type FileRole = 'screen' | 'camera' | 'system-audio'

/** What goes into one recorded file. */
export interface FilePlan {
  role: FileRole
  video: 'screen' | 'camera' | null
  audio: 'microphone' | 'system' | null
}

/**
 * Decides which file each source is recorded into. Every file has at most one video and one audio
 * track, because that is what the editor imports. The voice goes with the camera when there is one
 * (so lips and voice come from one file), otherwise with the screen. The computer's sound goes with
 * the screen, or into a file of its own when the voice already took the screen file's audio.
 */
export function planFiles(
  options: Pick<RecordingOptions, 'mode' | 'microphone' | 'systemAudio'>
): FilePlan[] {
  const hasCamera = options.mode !== 'screen'
  const hasScreen = options.mode !== 'camera'
  const mic = options.microphone !== null
  const system = hasScreen && options.systemAudio
  const plans: FilePlan[] = []
  if (hasScreen) {
    const audio = system ? 'system' : !hasCamera && mic ? 'microphone' : null
    // Screen only with both kinds of sound: the voice joins the screen, the computer's sound gets its own file.
    if (!hasCamera && mic && system) {
      plans.push({ role: 'screen', video: 'screen', audio: 'microphone' })
      plans.push({ role: 'system-audio', video: null, audio: 'system' })
    } else {
      plans.push({ role: 'screen', video: 'screen', audio })
    }
  }
  if (hasCamera) plans.push({ role: 'camera', video: 'camera', audio: mic ? 'microphone' : null })
  return plans
}

/** Resolutions in the order they are offered. */
export const RESOLUTIONS: Resolution[] = ['original', '2160', '1440', '1080', '720']

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  original: 'Full resolution',
  '2160': '4K (2160p)',
  '1440': '1440p',
  '1080': '1080p',
  '720': '720p'
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

/**
 * The size to record a source of the given pixel size at: it fits inside a 16:9 box of the chosen
 * height, keeps its shape, is never enlarged, and has even sides as H.264 requires.
 */
export function fitOutputSize(
  width: number,
  height: number,
  resolution: Resolution
): { width: number; height: number } {
  const target = resolution === 'original' ? null : Number(resolution)
  const scale = target ? Math.min(1, (target * 16) / 9 / width, target / height) : 1
  return { width: even(width * scale), height: even(height * scale) }
}

export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/** An area of a frame in whole pixels on even boundaries, at least 64 pixels each way. */
export function areaToPixels(area: AreaRect, frameWidth: number, frameHeight: number): PixelRect {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const x0 = clamp(area.x)
  const y0 = clamp(area.y)
  const x1 = clamp(area.x + area.width)
  const y1 = clamp(area.y + area.height)
  let width = even((x1 - x0) * frameWidth)
  let height = even((y1 - y0) * frameHeight)
  width = Math.min(Math.max(width, 64), even(frameWidth))
  height = Math.min(Math.max(height, 64), even(frameHeight))
  const left = Math.min(Math.floor((x0 * frameWidth) / 2) * 2, even(frameWidth) - width)
  const top = Math.min(Math.floor((y0 * frameHeight) / 2) * 2, even(frameHeight) - height)
  return { left: Math.max(0, left), top: Math.max(0, top), width, height }
}

/**
 * H.264 bitrate for screen and camera recordings. Screens are mostly still with sharp text, so this
 * is generous per pixel; doubling the frame rate costs about two thirds more, not twice as much.
 */
export function videoBitrate(width: number, height: number, fps: number, quality: RecordingQuality): number {
  const bitsPerPixel = quality === 'high' ? 0.2 : 0.12
  const bitrate = width * height * 30 * bitsPerPixel * Math.pow(fps / 30, 0.75)
  return Math.round(Math.min(80e6, Math.max(1.5e6, bitrate)))
}

export const AUDIO_BITRATE = 160_000

/** Bytes per second the planned files will take on disk, for the free space estimate. */
export function estimateBytesPerSecond(
  plans: FilePlan[],
  sizes: Partial<Record<'screen' | 'camera', { width: number; height: number }>>,
  fps: number,
  quality: RecordingQuality
): number {
  let bits = 0
  for (const plan of plans) {
    const size = plan.video ? sizes[plan.video] : null
    if (size) bits += videoBitrate(size.width, size.height, fps, quality)
    if (plan.audio) bits += AUDIO_BITRATE
  }
  return bits / 8
}

export const CAMERA_SIZES: Record<CameraResolution, { width: number; height: number }> = {
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 }
}

const PIP_WIDTH: Record<PipSize, number> = { small: 0.2, medium: 0.27, large: 0.36 }

/**
 * Transform values that put a camera recording in a corner of the frame, for clips that are fitted
 * to the frame (see computeLayer in geometry.ts): `scale` is relative to the fitted size and `x`, `y`
 * are offsets of the center from the middle of the frame.
 */
export function pipTransform(
  source: { width: number; height: number },
  frame: { width: number; height: number },
  corner: PipCorner,
  size: PipSize
): { x: number; y: number; scale: number } {
  const fitted = Math.min(frame.width / source.width, frame.height / source.height)
  const width = frame.width * PIP_WIDTH[size]
  const scale = width / (source.width * fitted)
  const height = source.height * fitted * scale
  const margin = Math.round(Math.min(frame.width, frame.height) * 0.035)
  const right = corner.endsWith('right')
  const bottom = corner.startsWith('bottom')
  const cx = right ? frame.width - margin - width / 2 : margin + width / 2
  const cy = bottom ? frame.height - margin - height / 2 : margin + height / 2
  const round = (v: number) => Math.round(v * 1000) / 1000
  return { x: round(cx - frame.width / 2), y: round(cy - frame.height / 2), scale: round(scale) }
}

/** "2026-11-21 21.38.05", safe in file names on every system. */
export function recordingStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`
}

const ROLE_NAMES: Record<FileRole, string> = {
  screen: 'Screen',
  camera: 'Camera',
  'system-audio': 'Computer sound'
}

export function recordingFileName(stamp: string, role: FileRole): string {
  return `${stamp} ${ROLE_NAMES[role]}.${role === 'system-audio' ? 'm4a' : 'mp4'}`
}

/** 0:07, 12:34 or 1:02:03. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

/** Global shortcuts while recording; they work even when Kificut is hidden. */
export const RECORDING_SHORTCUTS = {
  stop: 'CmdOrCtrl+Shift+2',
  pause: 'CmdOrCtrl+Shift+1'
} as const

/** A shortcut as the platform shows it: ⌘⇧2 on macOS, Ctrl+Shift+2 elsewhere. */
export function shortcutLabel(accelerator: string, mac: boolean): string {
  if (!mac) return accelerator.replace('CmdOrCtrl', 'Ctrl')
  return accelerator.replace('CmdOrCtrl', '⌘').replace('Shift', '⇧').replace('Alt', '⌥').replace(/\+/g, '')
}

export type RecorderPhase = 'preparing' | 'countdown' | 'recording' | 'paused' | 'saving'

export interface RecorderStatus {
  phase: RecorderPhase
  /** Seconds recorded, without pauses. */
  elapsed: number
  /** Seconds left in the countdown. */
  countdown: number
  /** Microphone level from 0 to 1, when there is a microphone. */
  level: number | null
}

export type RecorderCommand = 'pause' | 'resume' | 'toggle-pause' | 'stop' | 'discard'

export interface RecordedFile {
  role: FileRole
  path: string
}

export interface RecordingResult {
  files: RecordedFile[]
  duration: number
  options: RecordingOptions
  /** Why the recording stopped, when Kificut stopped it (for example the disk filled up). */
  note?: string
}

/** What the recorder window needs to start: the options and where each file goes. */
export interface RecorderSession {
  options: RecordingOptions
  plans: FilePlan[]
  /** The screen or window is picked in the system's dialog (see RecorderSupport). */
  systemPicker: boolean
  /** The display being recorded, for screens. */
  display: DisplayInfo | null
}

/** Sent by the recorder window when the files are complete. */
export interface RecorderSummary {
  duration: number
}

export const DEFAULT_RECORDING_OPTIONS: Omit<RecordingOptions, 'screen' | 'camera' | 'microphone'> = {
  mode: 'screen',
  systemAudio: false,
  resolution: '1080',
  fps: 30,
  quality: 'standard',
  countdown: 3,
  hideKificut: true,
  showControls: true,
  cameraPreview: true,
  pip: { corner: 'bottom-right', size: 'medium' }
}
