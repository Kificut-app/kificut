import { create } from 'zustand'
import type { Clip, MediaItem, TrackKind } from '@shared/types'
import { snapToFrame } from '@shared/time'
import {
  formatClock,
  pipTransform,
  recordingStamp,
  type FileRole,
  type RecorderStatus,
  type RecordingResult
} from '@shared/recording'
import { clipsForMedia, uid } from '../lib/factory'
import { isRangeFree, tracksOfKind } from '../lib/timeline'
import { commit, select, useEditor } from './editor'
import { appendTrack, importPaths, newProject } from './actions'
import { toast } from './ui'

/** The recording in progress, as the editor window sees it. */
export const useRecording = create<{ status: RecorderStatus | null }>(() => ({ status: null }))

let started = false

export function startRecordingSync(): void {
  if (started) return
  started = true
  window.kificut.recorder.onStatus((status) => useRecording.setState({ status }))
  window.kificut.recorder.onResult((result) => {
    void addRecording(result).catch((error: unknown) =>
      toast({
        kind: 'error',
        title: 'The recording was saved but could not be added',
        message: error instanceof Error ? error.message : String(error)
      })
    )
  })
  window.kificut.recorder.onError((message) => toast({ kind: 'error', title: 'Could not record', message }))
  window.kificut.recorder.onRecovered((paths) =>
    toast({
      kind: 'info',
      title:
        paths.length === 1
          ? 'An interrupted recording was saved'
          : `${paths.length} interrupted recordings were saved`,
      message: 'Kificut closed while recording. What was recorded is in Documents/Kificut/Recordings.',
      action: { label: 'Show in Folder', run: () => void window.kificut.recorder.reveal(paths[0]) }
    })
  )
}

const ROLE_ORDER: FileRole[] = ['screen', 'camera', 'system-audio']

/**
 * Imports a finished recording and lays it out at the playhead (or in a new project when none is
 * open): the screen on a free video track, the camera above it as a picture in picture (or full
 * frame when only the camera was recorded), and the sound on free audio tracks. All clips are
 * linked, so they move, trim and split together and stay in sync.
 */
async function addRecording(result: RecordingResult): Promise<void> {
  const files = [...result.files].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
  const paths = files.map((f) => f.path)
  let fresh = false

  if (!useEditor.getState().project) {
    const probes = await window.kificut.media.probe(paths)
    const main = probes.find((p) => p.ok && p.media && p.media.width > 0)?.media
    newProject(`Recording ${recordingStamp(new Date()).slice(0, 16).replace('.', ':')}`, {
      width: main ? Math.round(main.width / 2) * 2 : 1920,
      height: main ? Math.round(main.height / 2) * 2 : 1080,
      fps: result.options.fps
    })
    fresh = true
  }

  const media = await importPaths(paths)
  const byRole = new Map<FileRole, MediaItem>()
  files.forEach((file, i) => {
    const item = media.find((m) => m.path === file.path) ?? media[i]
    if (item) byRole.set(file.role, item)
  })
  if (byRole.size === 0) throw new Error('None of the recorded files could be read.')

  const state = useEditor.getState()
  const project = state.project!
  const start = fresh ? 0 : snapToFrame(state.playhead, project.settings.fps)
  const length = Math.max(...[...byRole.values()].map((m) => m.duration || result.duration))
  const created: Clip[] = []

  commit((draft) => {
    const end = start + length
    /** A free unlocked track of the kind, above `above` when given; a new one if none is free. */
    const freeTrack = (kind: TrackKind, above?: string): string => {
      let tracks = tracksOfKind(draft, kind).filter((t) => !t.locked)
      if (above) tracks = tracks.slice(tracks.findIndex((t) => t.id === above) + 1)
      return tracks.find((t) => isRangeFree(draft, t.id, start, end))?.id ?? appendTrack(draft, kind)
    }
    const place = (item: MediaItem, videoTrack: string | null): Clip[] => {
      const audioTrack = item.kind === 'audio' || item.hasAudio ? freeTrack('audio') : null
      const clips = clipsForMedia(item, videoTrack, audioTrack, start)
      draft.clips.push(...clips)
      created.push(...clips)
      return clips
    }

    const screen = byRole.get('screen')
    const camera = byRole.get('camera')
    let screenTrack: string | null = null
    if (screen) {
      screenTrack = freeTrack('video')
      place(screen, screenTrack)
    }
    if (camera) {
      const clips = place(camera, freeTrack('video', screenTrack ?? undefined))
      const picture = clips.find((c) => c.kind === 'video')
      if (picture && screen) {
        const pip = pipTransform(
          { width: camera.width, height: camera.height },
          { width: draft.settings.width, height: draft.settings.height },
          result.options.pip.corner,
          result.options.pip.size
        )
        const target = draft.clips.find((c) => c.id === picture.id)!
        Object.assign(target.transform, pip)
        target.name = 'Camera'
      }
    }
    const system = byRole.get('system-audio')
    if (system) place(system, null)

    const linkId = uid('l')
    for (const clip of created) {
      const target = draft.clips.find((c) => c.id === clip.id)!
      target.linkId = linkId
    }
  })

  select(created.map((c) => c.id))
  const firstPath = files[0].path
  toast({
    kind: 'success',
    title: 'Recording added',
    message: `${formatClock(result.duration)} recorded. The files are in Documents/Kificut/Recordings.`,
    action: { label: 'Show in Folder', run: () => void window.kificut.recorder.reveal(firstPath) }
  })
  if (result.note) toast({ kind: 'info', title: 'About the recording', message: result.note })
}
