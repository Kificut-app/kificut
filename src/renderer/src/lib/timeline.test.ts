import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { createClip, createProject } from './factory'
import {
  clearRange,
  editPoints,
  fadeFactor,
  findFreeTrack,
  projectDuration,
  rippleDelete,
  snapOffset,
  splitClips,
  withLinked
} from './timeline'

function setup(): { project: Project; v1: string; v2: string; a1: string } {
  const project = createProject('Test')
  const [v1, v2, a1] = project.tracks.map((t) => t.id)
  return { project, v1, v2, a1 }
}

describe('clearRange', () => {
  it('removes clips fully inside the range', () => {
    const { project, v1 } = setup()
    project.clips.push(createClip({ trackId: v1, kind: 'video', start: 2, duration: 2 }))
    clearRange(project, v1, 1, 5, new Set())
    expect(project.clips).toHaveLength(0)
  })

  it('trims a clip that overlaps the start of the range', () => {
    const { project, v1 } = setup()
    const clip = createClip({ trackId: v1, kind: 'video', start: 0, duration: 4 })
    project.clips.push(clip)
    clearRange(project, v1, 3, 6, new Set())
    expect(project.clips[0].duration).toBe(3)
    expect(project.clips[0].inPoint).toBe(0)
  })

  it('trims the head of a clip and advances its in point', () => {
    const { project, v1 } = setup()
    project.clips.push(
      createClip({ trackId: v1, kind: 'video', start: 2, duration: 4, inPoint: 1, speed: 2 })
    )
    clearRange(project, v1, 0, 3, new Set())
    const [clip] = project.clips
    expect(clip.start).toBe(3)
    expect(clip.duration).toBe(3)
    expect(clip.inPoint).toBe(3)
  })

  it('splits a clip that covers the whole range', () => {
    const { project, v1 } = setup()
    project.clips.push(createClip({ trackId: v1, kind: 'video', start: 0, duration: 10 }))
    clearRange(project, v1, 4, 6, new Set())
    const sorted = [...project.clips].sort((a, b) => a.start - b.start)
    expect(sorted).toHaveLength(2)
    expect(sorted[0].duration).toBe(4)
    expect(sorted[1].start).toBe(6)
    expect(sorted[1].duration).toBe(4)
    expect(sorted[1].inPoint).toBe(6)
  })

  it('leaves other tracks and excluded clips alone', () => {
    const { project, v1, v2 } = setup()
    const keep = createClip({ trackId: v1, kind: 'video', start: 0, duration: 10 })
    project.clips.push(keep, createClip({ trackId: v2, kind: 'video', start: 0, duration: 10 }))
    clearRange(project, v1, 2, 4, new Set([keep.id]))
    expect(project.clips).toHaveLength(2)
  })
})

describe('splitClips', () => {
  it('splits linked clips together and links the new halves', () => {
    const { project, v1, a1 } = setup()
    const video = createClip({ trackId: v1, kind: 'video', start: 0, duration: 10, linkId: 'l1' })
    const audio = createClip({ trackId: a1, kind: 'audio', start: 0, duration: 10, linkId: 'l1' })
    project.clips.push(video, audio)

    const created = splitClips(project, [video.id], 4, 1 / 30)
    expect(created).toHaveLength(2)
    expect(project.clips).toHaveLength(4)
    const right = project.clips.filter((c) => created.includes(c.id))
    expect(right.every((c) => c.start === 4 && c.inPoint === 4 && c.duration === 6)).toBe(true)
    expect(right[0].linkId).toBe(right[1].linkId)
    expect(right[0].linkId).not.toBe('l1')
  })

  it('ignores split points too close to an edge', () => {
    const { project, v1 } = setup()
    const clip = createClip({ trackId: v1, kind: 'video', start: 0, duration: 2 })
    project.clips.push(clip)
    expect(splitClips(project, [clip.id], 0.01, 1 / 30)).toHaveLength(0)
  })
})

describe('rippleDelete', () => {
  it('closes the gap on the affected track only', () => {
    const { project, v1, v2 } = setup()
    const a = createClip({ trackId: v1, kind: 'video', start: 0, duration: 3 })
    const b = createClip({ trackId: v1, kind: 'video', start: 3, duration: 2 })
    const c = createClip({ trackId: v1, kind: 'video', start: 5, duration: 2 })
    const other = createClip({ trackId: v2, kind: 'video', start: 6, duration: 1 })
    project.clips.push(a, b, c, other)

    rippleDelete(project, [b.id])
    expect(project.clips.find((x) => x.id === c.id)!.start).toBe(3)
    expect(project.clips.find((x) => x.id === other.id)!.start).toBe(6)
  })
})

describe('helpers', () => {
  it('expands selection to linked clips', () => {
    const { project, v1, a1 } = setup()
    const video = createClip({ trackId: v1, kind: 'video', start: 0, duration: 1, linkId: 'x' })
    const audio = createClip({ trackId: a1, kind: 'audio', start: 0, duration: 1, linkId: 'x' })
    project.clips.push(video, audio)
    expect(withLinked(project, [video.id]).sort()).toEqual([video.id, audio.id].sort())
  })

  it('computes fades', () => {
    const clip = createClip({ trackId: 't', kind: 'video', start: 10, duration: 4, fadeIn: 1, fadeOut: 2 })
    expect(fadeFactor(clip, 10)).toBe(0)
    expect(fadeFactor(clip, 10.5)).toBeCloseTo(0.5)
    expect(fadeFactor(clip, 11.5)).toBe(1)
    expect(fadeFactor(clip, 13)).toBeCloseTo(0.5)
  })

  it('finds a free overlay track above busy ones', () => {
    const { project, v1, v2 } = setup()
    project.clips.push(createClip({ trackId: v1, kind: 'video', start: 0, duration: 10 }))
    expect(findFreeTrack(project, 'video', 2, 4, true)?.id).toBe(v2)
    project.clips.push(createClip({ trackId: v2, kind: 'text', start: 0, duration: 10 }))
    expect(findFreeTrack(project, 'video', 2, 4, true)).toBeNull()
  })

  it('snaps any moving edge to the nearest point', () => {
    const result = snapOffset([0, 5], 0.95, [6], 0.2)
    expect(result.delta).toBeCloseTo(1)
    expect(result.point).toBe(6)
    expect(snapOffset([0], 3, [10], 0.2).point).toBeNull()
  })

  it('reports duration and edit points', () => {
    const { project, v1 } = setup()
    project.clips.push(createClip({ trackId: v1, kind: 'video', start: 1, duration: 2 }))
    expect(projectDuration(project)).toBe(3)
    expect(editPoints(project)).toEqual([0, 1, 3])
  })
})
