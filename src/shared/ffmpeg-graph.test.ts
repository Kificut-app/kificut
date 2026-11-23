import { describe, expect, it } from 'vitest'
import type { ExportSettings } from './export-formats'
import { atempoChain, buildRenderPlan, clipToRange, ffColor, num, planToArgs } from './ffmpeg-graph'
import type { Clip, MediaItem, Project } from './types'
import { createClip, createProject } from '../renderer/src/lib/factory'

const video: MediaItem = {
  id: 'm1',
  kind: 'video',
  name: 'clip.mp4',
  path: '/media/clip.mp4',
  duration: 20,
  width: 1920,
  height: 1080,
  fps: 30,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  size: 1000
}

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    format: 'mp4-h264',
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 'high',
    audioBitrate: 192,
    start: 0,
    end: 10,
    outputPath: '/out/video.mp4',
    ...overrides
  }
}

function project(clips: (p: Project) => Clip[]): Project {
  const p = createProject('Graph')
  p.media.push(video)
  p.clips.push(...clips(p))
  return p
}

describe('helpers', () => {
  it('formats numbers without exponents', () => {
    expect(num(1e-7)).toBe('0')
    expect(num(2.5)).toBe('2.5')
    expect(num(3)).toBe('3')
  })

  it('converts colors', () => {
    expect(ffColor('#fff')).toBe('0xFFFFFF')
    expect(ffColor('#1a2b3c')).toBe('0x1A2B3C')
    expect(ffColor('nope')).toBe('0x000000')
  })

  it('chains atempo for slow speeds', () => {
    expect(atempoChain(1)).toEqual([])
    expect(atempoChain(2)).toEqual(['atempo=2'])
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5'])
    expect(atempoChain(0.3)).toEqual(['atempo=0.5', 'atempo=0.6'])
  })

  it('cuts clips to the export range', () => {
    const clip = createClip({
      trackId: 't',
      kind: 'video',
      start: 2,
      duration: 6,
      inPoint: 1,
      speed: 2,
      fadeOut: 1
    })
    const ranged = clipToRange(clip, 4, 20)!
    expect(ranged.start).toBe(0)
    expect(ranged.duration).toBe(4)
    expect(ranged.inPoint).toBe(5)
    expect(ranged.fadeOutStart).toBe(3)
    expect(clipToRange(clip, 9, 12)).toBeNull()
  })
})

describe('buildRenderPlan', () => {
  it('composites a linked video and audio pair', () => {
    const p = project((pr) => {
      const [v1, , a1] = pr.tracks
      return [
        createClip({
          trackId: v1.id,
          kind: 'video',
          mediaId: 'm1',
          start: 1,
          duration: 5,
          inPoint: 2,
          linkId: 'l'
        }),
        createClip({
          trackId: a1.id,
          kind: 'audio',
          mediaId: 'm1',
          start: 1,
          duration: 5,
          inPoint: 2,
          linkId: 'l'
        })
      ]
    })
    const plan = buildRenderPlan({ project: p, settings: settings(), overlays: {} })

    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[0]).toEqual(['-ss', '2', '-t', '5', '-i', '/media/clip.mp4'])
    expect(plan.filterGraph).toContain('color=c=0x000000:s=1920x1080:r=30:d=10')
    expect(plan.filterGraph).toContain('setpts=PTS+1/TB')
    expect(plan.filterGraph).toContain("enable='between(t,1,6)'")
    expect(plan.filterGraph).toContain('adelay=1000:all=1')
    expect(plan.filterGraph).toContain('[vout]')
    expect(plan.filterGraph).toContain('[aout]')
    expect(plan.outputArgs).toContain('libx264')
    expect(plan.duration).toBe(10)
  })

  it('decodes video with transparency with libvpx and keeps its alpha', () => {
    const p = project((pr) => [
      createClip({
        trackId: pr.tracks[0].id,
        kind: 'video',
        mediaId: 'm1',
        start: 0,
        duration: 3,
        inPoint: 0
      })
    ])
    p.media = [
      { ...video, path: '/media/cutout.webm', videoCodec: 'vp9', container: 'matroska,webm', alpha: true }
    ]
    const plan = buildRenderPlan({ project: p, settings: settings(), overlays: {} })
    expect(plan.inputs[0]).toEqual(['-ss', '0', '-t', '3', '-c:v', 'libvpx-vp9', '-i', '/media/cutout.webm'])
    expect(plan.filterGraph).toContain('format=rgba')
  })

  it('skips hidden tracks and muted audio', () => {
    const p = project((pr) => {
      const [v1, , a1] = pr.tracks
      v1.hidden = true
      a1.muted = true
      return [
        createClip({ trackId: v1.id, kind: 'video', mediaId: 'm1', start: 0, duration: 5 }),
        createClip({ trackId: a1.id, kind: 'audio', mediaId: 'm1', start: 0, duration: 5 })
      ]
    })
    const plan = buildRenderPlan({ project: p, settings: settings(), overlays: {} })
    expect(plan.inputs).toHaveLength(0)
    expect(plan.filterGraph).toContain('anullsrc')
  })

  it('applies speed, transform, color and fades', () => {
    const p = project((pr) => {
      const clip = createClip({
        trackId: pr.tracks[0].id,
        kind: 'video',
        mediaId: 'm1',
        start: 0,
        duration: 4,
        speed: 2,
        fadeIn: 0.5
      })
      clip.transform = {
        ...clip.transform,
        scale: 0.5,
        rotation: 90,
        opacity: 0.8,
        flipH: true,
        cropLeft: 0.1
      }
      clip.color = { brightness: 0.1, contrast: 1.2, saturation: 0.5, gamma: 1, temperature: 0, tint: 0 }
      return [clip]
    })
    const graph = buildRenderPlan({ project: p, settings: settings(), overlays: {} }).filterGraph
    expect(graph).toContain('setpts=(PTS-STARTPTS)/2')
    expect(graph).toContain('hflip')
    expect(graph).toContain('crop=iw*0.9:ih*1:iw*0.1:ih*0')
    expect(graph).toContain('scale=864:540')
    expect(graph).toContain('eq=brightness=0.1:contrast=1.2:saturation=0.5:gamma=1')
    expect(graph).toContain('rotate=a=1.57079633')
    expect(graph).toContain('colorchannelmixer=aa=0.8')
    expect(graph).toContain('fade=t=in:st=0:d=0.5:alpha=1')
  })

  it('scales layer geometry to the export size', () => {
    const p = project((pr) => [
      createClip({ trackId: pr.tracks[0].id, kind: 'video', mediaId: 'm1', start: 0, duration: 4 })
    ])
    const graph = buildRenderPlan({
      project: p,
      settings: settings({ width: 1280, height: 720 }),
      overlays: {}
    }).filterGraph
    expect(graph).toContain('s=1280x720')
    expect(graph).toContain('scale=1280:720')
    expect(graph).toContain('overlay=x=640-overlay_w/2:y=360-overlay_h/2')
  })

  it('uses rendered overlays for text clips', () => {
    const p = project((pr) => [createClip({ trackId: pr.tracks[1].id, kind: 'text', start: 0, duration: 3 })])
    const clipId = p.clips[0].id
    const plan = buildRenderPlan({
      project: p,
      settings: settings(),
      overlays: { [clipId]: { path: '/tmp/text.png', width: 400, height: 120 } }
    })
    expect(plan.inputs[0]).toEqual(['-loop', '1', '-framerate', '30', '-t', '3', '-i', '/tmp/text.png'])
    expect(plan.filterGraph).toContain('scale=400:120')
  })

  it('builds a palette for GIF and leaves out audio', () => {
    const p = project((pr) => [
      createClip({ trackId: pr.tracks[0].id, kind: 'video', mediaId: 'm1', start: 0, duration: 2 })
    ])
    const plan = buildRenderPlan({ project: p, settings: settings({ format: 'gif', fps: 15 }), overlays: {} })
    expect(plan.filterGraph).toContain('palettegen')
    expect(plan.filterGraph).not.toContain('[aout]')
    expect(plan.outputArgs).not.toContain('-c:a')
  })

  it('renders audio only formats without video', () => {
    const p = project((pr) => [
      createClip({ trackId: pr.tracks[2].id, kind: 'audio', mediaId: 'm1', start: 0, duration: 2 })
    ])
    const plan = buildRenderPlan({ project: p, settings: settings({ format: 'mp3' }), overlays: {} })
    expect(plan.filterGraph).not.toContain('[vout]')
    expect(plan.outputArgs).toContain('libmp3lame')
  })

  it('passes the graph through a script file', () => {
    const plan = buildRenderPlan({ project: project(() => []), settings: settings(), overlays: {} })
    expect(planToArgs(plan, '/tmp/g.txt', '/out.mp4', 7)).toContain('-/filter_complex')
    expect(planToArgs(plan, '/tmp/g.txt', '/out.mp4', 6)).toContain('-filter_complex_script')
  })
})
