import type { Draft } from 'immer'
import { clamp, snapToFrame } from '@shared/time'
import type { Clip, MediaItem, Project, ProjectSettings, Track, TrackKind } from '@shared/types'
import type { OpenedProject } from '@shared/ipc'
import {
  clipsForMedia,
  createClip,
  createProject,
  createTrack,
  defaultTextStyle,
  defaultTransform,
  TEXT_PRESETS,
  uid
} from '../lib/factory'
import {
  clipEnd,
  editPoints,
  findFreeTrack,
  projectDuration,
  resolveOverlaps,
  rippleDelete,
  splitClips,
  tracksOfKind,
  withLinked
} from '../lib/timeline'
import { needsProxy } from '../lib/media'
import { parseProjectFile, toProjectFile } from '../lib/project-io'
import { MAX_ZOOM, MIN_ZOOM, timelineView } from '../lib/timeline-view'
import { player } from '../engine/player'
import { closeProject, commit, isDirty, loadProject, seek, select, useEditor } from './editor'
import { confirmDialog, toast } from './ui'

const get = useEditor.getState
const set = useEditor.setState

function project(): Project | null {
  return get().project
}

function fps(): number {
  return project()?.settings.fps ?? 30
}

function frame(): number {
  return 1 / fps()
}

function fileBaseName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? path
  )
}

/* Project lifecycle */

export function newProject(name: string, settings: Partial<ProjectSettings>): void {
  loadProject(createProject(name, settings), null)
  set({ zoom: 60 })
}

/** Loads a project the main process has read, then checks its media. */
export async function adopt(opened: OpenedProject): Promise<void> {
  const loaded = parseProjectFile(opened.data)
  loadProject(loaded, opened.path)
  await refreshMediaStatus()
  requestAnimationFrame(() => zoomToFit())
}

export async function openProjectDialog(): Promise<void> {
  if (!(await confirmDiscardChanges())) return
  try {
    const opened = await window.kificut.project.open()
    if (opened) await adopt(opened)
  } catch (error) {
    toast({ kind: 'error', title: 'Could not open project', message: errorText(error) })
  }
}

export async function openProjectPath(path: string): Promise<void> {
  if (get().filePath === path) return
  if (!(await confirmDiscardChanges())) return
  try {
    await adopt(await window.kificut.project.openPath(path))
  } catch (error) {
    toast({ kind: 'error', title: 'Could not open project', message: errorText(error) })
  }
}

/** Saves the project. With an explicit path no dialog is shown. */
export async function saveProject(saveAs = false, explicitPath?: string): Promise<boolean> {
  const state = get()
  if (!state.project) return false
  let snapshot = state.project
  const firstSave = !state.filePath
  try {
    const target = await window.kificut.project.save(
      explicitPath ?? (saveAs ? null : state.filePath),
      toProjectFile(snapshot),
      snapshot.name
    )
    if (!target) return false
    if (firstSave && snapshot.name === 'Untitled Project') {
      const name = fileBaseName(target)
      commit((draft) => {
        draft.name = name
      })
      snapshot = get().project!
      await window.kificut.project.save(target, toProjectFile(snapshot), name)
    }
    set({ savedProject: snapshot, filePath: target })
    return true
  } catch (error) {
    toast({ kind: 'error', title: 'Could not save project', message: errorText(error) })
    return false
  }
}

/** Asks about unsaved changes. Resolves true when it is fine to continue. */
export async function confirmDiscardChanges(): Promise<boolean> {
  const state = get()
  if (!state.project || !isDirty(state)) return true
  const choice = await confirmDialog({
    title: `Save changes to "${state.project.name}"?`,
    message: "Your changes will be lost if you don't save them.",
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'discard', label: "Don't Save" },
      { id: 'save', label: 'Save', primary: true }
    ]
  })
  if (choice === 'cancel') return false
  if (choice === 'save') return saveProject()
  return true
}

export async function requestCloseProject(): Promise<void> {
  if (!(await confirmDiscardChanges())) return
  player.pause()
  closeProject()
}

export async function handleWindowClose(): Promise<void> {
  if (!(await confirmDiscardChanges())) return
  // Saved or deliberately discarded, so there is nothing to recover next time.
  await window.kificut.recovery.clear()
  window.kificut.app.closeWindow(true)
}

export function renameProject(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  commit((draft) => {
    draft.name = trimmed
  })
}

export function updateProjectSettings(patch: Partial<ProjectSettings>, coalesceKey?: string): void {
  commit((draft) => {
    Object.assign(draft.settings, patch)
  }, coalesceKey)
}

/* Media */

export async function importPaths(paths: string[]): Promise<MediaItem[]> {
  const current = project()
  if (!current || paths.length === 0) return []
  const known = new Map(current.media.map((m) => [m.path, m]))
  const fresh = [...new Set(paths.filter((p) => !known.has(p)))]

  const added: MediaItem[] = []
  if (fresh.length) {
    const results = await window.kificut.media.probe(fresh)
    const failed: string[] = []
    for (const result of results) {
      if (result.ok && result.media) added.push({ id: uid('m'), ...result.media })
      else failed.push(`${fileBaseName(result.path)}: ${result.error ?? 'unsupported file'}`)
    }
    if (added.length) {
      commit((draft) => {
        draft.media.push(...added)
      })
      requestProxies(added)
    }
    if (failed.length) {
      toast({
        kind: 'error',
        title:
          failed.length === 1
            ? 'One file could not be imported'
            : `${failed.length} files could not be imported`,
        message: failed.slice(0, 3).join('\n')
      })
    }
  }

  const byPath = new Map([...known, ...added.map((m) => [m.path, m] as const)])
  return paths.map((p) => byPath.get(p)).filter((m): m is MediaItem => !!m)
}

export async function importDialog(): Promise<void> {
  if (!project()) return
  const paths = await window.kificut.media.pick()
  if (paths.length) await importPaths(paths)
}

export function setProxyStatus(path: string, status: import('@shared/types').ProxyStatus): void {
  set((s) => ({ proxies: { ...s.proxies, [path]: status } }))
  if (status.state === 'failed') {
    toast({ kind: 'error', title: 'Preview file could not be created', message: status.error })
  }
}

function requestProxies(items: MediaItem[]): void {
  const above = get().settings?.proxyAboveHeight ?? 0
  for (const item of items) {
    if (!needsProxy(item, above)) continue
    if (get().proxies[item.path]?.state === 'ready') continue
    void window.kificut.media.proxy(item.path).then((status) => setProxyStatus(item.path, status))
  }
}

export async function refreshMediaStatus(): Promise<void> {
  const current = project()
  if (!current) return
  const exists = await window.kificut.media.exists(current.media.map((m) => m.path))
  const offline: Record<string, boolean> = {}
  current.media.forEach((m, i) => {
    if (!exists[i]) offline[m.id] = true
  })
  set({ offline })
  requestProxies(current.media.filter((m) => !offline[m.id]))
  const missing = Object.keys(offline).length
  if (missing) {
    toast({
      kind: 'error',
      title: missing === 1 ? 'One media file is missing' : `${missing} media files are missing`,
      message: 'Right click offline items in the media panel to locate them.'
    })
  }
}

export async function relinkMedia(mediaId: string): Promise<void> {
  const item = project()?.media.find((m) => m.id === mediaId)
  if (!item) return
  const path = await window.kificut.media.locate(item.name)
  if (!path) return
  const [result] = await window.kificut.media.probe([path])
  if (!result.ok || !result.media) {
    toast({ kind: 'error', title: 'That file could not be read', message: result.error })
    return
  }
  const probed = result.media
  commit((draft) => {
    const target = draft.media.find((m) => m.id === mediaId)
    if (target) Object.assign(target, probed, { id: mediaId })
  })
  set((s) => {
    const offline = { ...s.offline }
    delete offline[mediaId]
    return { offline }
  })
  requestProxies([{ ...probed, id: mediaId }])
}

export async function removeMedia(mediaId: string): Promise<void> {
  const current = project()
  const item = current?.media.find((m) => m.id === mediaId)
  if (!current || !item) return
  const used = current.clips.filter((c) => c.mediaId === mediaId).length
  if (used > 0) {
    const choice = await confirmDialog({
      title: `Remove "${item.name}"?`,
      message: `It is used by ${used} ${used === 1 ? 'clip' : 'clips'} on the timeline, which will be removed too.`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'remove', label: 'Remove', danger: true, primary: true }
      ]
    })
    if (choice !== 'remove') return
  }
  commit((draft) => {
    draft.media = draft.media.filter((m) => m.id !== mediaId)
    draft.clips = draft.clips.filter((c) => c.mediaId !== mediaId)
  })
}

/* Tracks */

/** Adds a track above the existing ones of its kind and returns its id. */
function appendTrack(draft: Draft<Project>, kind: TrackKind): string {
  const prefix = kind === 'video' ? 'V' : 'A'
  const highest = Math.max(
    0,
    ...draft.tracks
      .filter((t) => t.kind === kind)
      .map((t) => parseInt(new RegExp(`^${prefix}(\\d+)$`).exec(t.name)?.[1] ?? '0', 10))
  )
  const track = createTrack(kind, `${prefix}${highest + 1}`)
  if (kind === 'video') {
    const lastVideo = draft.tracks.map((t) => t.kind).lastIndexOf('video')
    draft.tracks.splice(lastVideo + 1, 0, track)
  } else {
    draft.tracks.push(track)
  }
  return track.id
}

export function addTrack(kind: TrackKind): string {
  let id = ''
  commit((draft) => {
    id = appendTrack(draft, kind)
  })
  return id
}

export async function removeTrack(trackId: string): Promise<void> {
  const current = project()
  if (!current) return
  const track = current.tracks.find((t) => t.id === trackId)
  if (!track) return
  if (current.tracks.filter((t) => t.kind === track.kind).length <= 1) {
    toast({ kind: 'info', title: `A project needs at least one ${track.kind} track.` })
    return
  }
  const used = current.clips.filter((c) => c.trackId === trackId).length
  if (used) {
    const choice = await confirmDialog({
      title: `Delete track ${track.name}?`,
      message: `The ${used} ${used === 1 ? 'clip' : 'clips'} on it will be deleted as well.`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'delete', label: 'Delete Track', danger: true, primary: true }
      ]
    })
    if (choice !== 'delete') return
  }
  commit((draft) => {
    draft.tracks = draft.tracks.filter((t) => t.id !== trackId)
    draft.clips = draft.clips.filter((c) => c.trackId !== trackId)
  })
}

export function updateTrack(trackId: string, patch: Partial<Track>): void {
  commit((draft) => {
    const track = draft.tracks.find((t) => t.id === trackId)
    if (track) Object.assign(track, patch)
  })
}

function ensureTrack(draft: Draft<Project>, kind: TrackKind, index: number): string {
  const tracks = draft.tracks.filter((t) => t.kind === kind)
  if (tracks[index]) return tracks[index].id
  const unlocked = tracks.find((t) => !t.locked)
  return unlocked ? unlocked.id : appendTrack(draft, kind)
}

/* Placing clips */

export interface SourceRange {
  /** Source time to start from, in seconds. */
  inPoint: number
  /** Length on the timeline, in seconds. */
  duration: number
}

/**
 * Drops media onto the timeline. Video with sound becomes a linked pair: the picture on a video
 * track and the sound on the matching audio track. A range places only part of the source.
 */
export function placeMedia(
  mediaId: string,
  time: number,
  trackId?: string | null,
  range?: SourceRange
): string[] {
  const current = project()
  const item = current?.media.find((m) => m.id === mediaId)
  if (!current || !item) return []
  const start = snapToFrame(Math.max(0, time), fps())
  let created: Clip[] = []

  commit((draft) => {
    const target = trackId ? draft.tracks.find((t) => t.id === trackId) : undefined
    let index = 0
    if (target)
      index = draft.tracks.filter((t) => t.kind === target.kind).findIndex((t) => t.id === target.id)
    const needsVideo = item.kind !== 'audio'
    const needsAudio = item.kind === 'audio' || (item.kind === 'video' && item.hasAudio)
    const videoTrack = needsVideo
      ? target?.kind === 'video'
        ? target.id
        : ensureTrack(draft, 'video', index)
      : null
    const audioTrack = needsAudio
      ? target?.kind === 'audio'
        ? target.id
        : ensureTrack(draft, 'audio', index)
      : null
    created = clipsForMedia(item, videoTrack, audioTrack, start)
    if (range) {
      for (const clip of created) {
        clip.inPoint = item.kind === 'image' ? 0 : Math.max(0, range.inPoint)
        clip.duration = Math.max(frame(), snapToFrame(range.duration, fps()))
      }
    }
    draft.clips.push(...created)
    resolveOverlaps(
      draft as Project,
      created.map((c) => c.id)
    )
  })

  const ids = created.map((c) => c.id)
  if (ids.length) select(ids)
  return ids
}

export function addMediaAtPlayhead(mediaId: string): void {
  placeMedia(mediaId, get().playhead)
}

export function appendMedia(mediaId: string): void {
  const current = project()
  if (!current) return
  placeMedia(mediaId, projectDuration(current))
}

function placeOverlay(clip: Clip): string {
  const current = project()!
  const end = clip.start + clip.duration
  let trackId = clip.trackId
  if (!trackId) {
    const free = findFreeTrack(current, 'video', clip.start, end, clip.kind === 'text')
    trackId = free?.id ?? ''
  }
  commit((draft) => {
    // Nothing free at that time: overlays get a new track on top rather than covering existing clips.
    const id = trackId || appendTrack(draft, 'video')
    draft.clips.push({ ...clip, trackId: id })
    resolveOverlaps(draft as Project, [clip.id])
  })
  select([clip.id])
  return clip.id
}

/** Adds a text layer and returns its clip id. */
export function addTextClip(
  presetId = 'title',
  time?: number,
  trackId?: string,
  duration = 5
): string | null {
  const current = project()
  if (!current) return null
  const preset = TEXT_PRESETS.find((p) => p.id === presetId) ?? TEXT_PRESETS[0]
  const { width, height } = current.settings
  const factor = Math.min(width, height) / 1080
  const style = defaultTextStyle(preset.style)
  style.fontSize = Math.round(style.fontSize * factor)
  style.padding = Math.round(style.padding * factor)
  style.strokeWidth = Math.round(style.strokeWidth * factor)
  const start = snapToFrame(time ?? get().playhead, fps())
  const clip = createClip({
    kind: 'text',
    name: preset.label,
    trackId: trackId ?? '',
    start,
    duration: Math.max(frame(), snapToFrame(duration, fps())),
    text: style,
    transform: {
      ...defaultTransform(),
      x: Math.round((preset.x ?? 0) * width),
      y: Math.round(preset.y * height)
    }
  })
  return placeOverlay(clip)
}

/** Adds a solid color layer and returns its clip id. */
export function addSolidClip(color: string, time?: number, trackId?: string, duration = 5): string | null {
  if (!project()) return null
  const start = snapToFrame(time ?? get().playhead, fps())
  const clip = createClip({
    kind: 'solid',
    name: 'Color',
    trackId: trackId ?? '',
    start,
    duration: Math.max(frame(), snapToFrame(duration, fps())),
    solidColor: color
  })
  return placeOverlay(clip)
}

/* Editing */

function selectedOrUnderPlayhead(): string[] {
  const state = get()
  const current = state.project!
  const t = state.playhead
  const selected = state.selection.filter((id) => {
    const c = current.clips.find((clip) => clip.id === id)
    return c && t > c.start && t < clipEnd(c)
  })
  if (selected.length) return selected
  return current.clips.filter((c) => t > c.start && t < clipEnd(c)).map((c) => c.id)
}

export function splitAtPlayhead(): void {
  const state = get()
  if (!state.project) return
  const ids = selectedOrUnderPlayhead()
  if (!ids.length) return
  const time = snapToFrame(state.playhead, fps())
  commit((draft) => {
    splitClips(draft as Project, ids, time, frame())
  })
}

export function splitAt(clipId: string, time: number): void {
  const t = snapToFrame(time, fps())
  commit((draft) => {
    splitClips(draft as Project, [clipId], t, frame())
  })
}

export function deleteSelection(ripple = false): void {
  const state = get()
  if (!state.project || !state.selection.length) return
  const locked = new Set(state.project.tracks.filter((t) => t.locked).map((t) => t.id))
  const ids = state.selection.filter((id) => {
    const clip = state.project!.clips.find((c) => c.id === id)
    return clip && !locked.has(clip.trackId)
  })
  if (!ids.length) return
  commit((draft) => {
    if (ripple) {
      rippleDelete(draft as Project, ids)
    } else {
      const remove = new Set(ids)
      draft.clips = draft.clips.filter((c) => !remove.has(c.id))
    }
  })
  set({ selection: [] })
}

interface ClipboardData {
  clips: Clip[]
  origin: number
}

let clipboard: ClipboardData | null = null

export function copySelection(): boolean {
  const state = get()
  if (!state.project || !state.selection.length) return false
  const ids = new Set(state.selection)
  const clips = state.project.clips.filter((c) => ids.has(c.id))
  clipboard = {
    clips: JSON.parse(JSON.stringify(clips)) as Clip[],
    origin: Math.min(...clips.map((c) => c.start))
  }
  return true
}

export function cutSelection(): void {
  if (copySelection()) deleteSelection(false)
}

function insertCopies(source: Clip[], origin: number, at: number): void {
  const links = new Map<string, string>()
  const copies = source.map((clip) => {
    const copy: Clip = JSON.parse(JSON.stringify(clip))
    copy.id = uid('c')
    copy.start = snapToFrame(at + (clip.start - origin), fps())
    if (clip.linkId) {
      if (!links.has(clip.linkId)) links.set(clip.linkId, uid('l'))
      copy.linkId = links.get(clip.linkId)!
    }
    return copy
  })
  commit((draft) => {
    for (const copy of copies) {
      if (!draft.tracks.some((t) => t.id === copy.trackId && !t.locked)) {
        const kind: TrackKind = copy.kind === 'audio' ? 'audio' : 'video'
        copy.trackId = ensureTrack(draft, kind, 0)
      }
      if (copy.mediaId && !draft.media.some((m) => m.id === copy.mediaId)) continue
      draft.clips.push(copy)
    }
    resolveOverlaps(
      draft as Project,
      copies.map((c) => c.id)
    )
  })
  select(copies.map((c) => c.id))
}

export function pasteClipboard(): void {
  if (!clipboard || !project()) return
  insertCopies(clipboard.clips, clipboard.origin, get().playhead)
}

export function duplicateSelection(): void {
  const state = get()
  if (!state.project || !state.selection.length) return
  const ids = new Set(state.selection)
  const clips = state.project.clips.filter((c) => ids.has(c.id))
  const origin = Math.min(...clips.map((c) => c.start))
  const end = Math.max(...clips.map(clipEnd))
  insertCopies(clips, origin, end)
}

export function selectAll(): void {
  const current = project()
  if (!current) return
  const locked = new Set(current.tracks.filter((t) => t.locked).map((t) => t.id))
  set({ selection: current.clips.filter((c) => !locked.has(c.trackId)).map((c) => c.id) })
}

export function nudgeSelection(frames: number): void {
  const state = get()
  if (!state.project || !state.selection.length) return
  const ids = new Set(state.selection)
  const clips = state.project.clips.filter((c) => ids.has(c.id))
  const minStart = Math.min(...clips.map((c) => c.start))
  const delta = Math.max(-minStart, frames * frame())
  if (Math.abs(delta) < 1e-9) return
  commit(
    (draft) => {
      for (const clip of draft.clips)
        if (ids.has(clip.id)) clip.start = snapToFrame(clip.start + delta, fps())
      resolveOverlaps(draft as Project, [...ids])
    },
    `nudge:${[...ids].join(',')}`
  )
}

export function updateClips(ids: string[], recipe: (clip: Draft<Clip>) => void, coalesceKey?: string): void {
  const set_ = new Set(ids)
  commit((draft) => {
    for (const clip of draft.clips) if (set_.has(clip.id)) recipe(clip)
  }, coalesceKey)
}

export function setClipSpeed(clipId: string, speed: number): void {
  const current = project()
  const clip = current?.clips.find((c) => c.id === clipId)
  if (!current || !clip) return
  const ids = withLinked(current, [clipId])
  const next = clamp(speed, 0.1, 16)
  commit((draft) => {
    for (const c of draft.clips) {
      if (!ids.includes(c.id)) continue
      const source = c.duration * c.speed
      c.speed = next
      c.duration = Math.max(frame(), snapToFrame(source / next, fps()))
      c.fadeIn = Math.min(c.fadeIn, c.duration)
      c.fadeOut = Math.min(c.fadeOut, c.duration - c.fadeIn)
    }
    resolveOverlaps(draft as Project, ids)
  }, `speed:${clipId}`)
}

export function linkSelection(): void {
  const state = get()
  if (state.selection.length < 2) return
  const linkId = uid('l')
  updateClips(state.selection, (c) => {
    c.linkId = linkId
  })
}

export function unlinkSelection(): void {
  const state = get()
  if (!state.selection.length) return
  updateClips(state.selection, (c) => {
    c.linkId = null
  })
}

/* Markers and range */

const MARKER_COLORS = ['#f5c451', '#5ec4ff', '#ff6b6b', '#7bd88f', '#c792ea']

export function addMarker(): void {
  const state = get()
  if (!state.project) return
  const time = snapToFrame(state.playhead, fps())
  if (state.project.markers.some((m) => Math.abs(m.time - time) < frame() / 2)) return
  commit((draft) => {
    draft.markers.push({
      id: uid('k'),
      time,
      label: `Marker ${draft.markers.length + 1}`,
      color: MARKER_COLORS[0]
    })
    draft.markers.sort((a, b) => a.time - b.time)
  })
}

export function updateMarker(id: string, patch: Partial<Project['markers'][number]>): void {
  commit((draft) => {
    const marker = draft.markers.find((m) => m.id === id)
    if (marker) Object.assign(marker, patch)
  })
}

export function removeMarker(id: string): void {
  commit((draft) => {
    draft.markers = draft.markers.filter((m) => m.id !== id)
  })
}

export { MARKER_COLORS }

export function setInPoint(): void {
  const t = snapToFrame(get().playhead, fps())
  commit((draft) => {
    draft.inPoint = t
    if (draft.outPoint !== null && draft.outPoint <= t) draft.outPoint = null
  })
}

export function setOutPoint(): void {
  const t = snapToFrame(get().playhead, fps())
  commit((draft) => {
    draft.outPoint = t
    if (draft.inPoint !== null && draft.inPoint >= t) draft.inPoint = null
  })
}

export function clearInOut(): void {
  commit((draft) => {
    draft.inPoint = null
    draft.outPoint = null
  })
}

/* Navigation */

export function stepFrames(count: number): void {
  if (!project()) return
  player.pause()
  seek(snapToFrame(get().playhead, fps()) + count * frame())
}

export function jumpToEdit(direction: 1 | -1): void {
  const current = project()
  if (!current) return
  const t = get().playhead
  const points = editPoints(current)
  const target =
    direction > 0 ? points.find((p) => p > t + 1e-4) : [...points].reverse().find((p) => p < t - 1e-4)
  if (target !== undefined) seek(target)
}

export function goToStart(): void {
  seek(0)
}

export function goToEnd(): void {
  const current = project()
  if (current) seek(projectDuration(current))
}

/* Zoom */

export function setZoom(zoom: number, anchorTime?: number): void {
  const state = get()
  const next = clamp(zoom, MIN_ZOOM, Math.min(MAX_ZOOM, fps() * 40))
  if (next === state.zoom) return
  const anchor = anchorTime ?? state.playhead
  const screenX = anchor * state.zoom - timelineView.scrollLeft()
  timelineView.pendingScrollLeft = Math.max(0, anchor * next - screenX)
  set({ zoom: next })
}

export function zoomBy(factor: number, anchorTime?: number): void {
  setZoom(get().zoom * factor, anchorTime)
}

export function zoomToFit(): void {
  const current = project()
  if (!current) return
  const duration = Math.max(10, projectDuration(current))
  const zoom = clamp((timelineView.viewportWidth() - 40) / duration, MIN_ZOOM, MAX_ZOOM)
  timelineView.pendingScrollLeft = 0
  set({ zoom })
}

/* Helpers */

export function errorText(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(error)
}

export function tracksFor(kind: TrackKind): Track[] {
  const current = project()
  return current ? tracksOfKind(current, kind) : []
}
