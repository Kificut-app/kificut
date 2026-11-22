import type { Draft } from 'immer'
import type { ToolContent, ToolResult } from '@shared/ai-tools'
import { errorResult } from '@shared/connector-protocol'
import {
  EXPORT_FORMATS,
  getExportFormat,
  type ExportFormatId,
  type ExportQuality,
  type ExportSettings
} from '@shared/export-formats'
import { clamp, dbToGain, formatTimecode, gainToDb, snapToFrame } from '@shared/time'
import type { Clip, MediaItem, Project, TextStyle, TrackKind, Transform } from '@shared/types'
import { beginGesture, commit, endGesture, isDirty, seek, select, undo, useEditor } from '../store/editor'
import {
  addSolidClip,
  addTextClip,
  addTrack,
  adopt,
  confirmDiscardChanges,
  importPaths,
  MARKER_COLORS,
  newProject,
  placeMedia,
  renameProject,
  saveProject,
  updateProjectSettings,
  zoomToFit
} from '../store/actions'
import { toast } from '../store/ui'
import {
  clipEnd,
  displayTracks,
  findFreeTrack,
  maxDuration,
  projectDuration,
  resolveOverlaps,
  rippleDelete,
  splitClips,
  trackClips,
  tracksOfKind,
  withLinked
} from '../lib/timeline'
import { defaultColor, defaultTransform, TEXT_PRESETS, uid } from '../lib/factory'
import {
  DEFAULT_VOICE,
  getLocalModel,
  KOKORO_VOICES,
  LOCAL_MODELS,
  type ModelStatus,
  type ModelTask
} from '@shared/models'
import { VOICE_CLONE_MODEL } from '@shared/voices'
import {
  nearest,
  nearestAspect,
  SUGGESTED_MODELS,
  type AspectRatio,
  type GenerationJob,
  type GenerationKind,
  type GenerationRequest,
  type GenerationService,
  type GenerationSettings
} from '@shared/generation'
import { startGeneration, useGeneration } from '../store/generation'
import {
  captionsForClip,
  cleanAudio,
  createVoiceover,
  cutoutImage,
  findShots,
  ModelMissingError,
  modelName,
  removeVideoBackground,
  transcribeMedia
} from '../local-ai/features'
import { player } from '../engine/player'
import { runExport } from '../engine/export'

/** A problem the assistant can fix by calling the tool differently. */
class ToolError extends Error {}

type Args = Record<string, unknown>
type Tool = (args: Args) => Promise<ToolResult> | ToolResult

/* Small helpers */

const r3 = (n: number): number => Math.round(n * 1000) / 1000
const r1 = (n: number): number => Math.round(n * 10) / 10

function text(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }] }
}

function json(summary: string, data: unknown): ToolResult {
  return text(`${summary}\n\n${JSON.stringify(data, null, 2)}`)
}

function string(args: Args, key: string, required = false): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`"${key}" is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`)
  return value
}

function number(
  args: Args,
  key: string,
  opts: { min?: number; max?: number; required?: boolean } = {}
): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (opts.required) throw new ToolError(`"${key}" is required.`)
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolError(`"${key}" must be a number.`)
  if (opts.min !== undefined && value < opts.min)
    throw new ToolError(`"${key}" must be at least ${opts.min}.`)
  if (opts.max !== undefined && value > opts.max) throw new ToolError(`"${key}" must be at most ${opts.max}.`)
  return value
}

function bool(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolError(`"${key}" must be true or false.`)
  return value
}

function object(args: Args, key: string): Args | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`"${key}" must be an object.`)
  return value as Args
}

function hexColor(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new ToolError(`"${key}" must be a color like #FFAA00.`)
  return value.toLowerCase()
}

function expandHome(path: string): string {
  const home = window.kificut.homeDir
  if (!home) return path
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const sep = window.kificut.platform === 'win32' ? '\\' : '/'
    return `${home}${sep}${path.slice(2)}`
  }
  return path
}

function absolutePath(raw: string, key: string): string {
  const path = expandHome(raw.trim())
  const absolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
  if (!absolute) throw new ToolError(`"${key}" must be an absolute path, such as ~/Videos/clip.mp4.`)
  return path
}

function requireProject(): Project {
  const project = useEditor.getState().project
  if (!project) throw new ToolError('No project is open. Call new_project or open_project first.')
  return project
}

function requireMedia(project: Project, id: string | undefined): MediaItem {
  const media = project.media.find((m) => m.id === id)
  if (!media) throw new ToolError(`No media with id "${id}". Call get_project to see the media library.`)
  if (useEditor.getState().offline[media.id])
    throw new ToolError(`${media.name} is offline (the file is missing).`)
  return media
}

function requireClip(project: Project, id: string | undefined): Clip {
  const clip = project.clips.find((c) => c.id === id)
  if (!clip) throw new ToolError(`No clip with id "${id}". Call get_project to see the timeline.`)
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (track?.locked) throw new ToolError(`Track ${track.name} is locked. Ask the user to unlock it.`)
  return clip
}

/** Runs several edits as a single undo step. */
function asOneStep<T>(work: () => T): T {
  beginGesture()
  try {
    const result = work()
    endGesture()
    return result
  } catch (error) {
    endGesture(true)
    throw error
  }
}

function findTrack(project: Project, name: string) {
  return project.tracks.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())
}

/** Finds a track by name, creating it when it does not exist yet. */
function ensureNamedTrack(name: string, kind: TrackKind): string {
  const existing = findTrack(requireProject(), name)
  if (existing) {
    if (existing.kind !== kind) {
      throw new ToolError(`${existing.name} is ${existing.kind === 'video' ? 'a video' : 'an audio'} track.`)
    }
    if (existing.locked) throw new ToolError(`Track ${existing.name} is locked.`)
    return existing.id
  }
  const id = addTrack(kind)
  commit((draft) => {
    const track = draft.tracks.find((t) => t.id === id)
    if (track) track.name = name.trim().slice(0, 24)
  })
  return id
}

function kindFromTrackName(name: string, fallback: TrackKind): TrackKind {
  const first = name.trim()[0]?.toUpperCase()
  return first === 'A' ? 'audio' : first === 'V' ? 'video' : fallback
}

/* Describing the project */

const TRANSFORM_NAMES: Record<keyof Transform, string> = {
  x: 'x',
  y: 'y',
  scale: 'scale',
  rotation: 'rotation',
  opacity: 'opacity',
  flipH: 'flip_horizontal',
  flipV: 'flip_vertical',
  cropLeft: 'crop_left',
  cropRight: 'crop_right',
  cropTop: 'crop_top',
  cropBottom: 'crop_bottom'
}

function describeMedia(media: MediaItem, project: Project): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: media.id,
    name: media.name,
    type: media.kind,
    path: media.path
  }
  if (media.kind !== 'image') out.duration = r3(media.duration)
  if (media.hasVideo) out.size = `${media.width}x${media.height}`
  if (media.kind === 'video') out.fps = r3(media.fps)
  if (media.kind === 'video') out.has_sound = media.hasAudio
  const uses = project.clips.filter((c) => c.mediaId === media.id).length
  if (uses) out.clips_using_it = uses
  if (useEditor.getState().offline[media.id]) out.offline = true
  return out
}

function describeClip(clip: Clip, project: Project): Record<string, unknown> {
  const track = project.tracks.find((t) => t.id === clip.trackId)
  const out: Record<string, unknown> = {
    id: clip.id,
    type: clip.kind,
    name: clip.name,
    track: track?.name,
    start: r3(clip.start),
    end: r3(clipEnd(clip)),
    duration: r3(clip.duration)
  }
  if (clip.mediaId) out.media_id = clip.mediaId
  if (clip.kind === 'video' || clip.kind === 'audio') {
    out.in = r3(clip.inPoint)
    out.out = r3(clip.inPoint + clip.duration * clip.speed)
  }
  if (Math.abs(clip.speed - 1) > 1e-6) out.speed = clip.speed
  if (clip.kind === 'text' && clip.text) out.text = clip.text.content
  if (clip.kind === 'solid') out.fill = clip.solidColor
  if (clip.kind === 'audio' && Math.abs(clip.volume - 1) > 1e-4) {
    out.volume_db = clip.volume > 0 ? r1(gainToDb(clip.volume)) : -60
  }
  if (clip.fadeIn > 0) out.fade_in = r3(clip.fadeIn)
  if (clip.fadeOut > 0) out.fade_out = r3(clip.fadeOut)
  if (clip.linkId) {
    out.linked_with = project.clips
      .filter((c) => c.linkId === clip.linkId && c.id !== clip.id)
      .map((c) => c.id)
  }
  if (clip.kind !== 'audio') {
    const defaults = defaultTransform()
    const changed: Record<string, unknown> = {}
    for (const key of Object.keys(defaults) as Array<keyof Transform>) {
      if (clip.transform[key] !== defaults[key]) changed[TRANSFORM_NAMES[key]] = clip.transform[key]
    }
    if (Object.keys(changed).length) out.transform = changed
  }
  if (clip.kind === 'video' || clip.kind === 'image') {
    const defaults = defaultColor()
    const changed = Object.fromEntries(
      Object.entries(clip.color).filter(([k, v]) => v !== defaults[k as keyof typeof defaults])
    )
    if (Object.keys(changed).length) out.color = changed
  }
  return out
}

function describeProject(): Record<string, unknown> {
  const state = useEditor.getState()
  const project = state.project!
  const { settings } = project
  return {
    name: project.name,
    file: state.filePath,
    unsaved_changes: isDirty(state),
    format: {
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      background: settings.background
    },
    duration: r3(projectDuration(project)),
    playhead: r3(state.playhead),
    media: project.media.map((m) => describeMedia(m, project)),
    tracks: displayTracks(project).map((track) => ({
      name: track.name,
      kind: track.kind,
      ...(track.hidden ? { hidden: true } : {}),
      ...(track.muted ? { muted: true } : {}),
      ...(track.locked ? { locked: true } : {}),
      clips: trackClips(project, track.id).map((c) => describeClip(c, project))
    })),
    markers: project.markers.map((m) => ({ time: r3(m.time), label: m.label })),
    ...(project.inPoint !== null || project.outPoint !== null
      ? { in_point: project.inPoint, out_point: project.outPoint }
      : {})
  }
}

function applyTextStyle(target: Draft<TextStyle>, style: Args): void {
  const fontFamily = string(style, 'font_family')
  const fontSize = number(style, 'font_size', { min: 6, max: 1000 })
  const fontWeight = number(style, 'font_weight', { min: 100, max: 900 })
  const italic = bool(style, 'italic')
  const color = hexColor(string(style, 'color'), 'color')
  const align = string(style, 'align')
  const outlineWidth = number(style, 'outline_width', { min: 0, max: 60 })
  const outlineColor = hexColor(string(style, 'outline_color'), 'outline_color')
  const backgroundColor = hexColor(string(style, 'background_color'), 'background_color')
  const backgroundOpacity = number(style, 'background_opacity', { min: 0, max: 1 })
  const shadow = bool(style, 'shadow')
  if (align !== undefined && !['left', 'center', 'right'].includes(align)) {
    throw new ToolError('"align" must be left, center or right.')
  }
  if (fontFamily !== undefined) target.fontFamily = fontFamily
  if (fontSize !== undefined) target.fontSize = Math.round(fontSize)
  if (fontWeight !== undefined) target.fontWeight = Math.round(fontWeight / 100) * 100
  if (italic !== undefined) target.italic = italic
  if (color !== undefined) target.color = color
  if (align !== undefined) target.align = align as TextStyle['align']
  if (outlineWidth !== undefined) target.strokeWidth = Math.round(outlineWidth)
  if (outlineColor !== undefined) target.strokeColor = outlineColor
  if (backgroundColor !== undefined) target.backgroundColor = backgroundColor
  if (backgroundOpacity !== undefined) target.backgroundOpacity = backgroundOpacity
  if (shadow !== undefined) target.shadow = shadow
}

/** Breaks a caption into lines of roughly maxChars, at most two lines per caption. */
export function wrapCaption(text: string, maxChars = 42): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  if (lines.length <= 2) return lines.join('\n')
  // Rebalance into two lines rather than spilling onto a third.
  const half = Math.ceil(words.length / 2)
  return `${words.slice(0, half).join(' ')}\n${words.slice(half).join(' ')}`
}

/* Export tracking */

interface ExportJob {
  path: string
  label: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  etaSeconds: number | null
  startedAt: number
  finishedAt: number | null
  error: string | null
}

let exportJob: ExportJob | null = null

const SHORT_SIDES: Record<string, number> = {
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480
}

/* Tools */

const tools: Record<string, Tool> = {
  get_project() {
    if (!useEditor.getState().project) return text('No project is open. Call new_project or open_project.')
    return json('The open project:', describeProject())
  },

  async new_project(args) {
    const name = string(args, 'name', true)!
    const width = number(args, 'width', { min: 16, max: 7680 }) ?? 1920
    const height = number(args, 'height', { min: 16, max: 7680 }) ?? 1080
    const fps = number(args, 'fps', { min: 1, max: 120 }) ?? 30
    if (!(await confirmDiscardChanges())) {
      throw new ToolError('The user chose to keep the current project open.')
    }
    newProject(name, { width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2, fps })
    return json(`Created the project "${name}".`, describeProject())
  },

  async open_project(args) {
    const path = absolutePath(string(args, 'path', true)!, 'path')
    if (!(await confirmDiscardChanges())) {
      throw new ToolError('The user chose to keep the current project open.')
    }
    try {
      await adopt(await window.kificut.project.openPath(path))
    } catch (error) {
      throw new ToolError(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return json(`Opened ${path}.`, describeProject())
  },

  async save_project(args) {
    requireProject()
    const state = useEditor.getState()
    const given = string(args, 'path')
    let path = state.filePath
    if (given) {
      path = absolutePath(given, 'path')
      if (!/\.kificut$/i.test(path)) path += '.kificut'
      if (path !== state.filePath && (await window.kificut.media.exists([path]))[0]) {
        throw new ToolError(`${path} already exists. Choose another file name.`)
      }
    }
    if (!path) throw new ToolError('This project has not been saved before. Give a path ending in .kificut.')
    if (!(await saveProject(false, path))) throw new ToolError('Saving failed. Kificut shows the reason.')
    return text(`Saved to ${useEditor.getState().filePath}.`)
  },

  set_project_format(args) {
    requireProject()
    const name = string(args, 'name')
    const width = number(args, 'width', { min: 16, max: 7680 })
    const height = number(args, 'height', { min: 16, max: 7680 })
    const fps = number(args, 'fps', { min: 1, max: 120 })
    const background = hexColor(string(args, 'background'), 'background')
    asOneStep(() => {
      if (name) renameProject(name)
      updateProjectSettings({
        ...(width ? { width: Math.round(width / 2) * 2 } : {}),
        ...(height ? { height: Math.round(height / 2) * 2 } : {}),
        ...(fps ? { fps } : {}),
        ...(background ? { background } : {})
      })
    })
    return json('Updated the project format.', describeProject().format)
  },

  async list_media_files(args) {
    const folder = absolutePath(string(args, 'folder', true)!, 'folder')
    const result = await window.kificut.media.listFiles(folder, bool(args, 'recursive') ?? false)
    const files = result.files.map((f) => ({
      path: f.path,
      size_mb: r1(f.size / 1048576),
      modified: f.modified.slice(0, 10)
    }))
    const note = result.truncated ? ' Only the first 500 are listed.' : ''
    return json(`Found ${files.length} media files in ${result.folder}.${note}`, files)
  },

  async import_media(args) {
    const project = requireProject()
    let paths: string[] = []
    const list = args.paths
    if (list !== undefined) {
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) {
        throw new ToolError('"paths" must be a list of file paths.')
      }
      paths = list.map((p) => absolutePath(p as string, 'paths'))
    }
    const folder = string(args, 'folder')
    if (folder) {
      const found = await window.kificut.media.listFiles(absolutePath(folder, 'folder'), false)
      paths.push(...found.files.map((f) => f.path))
    }
    if (paths.length === 0) throw new ToolError('Give "paths" or a "folder" with media files in it.')

    const before = new Set(project.media.map((m) => m.id))
    const items = await importPaths(paths)
    const imported = new Set(items.map((m) => m.path))
    const failed = paths.filter((p) => !imported.has(p))
    const latest = useEditor.getState().project!
    const added = items.filter((m) => !before.has(m.id)).length
    const summary =
      `Imported ${added} new ${added === 1 ? 'file' : 'files'}` +
      (items.length > added ? `, ${items.length - added} already in the project` : '') +
      (failed.length ? `. Could not read: ${failed.join(', ')}` : '') +
      '.'
    return json(
      summary,
      items.map((m) => describeMedia(m, latest))
    )
  },

  async inspect_media(args) {
    const project = requireProject()
    const media = requireMedia(project, string(args, 'media_id', true))
    const frames = number(args, 'frames', { min: 1, max: 12 }) ?? 6
    const start = number(args, 'start', { min: 0 })
    const end = number(args, 'end', { min: 0 })
    if (start !== undefined && end !== undefined && end <= start)
      throw new ToolError('"end" must be after "start".')

    const content: ToolContent[] = [
      { type: 'text', text: JSON.stringify(describeMedia(media, project), null, 2) }
    ]
    if (!media.hasVideo) {
      content.push({
        type: 'text',
        text: 'This is audio only. Use analyze_media to find silences and sound.'
      })
      return { content }
    }
    const sampled = await window.kificut.media.sampleFrames(
      media.path,
      media.duration,
      Math.round(frames),
      start,
      end
    )
    for (const frame of sampled) {
      content.push({
        type: 'text',
        text: media.kind === 'image' ? 'The image:' : `Frame at ${frame.time.toFixed(2)}s:`
      })
      content.push({ type: 'image', data: frame.data, mimeType: 'image/jpeg' })
    }
    return { content }
  },

  async analyze_media(args) {
    const project = requireProject()
    const media = requireMedia(project, string(args, 'media_id', true))
    if (media.kind === 'image') throw new ToolError('Still images have no scenes or sound to analyze.')
    const analysis = await window.kificut.media.analyze(
      media.path,
      media.duration,
      media.hasVideo,
      media.hasAudio
    )

    // The parts with sound are often more useful than the silences themselves.
    const sound: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (const silence of analysis.silences) {
      if (silence.start - cursor > 0.05) sound.push({ start: r3(cursor), end: r3(silence.start) })
      cursor = silence.end
    }
    if (media.duration - cursor > 0.05) sound.push({ start: r3(cursor), end: r3(media.duration) })

    const parts = [
      media.hasVideo ? `${analysis.scenes.length} scene changes` : null,
      media.hasAudio ? `${analysis.silences.length} silent stretches (below -35 dB for at least 0.6 s)` : null
    ].filter(Boolean)
    return json(`${media.name}: ${parts.join(' and ')}. Times are in seconds of the source file.`, {
      duration: r3(media.duration),
      ...(media.hasVideo ? { scene_changes: analysis.scenes } : {}),
      ...(media.hasAudio ? { silences: analysis.silences, sound } : {})
    })
  },

  add_clips(args) {
    const project = requireProject()
    const specs = args.clips
    if (!Array.isArray(specs) || specs.length === 0) throw new ToolError('"clips" must be a non-empty list.')
    if (specs.length > 100) throw new ToolError('Add at most 100 clips per call.')
    const fps = project.settings.fps
    const frame = 1 / fps

    const plans = specs.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new ToolError(`Clip ${i + 1} must be an object.`)
      const spec = raw as Args
      const media = requireMedia(project, string(spec, 'media_id', true))
      const inPoint = number(spec, 'in', { min: 0 })
      const out = number(spec, 'out', { min: 0 })
      const length = number(spec, 'duration', { min: 0 })
      if (media.kind === 'image') return { media, inPoint: 0, duration: length ?? out ?? 5 }
      const from = clamp(inPoint ?? 0, 0, media.duration)
      const to = Math.min(media.duration, out ?? (length !== undefined ? from + length : media.duration))
      if (to - from < frame) {
        throw new ToolError(
          `Clip ${i + 1} (${media.name}): "out" must be after "in" and within the file (0 to ${r3(media.duration)}s).`
        )
      }
      return { media, inPoint: from, duration: to - from }
    })

    const trackName = string(args, 'track')
    const firstKind: TrackKind = plans[0].media.kind === 'audio' ? 'audio' : 'video'
    const wasEmpty = project.clips.length === 0

    const created = asOneStep(() => {
      const trackId = trackName ? ensureNamedTrack(trackName, kindFromTrackName(trackName, firstKind)) : null
      const current = useEditor.getState().project!
      const targetTrack = trackId ?? tracksOfKind(current, firstKind)[0]?.id
      const trackEnd = Math.max(0, ...current.clips.filter((c) => c.trackId === targetTrack).map(clipEnd))
      let time = snapToFrame(number(args, 'start', { min: 0 }) ?? trackEnd, fps)
      const ids: string[] = []
      for (const plan of plans) {
        ids.push(
          ...placeMedia(plan.media.id, time, trackId, { inPoint: plan.inPoint, duration: plan.duration })
        )
        time += snapToFrame(plan.duration, fps)
      }
      return ids
    })

    if (wasEmpty) requestAnimationFrame(() => zoomToFit())
    select(created)
    const latest = useEditor.getState().project!
    const clips = latest.clips.filter((c) => created.includes(c.id)).sort((a, b) => a.start - b.start)
    const start = Math.min(...clips.map((c) => c.start))
    const end = Math.max(...clips.map(clipEnd))
    return json(
      `Added ${plans.length} ${plans.length === 1 ? 'clip' : 'clips'} from ${r3(start)}s to ${r3(end)}s.`,
      clips.map((c) => describeClip(c, latest))
    )
  },

  add_text(args) {
    requireProject()
    const content = string(args, 'text', true)!.replace(/\\n/g, '\n')
    const start = number(args, 'start', { min: 0, required: true })!
    const duration = number(args, 'duration', { min: 0.05 }) ?? 4
    const preset = string(args, 'preset') ?? 'title'
    if (!TEXT_PRESETS.some((p) => p.id === preset)) {
      throw new ToolError(`Unknown preset "${preset}". Use ${TEXT_PRESETS.map((p) => p.id).join(', ')}.`)
    }
    const trackName = string(args, 'track')
    const x = number(args, 'x')
    const y = number(args, 'y')

    const id = asOneStep(() => {
      const trackId = trackName ? ensureNamedTrack(trackName, 'video') : undefined
      const clipId = addTextClip(preset, start, trackId, duration)
      if (!clipId) throw new ToolError('Could not add the text.')
      commit((draft) => {
        const clip = draft.clips.find((c) => c.id === clipId)!
        clip.text!.content = content
        clip.name = content.split('\n')[0].slice(0, 40)
        applyTextStyle(clip.text!, args)
        if (x !== undefined) clip.transform.x = Math.round(x)
        if (y !== undefined) clip.transform.y = Math.round(y)
      })
      return clipId
    })
    const latest = useEditor.getState().project!
    const clip = latest.clips.find((c) => c.id === id)!
    return json(`Added text from ${r3(clip.start)}s to ${r3(clipEnd(clip))}s.`, describeClip(clip, latest))
  },

  add_color(args) {
    requireProject()
    const color = hexColor(string(args, 'color', true), 'color')!
    const start = number(args, 'start', { min: 0, required: true })!
    const duration = number(args, 'duration', { min: 0.05 }) ?? 3
    const trackName = string(args, 'track')
    const id = asOneStep(() => {
      const trackId = trackName ? ensureNamedTrack(trackName, 'video') : undefined
      return addSolidClip(color, start, trackId, duration)
    })
    const latest = useEditor.getState().project!
    const clip = latest.clips.find((c) => c.id === id)
    if (!clip) throw new ToolError('Could not add the color layer.')
    return json('Added a color layer.', describeClip(clip, latest))
  },

  update_clip(args) {
    const project = requireProject()
    const clip = requireClip(project, string(args, 'clip_id', true))
    const fps = project.settings.fps
    const frame = 1 / fps
    const group = withLinked(project, [clip.id])

    const name = string(args, 'name')
    const start = number(args, 'start', { min: 0 })
    const trackName = string(args, 'track')
    const inPoint = number(args, 'in', { min: 0 })
    const duration = number(args, 'duration', { min: frame })
    const speed = number(args, 'speed', { min: 0.1, max: 16 })
    const volumeDb = number(args, 'volume_db', { min: -60, max: 12 })
    const fadeIn = number(args, 'fade_in', { min: 0 })
    const fadeOut = number(args, 'fade_out', { min: 0 })
    const transform = object(args, 'transform')
    const color = object(args, 'color')
    const newText = string(args, 'text')
    const style = object(args, 'style')
    const fill = hexColor(string(args, 'fill'), 'fill')

    const visual = clip.kind !== 'audio'
    if (transform && !visual) throw new ToolError('Audio clips have no picture to transform.')
    if (color && clip.kind !== 'video' && clip.kind !== 'image')
      throw new ToolError('Color correction works on video and images.')
    if ((newText !== undefined || style) && clip.kind !== 'text')
      throw new ToolError('"text" and "style" only apply to text clips.')
    if (fill && clip.kind !== 'solid') throw new ToolError('"fill" only applies to color layers.')
    if (speed !== undefined && clip.kind !== 'video' && clip.kind !== 'audio')
      throw new ToolError('Only video and audio clips have a speed.')
    if (volumeDb !== undefined && !project.clips.some((c) => group.includes(c.id) && c.kind === 'audio')) {
      throw new ToolError('This clip has no sound. Its audio may be on an unlinked clip on an audio track.')
    }

    asOneStep(() => {
      const trackId = trackName
        ? ensureNamedTrack(trackName, clip.kind === 'audio' ? 'audio' : 'video')
        : null
      commit((draft) => {
        const target = draft.clips.find((c) => c.id === clip.id)!
        const members = draft.clips.filter((c) => group.includes(c.id))
        const moved = new Set<string>()

        if (name !== undefined) target.name = name.slice(0, 80)
        if (trackId) {
          target.trackId = trackId
          moved.add(target.id)
        }
        if (start !== undefined) {
          const delta = snapToFrame(start, fps) - target.start
          for (const c of members) {
            c.start = Math.max(0, snapToFrame(c.start + delta, fps))
            moved.add(c.id)
          }
        }
        if (speed !== undefined) {
          for (const c of members) {
            if (c.kind !== 'video' && c.kind !== 'audio') continue
            const source = c.duration * c.speed
            c.speed = speed
            c.duration = Math.max(frame, snapToFrame(source / speed, fps))
            moved.add(c.id)
          }
        }
        if (inPoint !== undefined || duration !== undefined) {
          for (const c of members) {
            const media = c.mediaId ? draft.media.find((m) => m.id === c.mediaId) : undefined
            if ((c.kind === 'video' || c.kind === 'audio') && media) {
              const out = c.inPoint + c.duration * c.speed
              const nextIn = inPoint !== undefined ? clamp(inPoint, 0, media.duration - frame) : c.inPoint
              let nextDuration = duration ?? (out - nextIn) / c.speed
              nextDuration = Math.min(nextDuration, maxDuration({ ...c, inPoint: nextIn } as Clip, media))
              if (nextDuration < frame) throw new ToolError('"in" must be before the end of the clip.')
              c.inPoint = nextIn
              c.duration = snapToFrame(nextDuration, fps)
            } else if (duration !== undefined) {
              c.duration = snapToFrame(duration, fps)
            }
            moved.add(c.id)
          }
        }
        for (const c of members) {
          if (fadeIn !== undefined) c.fadeIn = Math.min(fadeIn, c.duration)
          if (fadeOut !== undefined) c.fadeOut = Math.min(fadeOut, c.duration)
          if (c.fadeIn + c.fadeOut > c.duration) c.fadeOut = Math.max(0, c.duration - c.fadeIn)
          if (volumeDb !== undefined && c.kind === 'audio')
            c.volume = volumeDb <= -60 ? 0 : dbToGain(volumeDb)
        }
        if (transform) {
          const t = target.transform
          const n = (key: string, min?: number, max?: number) => number(transform, key, { min, max })
          const set = <K extends keyof Transform>(key: K, value: Transform[K] | undefined) => {
            if (value !== undefined) t[key] = value
          }
          set('x', n('x'))
          set('y', n('y'))
          set('scale', n('scale', 0.01, 20))
          set('rotation', n('rotation'))
          set('opacity', n('opacity', 0, 1))
          set('flipH', bool(transform, 'flip_horizontal'))
          set('flipV', bool(transform, 'flip_vertical'))
          set('cropLeft', n('crop_left', 0, 0.95))
          set('cropRight', n('crop_right', 0, 0.95))
          set('cropTop', n('crop_top', 0, 0.95))
          set('cropBottom', n('crop_bottom', 0, 0.95))
        }
        if (color) {
          const c = target.color
          const brightness = number(color, 'brightness', { min: -1, max: 1 })
          const contrast = number(color, 'contrast', { min: 0, max: 2 })
          const saturation = number(color, 'saturation', { min: 0, max: 3 })
          const gamma = number(color, 'gamma', { min: 0.1, max: 3 })
          if (brightness !== undefined) c.brightness = brightness
          if (contrast !== undefined) c.contrast = contrast
          if (saturation !== undefined) c.saturation = saturation
          if (gamma !== undefined) c.gamma = gamma
        }
        if (target.text) {
          if (newText !== undefined) target.text.content = newText.replace(/\\n/g, '\n')
          if (style) applyTextStyle(target.text, style)
        }
        if (fill) target.solidColor = fill

        if (moved.size) resolveOverlaps(draft as Project, [...moved])
      })
    })

    const latest = useEditor.getState().project!
    const updated = latest.clips.filter((c) => group.includes(c.id))
    return json(
      'Updated the clip.',
      updated.map((c) => describeClip(c, latest))
    )
  },

  split_clip(args) {
    const project = requireProject()
    const fps = project.settings.fps
    const time = snapToFrame(number(args, 'time', { min: 0, required: true })!, fps)
    const clipId = string(args, 'clip_id')
    let targets: string[]
    if (clipId) {
      targets = [requireClip(project, clipId).id]
    } else {
      const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
      targets = project.clips
        .filter((c) => !locked.has(c.trackId) && time > c.start && time < clipEnd(c))
        .map((c) => c.id)
    }
    let created: string[] = []
    commit((draft) => {
      created = splitClips(draft as Project, targets, time, 1 / fps)
    })
    if (created.length === 0) {
      throw new ToolError(
        `Nothing to split at ${r3(time)}s. A cut needs at least one frame of clip on each side.`
      )
    }
    const latest = useEditor.getState().project!
    return json(
      `Split ${created.length} ${created.length === 1 ? 'clip' : 'clips'} at ${r3(time)}s. The new right hand parts:`,
      latest.clips.filter((c) => created.includes(c.id)).map((c) => describeClip(c, latest))
    )
  },

  delete_clips(args) {
    const project = requireProject()
    const ids = args.clip_ids
    if (!Array.isArray(ids) || ids.length === 0) throw new ToolError('"clip_ids" must be a non-empty list.')
    ids.forEach((id) => requireClip(project, typeof id === 'string' ? id : undefined))
    const all = withLinked(project, ids as string[])
    const ripple = bool(args, 'ripple') ?? false
    commit((draft) => {
      if (ripple) rippleDelete(draft as Project, all)
      else draft.clips = draft.clips.filter((c) => !all.includes(c.id))
    })
    return text(
      `Deleted ${all.length} ${all.length === 1 ? 'clip' : 'clips'}${ripple ? ' and closed the gaps' : ''}. The user can undo this.`
    )
  },

  add_marker(args) {
    const project = requireProject()
    const time = snapToFrame(number(args, 'time', { min: 0, required: true })!, project.settings.fps)
    const label = string(args, 'label') ?? `Marker ${project.markers.length + 1}`
    const names = ['yellow', 'blue', 'red', 'green', 'purple']
    const colorName = string(args, 'color') ?? 'yellow'
    if (!names.includes(colorName)) throw new ToolError(`"color" must be one of ${names.join(', ')}.`)
    commit((draft) => {
      draft.markers.push({
        id: uid('k'),
        time,
        label: label.slice(0, 60),
        color: MARKER_COLORS[names.indexOf(colorName)]
      })
      draft.markers.sort((a, b) => a.time - b.time)
    })
    return text(`Added the marker "${label}" at ${r3(time)}s.`)
  },

  async view_frame(args) {
    const project = requireProject()
    const time = number(args, 'time', { min: 0, required: true })!
    player.pause()
    seek(snapToFrame(time, project.settings.fps))
    const data = await player.capture(960)
    return {
      content: [
        {
          type: 'text',
          text: `The timeline at ${formatTimecode(time, project.settings.fps)} (${r3(time)}s):`
        },
        { type: 'image', data, mimeType: 'image/jpeg' }
      ]
    }
  },

  undo(args) {
    requireProject()
    const steps = Math.round(number(args, 'steps', { min: 1, max: 50 }) ?? 1)
    let done = 0
    for (let i = 0; i < steps && useEditor.getState().past.length > 0; i++) {
      undo()
      done++
    }
    if (done === 0) throw new ToolError('There is nothing to undo.')
    return text(`Undid ${done} ${done === 1 ? 'change' : 'changes'}. Call get_project to see the result.`)
  },

  async export_video(args) {
    const project = requireProject()
    if (exportJob?.state === 'running')
      throw new ToolError('An export is already running. Call get_export_status.')
    const formatId = (string(args, 'format') ?? 'mp4-h264') as ExportFormatId
    if (!EXPORT_FORMATS.some((f) => f.id === formatId)) {
      throw new ToolError(`Unknown format. Use one of ${EXPORT_FORMATS.map((f) => f.id).join(', ')}.`)
    }
    const format = getExportFormat(formatId)
    let path = absolutePath(string(args, 'path', true)!, 'path')
    if (!path.toLowerCase().endsWith(`.${format.extension}`)) path += `.${format.extension}`
    if ((await window.kificut.media.exists([path]))[0]) {
      throw new ToolError(`${path} already exists. Choose another file name.`)
    }

    const { width, height, fps: projectFps } = project.settings
    const resolution = string(args, 'resolution') ?? 'project'
    if (resolution !== 'project' && !SHORT_SIDES[resolution]) throw new ToolError('Unknown resolution.')
    const shortSide = Math.min(width, height)
    const scale = resolution === 'project' ? 1 : Math.min(1, SHORT_SIDES[resolution] / shortSide)
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
    const quality = (string(args, 'quality') ?? 'high') as ExportQuality
    if (!['high', 'standard', 'small'].includes(quality))
      throw new ToolError('"quality" must be high, standard or small.')

    const total = projectDuration(project)
    const start = number(args, 'start', { min: 0 }) ?? 0
    const end = Math.min(total, number(args, 'end', { min: 0 }) ?? total)
    if (total <= 0) throw new ToolError('The timeline is empty.')
    if (end - start <= 0) throw new ToolError('"end" must be after "start".')

    const settings: ExportSettings = {
      format: formatId,
      width: even(width * scale),
      height: even(height * scale),
      fps:
        number(args, 'fps', { min: 1, max: 120 }) ??
        (formatId === 'gif' ? Math.min(15, projectFps) : projectFps),
      quality,
      audioBitrate: 192,
      start,
      end,
      outputPath: path
    }

    player.pause()
    const job: ExportJob = {
      path,
      label: format.label,
      state: 'running',
      progress: 0,
      etaSeconds: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    }
    exportJob = job
    toast({ kind: 'info', title: 'The assistant started an export', message: path })
    const stop = window.kificut.exporter.onProgress((p) => {
      job.progress = p.progress
      job.etaSeconds = p.etaSeconds
    })
    runExport(settings)
      .then((result) => {
        job.finishedAt = Date.now()
        if (result.ok) {
          job.state = 'done'
          job.progress = 1
          toast({
            kind: 'success',
            title: 'Export finished',
            message: path,
            action: { label: 'Show in Folder', run: () => window.kificut.shell.showItemInFolder(path) }
          })
        } else if (result.cancelled) {
          job.state = 'cancelled'
        } else {
          job.state = 'failed'
          job.error = result.error ?? 'Unknown error'
        }
      })
      .catch((error: unknown) => {
        job.state = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
      })
      .finally(stop)

    return text(
      `Export started: ${path} (${format.label}, ${settings.width}x${settings.height}, ${settings.fps} fps, ${r3(end - start)}s). Call get_export_status to follow it.`
    )
  },

  async generate_voiceover(args) {
    const project = requireProject()
    const text = string(args, 'text', true)!
    const voice = string(args, 'voice') ?? DEFAULT_VOICE
    const speed = number(args, 'speed', { min: 0.5, max: 2 }) ?? 1
    const place = bool(args, 'place') ?? true
    const trackName = string(args, 'track')
    const start = snapToFrame(
      number(args, 'start', { min: 0 }) ?? useEditor.getState().playhead,
      project.settings.fps
    )
    const voiceover = await createVoiceover(text, voice, speed)
    const [media] = await importPaths([voiceover.path])
    if (!media) throw new ToolError('The voiceover was saved but could not be imported.')
    if (!place) {
      return json(
        `Created a ${r1(voiceover.duration)}s voiceover and added it to the media library.`,
        describeMedia(media, useEditor.getState().project!)
      )
    }
    const ids = asOneStep(() => {
      const current = useEditor.getState().project!
      const trackId = trackName
        ? ensureNamedTrack(trackName, 'audio')
        : (findFreeTrack(current, 'audio', start, start + voiceover.duration, false)?.id ?? addTrack('audio'))
      return placeMedia(media.id, start, trackId)
    })
    const after = useEditor.getState().project!
    return json(
      `Added a ${r1(voiceover.duration)}s voiceover at ${r3(start)}s. The file is ${voiceover.path}.`,
      after.clips.filter((c) => ids.includes(c.id)).map((c) => describeClip(c, after))
    )
  },

  async transcribe_media(args) {
    const project = requireProject()
    const media = requireMedia(project, string(args, 'media_id', true))
    const translate = bool(args, 'translate_to_english') ?? false
    const transcript = await transcribeMedia(
      media,
      string(args, 'language') ?? null,
      undefined,
      translate ? 'translate' : 'transcribe'
    )
    return json(
      `${translate ? 'Translated' : 'Transcribed'} ${media.name} with ${modelName(transcript.modelId)}: ${transcript.segments.length} segments. Times are seconds in the source file.`,
      {
        language: transcript.language,
        segments: transcript.segments.map((s) => ({ start: r3(s.start), end: r3(s.end), text: s.text }))
      }
    )
  },

  async add_captions(args) {
    const project = requireProject()
    const clip = requireClip(project, string(args, 'clip_id', true))
    if (!clip.mediaId || (clip.kind !== 'video' && clip.kind !== 'audio')) {
      throw new ToolError('Captions come from a video or audio clip with speech.')
    }
    const media = requireMedia(project, clip.mediaId)
    const preset = string(args, 'preset') ?? 'subtitle'
    if (preset !== 'subtitle' && preset !== 'caption')
      throw new ToolError('"preset" must be subtitle or caption.')
    const trackName = string(args, 'track')
    const translate = bool(args, 'translate_to_english') ?? false
    const transcript = await transcribeMedia(
      media,
      string(args, 'language') ?? null,
      undefined,
      translate ? 'translate' : 'transcribe'
    )
    const fps = project.settings.fps
    const cues = captionsForClip(clip, transcript.segments, Math.max(0.5, 2 / fps))
    if (cues.length === 0) throw new ToolError('No speech was found in that clip.')

    const ids = asOneStep(() => {
      const current = useEditor.getState().project!
      const first = cues[0].start
      const last = cues[cues.length - 1].start + cues[cues.length - 1].duration
      const trackId = trackName
        ? ensureNamedTrack(trackName, 'video')
        : (findFreeTrack(current, 'video', first, last, true)?.id ?? addTrack('video'))
      return cues.map((cue) => {
        const id = addTextClip(preset, cue.start, trackId, cue.duration)
        if (!id) throw new ToolError('Could not add a caption.')
        commit((draft) => {
          const c = draft.clips.find((x) => x.id === id)!
          c.text!.content = wrapCaption(cue.text)
          c.name = cue.text.slice(0, 40)
        })
        return id
      })
    })
    select(ids)
    const latest = useEditor.getState().project!
    const track = latest.tracks.find((t) => t.id === latest.clips.find((c) => c.id === ids[0])?.trackId)
    return text(
      `Added ${ids.length} ${ids.length === 1 ? 'caption' : 'captions'} on ${track?.name ?? 'a video track'} from ${r3(cues[0].start)}s, transcribed with ${modelName(transcript.modelId)}.`
    )
  },

  async generate_media(args) {
    const project = requireProject()
    const kind = string(args, 'kind', true) as GenerationKind
    if (kind !== 'video' && kind !== 'image') throw new ToolError('"kind" must be video or image.')
    const prompt = string(args, 'prompt', true)!.trim()
    if (!prompt) throw new ToolError('Describe what to generate in "prompt".')
    const settings = await window.kificut.generation.settings()
    const wanted = string(args, 'service') as GenerationService | undefined
    if (wanted && !['google', 'fal', 'comfyui'].includes(wanted)) {
      throw new ToolError('"service" must be google, fal or comfyui.')
    }
    const service =
      wanted ?? (['google', 'fal', 'comfyui'] as const).find((s) => serviceReady(s, kind, settings))
    if (!service || !serviceReady(service, kind, settings)) {
      throw new ToolError(
        `${service ? `${service} is not set up for ${kind === 'video' ? 'scenes' : 'pictures'}` : 'No generation service is set up'}. The user can add a Gemini or fal.ai API key, or ComfyUI workflows, in Kificut's AI > Generation.`
      )
    }
    const model =
      service === 'comfyui'
        ? kind
        : (string(args, 'model') ?? SUGGESTED_MODELS[service].find((m) => m.kind === kind)!.id)
    const caps = await window.kificut.generation.capabilities(service, model)
    if (caps.kind !== kind) {
      throw new ToolError(
        `${model} makes ${caps.kind === 'video' ? 'scenes' : 'pictures'}. Use kind ${caps.kind}.`
      )
    }
    const aspectArg = string(args, 'aspect') as AspectRatio | undefined
    const aspect =
      aspectArg && caps.aspects.includes(aspectArg)
        ? aspectArg
        : nearestAspect(project.settings.width, project.settings.height, caps.aspects)
    const request: GenerationRequest = {
      kind,
      service,
      model,
      prompt,
      duration: caps.durations.length
        ? nearest(caps.durations, number(args, 'duration', { min: 1, max: 60 }) ?? 5)
        : 5,
      aspect,
      resolution: caps.resolutions.length
        ? caps.resolutions.includes('720p')
          ? '720p'
          : caps.resolutions[0]
        : undefined
    }
    const estimate = await window.kificut.generation.estimate(request)
    if (service !== 'comfyui' && bool(args, 'confirmed') !== true) {
      return text(
        `Nothing was generated or charged yet. This would cost ${estimate} (${kind === 'video' ? `a ${request.duration} s scene` : 'one picture'} with ${model}, ${aspect}). Tell the user the cost and call generate_media again with the same arguments and confirmed: true once they agree.`
      )
    }
    if (bool(args, 'start_from_frame')) {
      if (!caps.startImage) throw new ToolError(`${model} cannot start from a picture.`)
      request.startImage = { data: await player.capture(1280), mimeType: 'image/jpeg' }
    }
    const place = bool(args, 'place') ?? true
    const at = snapToFrame(
      number(args, 'start', { min: 0 }) ?? useEditor.getState().playhead,
      project.settings.fps
    )
    const job = await startGeneration(request, place, at)
    const finished = await waitForJob(job.id, 90_000)
    if (!finished || finished.state === 'running') {
      return text(
        `Still generating (job ${job.id}, ${estimate}). It goes into the media library${place ? ` and onto the timeline at ${r3(at)}s` : ''} when done; call list_generations to follow it.`
      )
    }
    if (finished.state !== 'done') {
      throw new ToolError(
        finished.error ?? `The ${kind === 'video' ? 'scene' : 'picture'} was ${finished.state}.`
      )
    }
    const mediaId = await waitFor(() => useGeneration.getState().media[job.id], 15_000)
    const latest = useEditor.getState().project!
    const media = latest.media.find((m) => m.id === mediaId)
    if (!media) return text(`Generated ${finished.path}, but it could not be imported.`)
    return json(
      `Generated a ${kind === 'video' ? `${r1(media.duration)}s scene` : 'picture'} with ${model} (${estimate})${place ? ` and placed it at ${r3(at)}s` : ''}.`,
      describeMedia(media, latest)
    )
  },

  async list_generations() {
    const [settings, jobs] = await Promise.all([
      window.kificut.generation.settings(),
      window.kificut.generation.jobs()
    ])
    const media = useGeneration.getState().media
    const status = (service: GenerationService) => {
      const scenes = serviceReady(service, 'video', settings)
      const pictures = serviceReady(service, 'image', settings)
      return scenes && pictures ? 'ready' : scenes ? 'scenes only' : pictures ? 'pictures only' : 'not set up'
    }
    return json('Generation services and the scenes and pictures made since Kificut started.', {
      services: { google: status('google'), fal: status('fal'), comfyui: status('comfyui') },
      generations: [...jobs]
        .sort((a, b) => b.id - a.id)
        .map((job) => ({
          job: job.id,
          kind: job.kind,
          prompt: job.prompt,
          service: job.service,
          model: job.model,
          state: job.state,
          ...(job.state === 'running'
            ? {
                status: job.message,
                progress_percent: job.progress === null ? null : Math.round(job.progress * 100)
              }
            : {}),
          estimate: job.estimate,
          media_id: media[job.id] ?? null,
          file: job.path,
          ...(job.error ? { error: job.error } : {})
        }))
    })
  },

  async list_voices() {
    const [statuses, support, voices] = await Promise.all([
      window.kificut.models.list(),
      window.kificut.voices.support(),
      window.kificut.voices.list()
    ])
    const installed = (id: string) => statuses.some((s) => s.id === id && s.state === 'installed')
    const own = support.supported
      ? voices.map((v) => ({ id: v.id, name: v.name, model: VOICE_CLONE_MODEL }))
      : []
    const notes = [
      installed('kokoro-82m') ? null : 'Kokoro voices need kokoro-82m (install_ai_model).',
      !support.supported
        ? `The user's own voices are not available on this computer: ${support.reason}`
        : !installed(VOICE_CLONE_MODEL)
          ? `The user's own voices need ${VOICE_CLONE_MODEL} (install_ai_model).`
          : voices.length === 0
            ? "The user has not added a voice of their own. They can do that in Kificut's Voice tab."
            : null
    ].filter(Boolean)
    return json(`Voices for generate_voiceover. ${notes.join(' ')}`.trim(), {
      own_voices: own.map((v) => ({ ...v, ready: installed(VOICE_CLONE_MODEL) })),
      kokoro_voices: KOKORO_VOICES.map((v) => ({
        id: v.id,
        name: v.name,
        accent: v.accent,
        gender: v.gender,
        ready: installed('kokoro-82m')
      }))
    })
  },

  async list_ai_models() {
    const statuses = await window.kificut.models.list()
    return json(
      'AI models Kificut can run on this computer. Install a missing one with install_ai_model.',
      LOCAL_MODELS.map((model) => {
        const status = statuses.find((s) => s.id === model.id)
        return {
          id: model.id,
          name: model.name,
          used_by: USED_BY[model.task],
          description: model.description,
          download_mb: Math.round(model.approximateSize / 1e6),
          license: model.license,
          state: status?.state ?? 'not-installed',
          ...(status?.state === 'downloading' && status.total
            ? { progress_percent: Math.round((status.received / status.total) * 100) }
            : {}),
          ...(status?.error ? { error: status.error } : {})
        }
      })
    )
  },

  async install_ai_model(args) {
    const id = string(args, 'model_id', true)!
    const model = getLocalModel(id)
    if (!model) {
      throw new ToolError(`Unknown model "${id}". Use one of: ${LOCAL_MODELS.map((m) => m.id).join(', ')}.`)
    }
    const current = (await window.kificut.models.list()).find((s) => s.id === id)
    if (current?.state === 'installed') return text(`${model.name} is already installed.`)

    // Listen before starting, so a download that finishes or fails right away is not missed.
    let off: () => void = () => undefined
    const finished = new Promise<ModelStatus | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(null), 60_000)
      off = window.kificut.models.onStatus((status) => {
        if (status.id !== id || status.state === 'downloading') return
        window.clearTimeout(timer)
        resolve(status)
      })
    })
    try {
      if (current?.state !== 'downloading') await window.kificut.models.install(id)
      const result = await finished
      if (result?.state === 'installed') {
        return text(
          `Installed ${model.name} (${Math.round(result.size / 1e6)} MB). It runs on this computer.`
        )
      }
      if (result)
        throw new ToolError(
          `${model.name} could not be installed: ${result.error ?? 'the download stopped.'}`
        )
      const latest = (await window.kificut.models.list()).find((s) => s.id === id)
      const done = latest?.total ? Math.round((latest.received / latest.total) * 100) : 0
      return text(
        `${model.name} is still downloading (${done}%). Call list_ai_models in a little while to check.`
      )
    } finally {
      off()
    }
  },

  async find_shots(args) {
    const project = requireProject()
    const query = string(args, 'query', true)!
    const limit = Math.round(number(args, 'limit', { min: 1, max: 30 }) ?? 8)
    const wanted = args.media_ids
    let media = project.media
    if (wanted !== undefined) {
      if (!Array.isArray(wanted)) throw new ToolError('"media_ids" must be a list of media ids.')
      media = wanted.map((id) => requireMedia(project, String(id)))
    }
    if (!media.some((m) => m.hasVideo))
      throw new ToolError('There is no video or picture to search. Import some first.')
    const shots = await findShots(query, media, limit)
    if (shots.length === 0) return text(`Nothing in the footage looks like "${query}".`)
    return json(
      `${shots.length} moments that look like "${query}", best first. Times are seconds in the source file; pass them to add_clips as in and out.`,
      shots.map((shot) => ({
        media_id: shot.media.id,
        media: shot.media.name,
        ...(shot.media.kind === 'image'
          ? {}
          : { in: r1(shot.start), out: r1(Math.max(shot.end, shot.start + 1)) }),
        best_frame: r1(shot.time),
        score: Math.round(shot.score * 1000) / 1000
      }))
    )
  },

  async reduce_noise(args) {
    const project = requireProject()
    const clip = requireClip(project, string(args, 'clip_id', true))
    const strength = number(args, 'strength', { min: 0.1, max: 1 }) ?? 0.85
    const targets =
      clip.kind === 'audio'
        ? [clip]
        : project.clips.filter((c) => c.kind === 'audio' && clip.linkId && c.linkId === clip.linkId)
    if (targets.length === 0 || !targets[0].mediaId) {
      throw new ToolError('Noise reduction works on an audio clip, or a video clip with linked audio.')
    }
    const source = requireMedia(project, targets[0].mediaId)
    const path = await cleanAudio(source, strength)
    const [cleanMedia] = await importPaths([path])
    if (!cleanMedia) throw new ToolError('The cleaned audio was saved but could not be imported.')
    commit((draft) => {
      for (const target of targets) {
        const c = draft.clips.find((x) => x.id === target.id)
        if (c && c.mediaId === source.id) {
          c.mediaId = cleanMedia.id
          c.name = cleanMedia.name
        }
      }
    })
    return text(
      `Reduced the background noise in ${source.name}. The clip now plays ${cleanMedia.name}, saved at ${path}.`
    )
  },

  async remove_background(args) {
    const project = requireProject()
    const clip = requireClip(project, string(args, 'clip_id', true))
    if (!clip.mediaId || (clip.kind !== 'image' && clip.kind !== 'video')) {
      throw new ToolError('Background removal works on picture and video clips.')
    }
    const source = requireMedia(project, clip.mediaId)
    if (clip.kind === 'image') {
      const path = await cutoutImage(source)
      const [cutout] = await importPaths([path])
      if (!cutout) throw new ToolError('The cut-out was saved but could not be imported.')
      commit((draft) => {
        const c = draft.clips.find((x) => x.id === clip.id)
        if (c) {
          c.mediaId = cutout.id
          c.name = cutout.name
        }
      })
      return text(`Removed the background from ${source.name}. The clip now shows ${cutout.name}.`)
    }
    // Only the part of the video the clip uses is processed; the new file starts there.
    const used = clip.duration * clip.speed
    const path = await removeVideoBackground(source, clip.inPoint, used)
    const [cutout] = await importPaths([path])
    if (!cutout) throw new ToolError('The video was saved but could not be imported.')
    commit((draft) => {
      const c = draft.clips.find((x) => x.id === clip.id)
      if (c) {
        c.mediaId = cutout.id
        c.name = cutout.name
        c.inPoint = 0
      }
    })
    return text(
      `Removed the background from ${r1(used)}s of ${source.name}. The clip now plays ${cutout.name}, which has transparency, so tracks below show through.`
    )
  },

  get_export_status() {
    const job = exportJob
    if (!job) return text('No export has been started from here in this session.')
    const elapsed = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)
    switch (job.state) {
      case 'running': {
        const eta = job.etaSeconds !== null ? `, about ${Math.max(1, Math.round(job.etaSeconds))}s left` : ''
        return text(`Exporting ${job.path}: ${Math.round(job.progress * 100)}% done${eta}.`)
      }
      case 'done':
        return text(`Export finished in ${elapsed}s: ${job.path}`)
      case 'cancelled':
        return text('The export was stopped in Kificut.')
      default:
        return text(`The export failed: ${job.error}`)
    }
  }
}

/** Whether a generation service has what it needs for a kind of result. */
function serviceReady(
  service: GenerationService,
  kind: GenerationKind,
  settings: GenerationSettings
): boolean {
  if (service === 'google') return settings.googleKey
  if (service === 'fal') return settings.falKey
  return Boolean(kind === 'video' ? settings.comfyuiVideoWorkflow : settings.comfyuiImageWorkflow)
}

/** Resolves with the job once it stops running, or null after `ms`. */
function waitForJob(id: number, ms: number): Promise<GenerationJob | null> {
  return new Promise((resolve) => {
    const done = (job: GenerationJob | null) => {
      window.clearTimeout(timer)
      off()
      resolve(job)
    }
    const timer = window.setTimeout(() => done(null), ms)
    const off = window.kificut.generation.onJob((job) => {
      if (job.id === id && job.state !== 'running') done(job)
    })
    // It may have finished before this listener was added.
    const known = useGeneration.getState().jobs.find((j) => j.id === id)
    if (known && known.state !== 'running') done(known)
  })
}

/** Polls until `read` returns a value, or undefined after `ms`. */
async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return read()
}

/** Which tools each kind of model is for, as list_ai_models reports it. */
const USED_BY: Record<ModelTask, string[]> = {
  voiceover: ['generate_voiceover'],
  'voice-clone': ['generate_voiceover', 'list_voices'],
  transcription: ['transcribe_media', 'add_captions'],
  noise: ['reduce_noise'],
  search: ['find_shots'],
  background: ['remove_background']
}

/** Runs one tool call and turns any failure into an error result the assistant can read. */
export async function runTool(name: string, args: Args): Promise<ToolResult> {
  const tool = tools[name]
  if (!tool) return errorResult(`Kificut does not have a tool called ${name}.`)
  try {
    return await tool(args ?? {})
  } catch (error) {
    if (error instanceof ToolError || error instanceof ModelMissingError) return errorResult(error.message)
    console.error(`Tool ${name} failed`, error)
    return errorResult(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const TOOL_NAMES = Object.keys(tools)
