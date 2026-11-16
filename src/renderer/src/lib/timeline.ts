import { clamp } from '@shared/time'
import type { Clip, MediaItem, Project, Track, TrackKind } from '@shared/types'
import { uid } from './factory'

export const EPSILON = 1e-6

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration
}

export function projectDuration(project: Project): number {
  let end = 0
  for (const clip of project.clips) end = Math.max(end, clipEnd(clip))
  return end
}

export function tracksOfKind(project: Project, kind: TrackKind): Track[] {
  return project.tracks.filter((t) => t.kind === kind)
}

/** Video tracks top to bottom, then audio tracks, which is how the timeline draws them. */
export function displayTracks(project: Project): Track[] {
  return [...tracksOfKind(project, 'video').reverse(), ...tracksOfKind(project, 'audio')]
}

export function trackClips(project: Project, trackId: string): Clip[] {
  return project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
}

export function trackKindForClip(kind: Clip['kind']): TrackKind {
  return kind === 'audio' ? 'audio' : 'video'
}

export function isVisual(clip: Clip): boolean {
  return clip.kind !== 'audio'
}

export function mediaFor(project: Project, clip: Clip): MediaItem | undefined {
  return clip.mediaId ? project.media.find((m) => m.id === clip.mediaId) : undefined
}

export function sourceTime(clip: Clip, time: number): number {
  return clip.inPoint + (time - clip.start) * clip.speed
}

export function fadeFactor(clip: Clip, time: number): number {
  const local = time - clip.start
  let factor = 1
  if (clip.fadeIn > 0 && local < clip.fadeIn) factor = Math.min(factor, local / clip.fadeIn)
  if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut) {
    factor = Math.min(factor, (clip.duration - local) / clip.fadeOut)
  }
  return clamp(factor, 0, 1)
}

/** Longest timeline duration the clip can have from its current in point. Infinity for stills. */
export function maxDuration(clip: Clip, media: MediaItem | undefined): number {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return Infinity
  if (!media) return clip.duration
  return Math.max(0, (media.duration - clip.inPoint) / clip.speed)
}

/** Expands a set of clip ids to include every clip linked to them. */
export function withLinked(project: Project, ids: Iterable<string>): string[] {
  const result = new Set(ids)
  const links = new Set<string>()
  for (const clip of project.clips) if (result.has(clip.id) && clip.linkId) links.add(clip.linkId)
  if (links.size)
    for (const clip of project.clips) if (clip.linkId && links.has(clip.linkId)) result.add(clip.id)
  return [...result]
}

export function isTrackLocked(project: Project, trackId: string): boolean {
  return project.tracks.find((t) => t.id === trackId)?.locked ?? false
}

/**
 * Removes whatever occupies [start, end) on a track, trimming or splitting clips that partly overlap.
 * This is the overwrite behaviour used when dropping or moving clips.
 */
export function clearRange(
  project: Project,
  trackId: string,
  start: number,
  end: number,
  exclude: Set<string>
): void {
  if (end - start < EPSILON) return
  const result: Clip[] = []
  for (const clip of project.clips) {
    if (clip.trackId !== trackId || exclude.has(clip.id)) {
      result.push(clip)
      continue
    }
    const cs = clip.start
    const ce = clipEnd(clip)
    if (ce <= start + EPSILON || cs >= end - EPSILON) {
      result.push(clip)
      continue
    }
    if (cs >= start - EPSILON && ce <= end + EPSILON) continue

    if (cs < start && ce > end) {
      const right: Clip = structuredCloneClip(clip)
      right.id = uid('c')
      right.linkId = null
      const cut = end - cs
      right.start = end
      right.duration = ce - end
      right.inPoint = clip.inPoint + cut * clip.speed
      right.fadeIn = 0
      clip.duration = start - cs
      clip.fadeOut = 0
      clip.fadeIn = Math.min(clip.fadeIn, clip.duration)
      result.push(clip, right)
      continue
    }
    if (cs < start) {
      clip.duration = start - cs
      clip.fadeOut = Math.min(clip.fadeOut, clip.duration)
      clip.fadeIn = Math.min(clip.fadeIn, clip.duration - clip.fadeOut)
      result.push(clip)
      continue
    }
    const cut = end - cs
    clip.start = end
    clip.duration = ce - end
    clip.inPoint += cut * clip.speed
    clip.fadeIn = Math.min(clip.fadeIn, clip.duration)
    clip.fadeOut = Math.min(clip.fadeOut, clip.duration - clip.fadeIn)
    result.push(clip)
  }
  project.clips = result
}

function structuredCloneClip(clip: Clip): Clip {
  return JSON.parse(JSON.stringify(clip)) as Clip
}

/** Applies overwrite for each listed clip against everything else on its track. */
export function resolveOverlaps(project: Project, ids: string[]): void {
  const moving = new Set(ids)
  const clips = project.clips.filter((c) => moving.has(c.id))
  for (const clip of clips) {
    if (isTrackLocked(project, clip.trackId)) continue
    clearRange(project, clip.trackId, clip.start, clipEnd(clip), moving)
  }
}

/**
 * Splits one clip at a timeline time. Returns the id of the new right hand clip, or null when the
 * time is not inside the clip.
 */
export function splitClip(project: Project, clipId: string, time: number, minLength: number): string | null {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return null
  if (time <= clip.start + minLength - EPSILON || time >= clipEnd(clip) - minLength + EPSILON) return null
  const right = structuredCloneClip(clip)
  right.id = uid('c')
  const cut = time - clip.start
  right.start = time
  right.duration = clip.duration - cut
  right.inPoint = clip.inPoint + cut * clip.speed
  right.fadeIn = 0
  clip.duration = cut
  clip.fadeOut = 0
  clip.fadeIn = Math.min(clip.fadeIn, clip.duration)
  right.fadeOut = Math.min(right.fadeOut, right.duration)
  project.clips.push(right)
  return right.id
}

/** Splits clips (and their linked partners) at a time, keeping new halves linked to each other. */
export function splitClips(project: Project, ids: string[], time: number, minLength: number): string[] {
  const targets = withLinked(project, ids)
  const newLinks = new Map<string, string>()
  const created: string[] = []
  for (const id of targets) {
    const clip = project.clips.find((c) => c.id === id)
    if (!clip || isTrackLocked(project, clip.trackId)) continue
    const rightId = splitClip(project, id, time, minLength)
    if (!rightId) continue
    const right = project.clips.find((c) => c.id === rightId)!
    if (clip.linkId) {
      if (!newLinks.has(clip.linkId)) newLinks.set(clip.linkId, uid('l'))
      right.linkId = newLinks.get(clip.linkId)!
    }
    created.push(rightId)
  }
  return created
}

/** Deletes clips and pulls later clips on the same tracks left to close the gap. */
export function rippleDelete(project: Project, ids: string[]): void {
  const remove = new Set(withLinked(project, ids))
  const removed = project.clips.filter((c) => remove.has(c.id))
  project.clips = project.clips.filter((c) => !remove.has(c.id))

  const byTrack = new Map<string, Array<{ start: number; end: number }>>()
  for (const clip of removed) {
    const list = byTrack.get(clip.trackId) ?? []
    list.push({ start: clip.start, end: clipEnd(clip) })
    byTrack.set(clip.trackId, list)
  }

  for (const [trackId, ranges] of byTrack) {
    const merged = mergeRanges(ranges)
    for (const clip of project.clips) {
      if (clip.trackId !== trackId) continue
      let shift = 0
      for (const range of merged) {
        if (clip.start >= range.end - EPSILON) shift += range.end - range.start
      }
      if (shift > 0) {
        // Never slide into the clip that sits before the gap.
        const previousEnd = Math.max(
          0,
          ...project.clips
            .filter((c) => c.trackId === trackId && c.id !== clip.id && clipEnd(c) <= clip.start + EPSILON)
            .map(clipEnd)
        )
        clip.start = Math.max(previousEnd, clip.start - shift)
      }
    }
  }
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.start <= last.end + EPSILON) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

export function isRangeFree(project: Project, trackId: string, start: number, end: number): boolean {
  return !project.clips.some(
    (c) => c.trackId === trackId && c.start < end - EPSILON && clipEnd(c) > start + EPSILON
  )
}

/**
 * Picks a track for a new clip. Prefers the given track, then the first free unlocked track of the
 * right kind (searching from the top for overlays), and returns null when every track is busy.
 */
export function findFreeTrack(
  project: Project,
  kind: TrackKind,
  start: number,
  end: number,
  fromTop: boolean
): Track | null {
  const tracks = tracksOfKind(project, kind).filter((t) => !t.locked)
  const ordered = fromTop ? [...tracks].reverse() : tracks
  if (fromTop) {
    // Overlays go above anything already on screen at that time.
    let candidate: Track | null = null
    for (const track of ordered) {
      if (isRangeFree(project, track.id, start, end)) candidate = track
      else break
    }
    return candidate
  }
  return ordered.find((t) => isRangeFree(project, t.id, start, end)) ?? null
}

export function editPoints(project: Project): number[] {
  const set = new Set<number>([0])
  for (const clip of project.clips) {
    set.add(round6(clip.start))
    set.add(round6(clipEnd(clip)))
  }
  return [...set].sort((a, b) => a - b)
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export function snapPoints(project: Project, exclude: Set<string>, playhead: number): number[] {
  const points = [0, playhead]
  for (const clip of project.clips) {
    if (exclude.has(clip.id)) continue
    points.push(clip.start, clipEnd(clip))
  }
  for (const marker of project.markers) points.push(marker.time)
  if (project.inPoint !== null) points.push(project.inPoint)
  if (project.outPoint !== null) points.push(project.outPoint)
  return points
}

/** Returns the snapped value and the point it snapped to, if any was within the threshold. */
export function snapValue(
  value: number,
  points: number[],
  threshold: number
): { value: number; point: number | null } {
  let best: number | null = null
  let bestDistance = threshold
  for (const point of points) {
    const distance = Math.abs(point - value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = point
    }
  }
  return best === null ? { value, point: null } : { value: best, point: best }
}

/**
 * Finds the offset that snaps any of several edges to a snap point. Used when dragging clips, where
 * either the start or the end of any moving clip can lock on.
 */
export function snapOffset(
  edges: number[],
  delta: number,
  points: number[],
  threshold: number
): { delta: number; point: number | null } {
  let bestDelta = delta
  let bestPoint: number | null = null
  let bestDistance = threshold
  for (const edge of edges) {
    const moved = edge + delta
    for (const point of points) {
      const distance = Math.abs(point - moved)
      if (distance < bestDistance) {
        bestDistance = distance
        bestDelta = point - edge
        bestPoint = point
      }
    }
  }
  return { delta: bestDelta, point: bestPoint }
}
