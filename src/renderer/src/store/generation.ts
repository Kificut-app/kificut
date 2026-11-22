import { create } from 'zustand'
import type { Clip, MediaItem } from '@shared/types'
import { snapToFrame } from '@shared/time'
import type { GenerationJob, GenerationRequest, GenerationSettings } from '@shared/generation'
import { clipsForMedia } from '../lib/factory'
import { findFreeTrack, isRangeFree, tracksOfKind } from '../lib/timeline'
import { commit, select, useEditor } from './editor'
import { appendTrack, errorText, importPaths } from './actions'
import { toast } from './ui'

/*
 * Scene and picture generation in the editor window. Jobs run in the main process (where the keys
 * are); this store follows them, imports each result into the media library when it is ready and,
 * when asked, places it at the playhead from when the job started.
 */

interface GenerationState {
  jobs: GenerationJob[]
  settings: GenerationSettings | null
  /** Media id of each finished job's file, once imported. */
  media: Record<number, string>
}

export const useGeneration = create<GenerationState>(() => ({ jobs: [], settings: null, media: {} }))

/** Where to put each job's result: the timeline time when it started, and whether to place it. */
const placements = new Map<number, { start: number; place: boolean }>()
const handled = new Set<number>()
let started = false

function upsert(job: GenerationJob): void {
  useGeneration.setState((s) => {
    const others = s.jobs.filter((j) => j.id !== job.id)
    return { jobs: [job, ...others].sort((a, b) => b.id - a.id) }
  })
}

export function startGenerationSync(): void {
  if (started) return
  started = true
  void window.kificut.generation.settings().then((settings) => useGeneration.setState({ settings }))
  void window.kificut.generation.jobs().then((jobs) => {
    // Jobs that finished before this window loaded are not imported again.
    for (const job of jobs) if (job.state !== 'running') handled.add(job.id)
    useGeneration.setState({ jobs: jobs.sort((a, b) => b.id - a.id) })
  })
  window.kificut.generation.onJob((job) => {
    upsert(job)
    if (job.state === 'running' || handled.has(job.id)) return
    handled.add(job.id)
    if (job.state === 'done' && job.path) void finishJob(job)
    else if (job.state === 'failed') {
      toast({
        kind: 'error',
        title: `The ${job.kind === 'video' ? 'scene' : 'picture'} could not be generated`,
        message: job.error ?? undefined
      })
    }
  })
}

export async function refreshGenerationSettings(): Promise<GenerationSettings> {
  const settings = await window.kificut.generation.settings()
  useGeneration.setState({ settings })
  return settings
}

/** The request behind each job started here, for Try Again. */
const requests = new Map<number, { request: GenerationRequest; place: boolean }>()

/** Starts a job and remembers where its result goes. */
export async function startGeneration(
  request: GenerationRequest,
  place: boolean,
  at?: number
): Promise<GenerationJob> {
  const start = at ?? useEditor.getState().playhead
  const job = await window.kificut.generation.start(request)
  placements.set(job.id, { start, place: place && !!useEditor.getState().project })
  requests.set(job.id, { request, place })
  upsert(job)
  return job
}

/** Runs a failed or cancelled job again with the same settings. Returns false when it is unknown. */
export async function retryJob(job: GenerationJob): Promise<boolean> {
  const previous = requests.get(job.id)
  if (!previous) return false
  await startGeneration(previous.request, previous.place)
  return true
}

export function canRetry(job: GenerationJob): boolean {
  return requests.has(job.id)
}

/**
 * Puts generated media on the timeline at `time` without covering anything: the picture on the
 * lowest free video track above what is already playing there (or a new one on top), its sound on a
 * free audio track.
 */
export function placeOnFreeTracks(media: MediaItem, time: number): string[] {
  const project = useEditor.getState().project
  if (!project) return []
  const start = snapToFrame(Math.max(0, time), project.settings.fps)
  const length = media.kind === 'image' ? 5 : media.duration
  const created: Clip[] = []
  commit((draft) => {
    const end = start + length
    const video = findFreeTrack(draft, 'video', start, end, true)?.id ?? appendTrack(draft, 'video')
    const audio =
      media.kind === 'video' && media.hasAudio
        ? (tracksOfKind(draft, 'audio').find((t) => !t.locked && isRangeFree(draft, t.id, start, end))?.id ??
          appendTrack(draft, 'audio'))
        : null
    const clips = clipsForMedia(media, video, audio, start)
    draft.clips.push(...clips)
    created.push(...clips)
  })
  select(created.map((c) => c.id))
  return created.map((c) => c.id)
}

/** Imports a finished job's file; returns the media item, or null without a project. */
export async function importJob(job: GenerationJob): Promise<MediaItem | null> {
  if (!job.path || !useEditor.getState().project) return null
  const known = useGeneration.getState().media[job.id]
  const existing = known ? useEditor.getState().project!.media.find((m) => m.id === known) : null
  if (existing) return existing
  const [media] = await importPaths([job.path])
  if (!media) return null
  useGeneration.setState((s) => ({ media: { ...s.media, [job.id]: media.id } }))
  return media
}

/** Adds a finished job's result at the playhead (the Add button in the job list). */
export async function addJobAtPlayhead(job: GenerationJob): Promise<void> {
  const media = await importJob(job)
  if (media) placeOnFreeTracks(media, useEditor.getState().playhead)
}

async function finishJob(job: GenerationJob): Promise<void> {
  const what = job.kind === 'video' ? 'Scene' : 'Picture'
  try {
    const media = await importJob(job)
    if (!media) {
      toast({
        kind: 'success',
        title: `${what} ready`,
        message: 'Saved in Documents/Kificut/Generated. Open or create a project to use it.',
        action: { label: 'Show in Folder', run: () => void window.kificut.recorder.reveal(job.path!) }
      })
      return
    }
    const placement = placements.get(job.id)
    if (placement?.place) {
      placeOnFreeTracks(media, placement.start)
      toast({ kind: 'success', title: `${what} added`, message: job.prompt.slice(0, 120) })
    } else {
      toast({
        kind: 'success',
        title: `${what} ready`,
        message: 'It is in the media library.',
        action: {
          label: 'Add at Playhead',
          run: () => placeOnFreeTracks(media, useEditor.getState().playhead)
        }
      })
    }
  } catch (error) {
    toast({
      kind: 'error',
      title: `The ${what.toLowerCase()} was made but could not be added`,
      message: errorText(error)
    })
  }
}
