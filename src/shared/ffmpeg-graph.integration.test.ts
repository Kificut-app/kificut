import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportFormatId, ExportSettings } from './export-formats'
import { buildRenderPlan, planToArgs, type OverlayImage } from './ffmpeg-graph'
import { defaultEffectParams, defaultMask, EFFECTS, fxImageKey } from './effects'
import type { MediaItem, Project } from './types'
import { createClip, createProject } from '../renderer/src/lib/factory'

/*
 * Renders small projects through the real FFmpeg binary to make sure every generated filter graph
 * is accepted. Skipped when the bundled binaries have not been downloaded.
 */

const exe = process.platform === 'win32' ? '.exe' : ''
const ffmpeg = join(__dirname, '../../node_modules/ffmpeg-static', `ffmpeg${exe}`)
const ffprobe = join(__dirname, '../../vendor/ffprobe', `ffprobe${exe}`)
const available = existsSync(ffmpeg) && existsSync(ffprobe)

let dir = ''
let video: MediaItem
let image: MediaItem
let overlay: OverlayImage

function run(args: string[]): void {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })
}

interface Probe {
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>
  format: { duration: string }
}

function probe(path: string): Probe {
  return JSON.parse(
    execFileSync(ffprobe, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path
    ]).toString()
  ) as Probe
}

function render(
  project: Project,
  settings: ExportSettings,
  overlays: Record<string, OverlayImage> = {}
): Probe {
  const plan = buildRenderPlan({ project, settings, overlays })
  const script = join(dir, `graph-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(script, plan.filterGraph)
  const args = planToArgs(plan, script, settings.outputPath, 7).filter(
    (a) => a !== '-progress' && a !== 'pipe:1'
  )
  execFileSync(ffmpeg, args, { stdio: 'pipe' })
  return probe(settings.outputPath)
}

describe.skipIf(!available)('FFmpeg export', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kificut-test-'))
    const videoPath = join(dir, 'source.mp4')
    run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      videoPath
    ])
    const imagePath = join(dir, 'logo.png')
    run(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=200x100,format=rgba', '-frames:v', '1', imagePath])
    const textPath = join(dir, 'text.png')
    run(['-f', 'lavfi', '-i', 'color=c=white@0.8:s=300x80,format=rgba', '-frames:v', '1', textPath])

    const base = { hasVideo: true, fps: 30, size: 1, container: '', audioCodec: null }
    video = {
      ...base,
      id: 'v',
      kind: 'video',
      name: 'source.mp4',
      path: videoPath,
      duration: 6,
      width: 640,
      height: 360,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac'
    }
    image = {
      ...base,
      id: 'i',
      kind: 'image',
      name: 'logo.png',
      path: imagePath,
      duration: 0,
      width: 200,
      height: 100,
      hasAudio: false,
      videoCodec: 'png'
    }
    overlay = { path: textPath, width: 300, height: 80 }
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function richProject(): { project: Project; textId: string } {
    const project = createProject('Integration', { width: 1280, height: 720, fps: 30 })
    project.media.push(video, image)
    const [v1, v2, a1] = project.tracks
    const clip = createClip({
      trackId: v1.id,
      kind: 'video',
      mediaId: 'v',
      start: 0,
      duration: 3,
      inPoint: 0.5,
      speed: 1.5,
      linkId: 'l',
      fadeIn: 0.3
    })
    clip.transform = {
      ...clip.transform,
      scale: 0.8,
      rotation: 12,
      opacity: 0.9,
      flipH: true,
      cropLeft: 0.1,
      cropBottom: 0.05
    }
    clip.color = {
      brightness: 0.05,
      contrast: 1.1,
      saturation: 1.3,
      gamma: 1.1,
      temperature: 0.3,
      tint: -0.1
    }
    const sound = createClip({
      trackId: a1.id,
      kind: 'audio',
      mediaId: 'v',
      start: 0,
      duration: 3,
      inPoint: 0.5,
      speed: 1.5,
      linkId: 'l',
      volume: 0.7,
      fadeOut: 0.5
    })
    const second = createClip({
      trackId: v1.id,
      kind: 'video',
      mediaId: 'v',
      start: 3,
      duration: 2,
      inPoint: 2
    })
    const logo = createClip({ trackId: v2.id, kind: 'image', mediaId: 'i', start: 0.5, duration: 2 })
    logo.transform = { ...logo.transform, scale: 0.3, x: 300, y: -200 }
    logo.color = { brightness: 0, contrast: 1, saturation: 0, gamma: 1, temperature: 0, tint: 0 }
    const solid = createClip({
      trackId: v2.id,
      kind: 'solid',
      start: 3.5,
      duration: 1,
      solidColor: '#123456',
      fadeIn: 0.5
    })
    solid.transform = { ...solid.transform, opacity: 0.5 }
    const text = createClip({ trackId: v2.id, kind: 'text', start: 2.6, duration: 0.8 })
    project.clips.push(clip, sound, second, logo, solid, text)
    return { project, textId: text.id }
  }

  function settings(
    format: ExportFormatId,
    extension: string,
    overrides: Partial<ExportSettings> = {}
  ): ExportSettings {
    return {
      format,
      width: 640,
      height: 360,
      fps: 30,
      quality: 'small',
      audioBitrate: 128,
      start: 0,
      end: 5,
      outputPath: join(dir, `out-${format}.${extension}`),
      ...overrides
    }
  }

  it('renders a layered project to H.264', () => {
    const { project, textId } = richProject()
    const result = render(project, settings('mp4-h264', 'mp4'), { [textId]: overlay })
    const v = result.streams.find((s) => s.codec_type === 'video')!
    expect(v.codec_name).toBe('h264')
    expect([v.width, v.height]).toEqual([640, 360])
    expect(result.streams.some((s) => s.codec_type === 'audio')).toBe(true)
    expect(parseFloat(result.format.duration)).toBeCloseTo(5, 0)
  }, 60_000)

  it('renders an in to out range', () => {
    const { project, textId } = richProject()
    const result = render(
      project,
      settings('mp4-h264', 'mp4', { start: 1, end: 3.5, outputPath: join(dir, 'range.mp4') }),
      {
        [textId]: overlay
      }
    )
    expect(parseFloat(result.format.duration)).toBeCloseTo(2.5, 0)
  }, 60_000)

  it.each([
    ['mp4-h265', 'mp4', 'hevc'],
    ['webm-vp9', 'webm', 'vp9'],
    ['mov-prores', 'mov', 'prores'],
    ['gif', 'gif', 'gif'],
    ['mp3', 'mp3', 'mp3'],
    ['wav', 'wav', 'pcm_s16le']
  ] as const)(
    'renders %s',
    (format, extension, codec) => {
      const { project, textId } = richProject()
      const result = render(
        project,
        settings(format, extension, { start: 0, end: 1.5, width: 320, height: 180 }),
        {
          [textId]: overlay
        }
      )
      expect(result.streams.map((s) => s.codec_name)).toContain(codec)
    },
    120_000
  )

  it('renders every effect with a shape, a border and a shadow', () => {
    const { project, textId } = richProject()
    const [v1, v2] = project.tracks
    const mask = join(dir, 'mask.png')
    run([
      '-f',
      'lavfi',
      '-i',
      "color=black@0:s=160x90,format=rgba,geq=r=255:g=255:b=255:a='if(lt(hypot(X-80,Y-45),40),255,0)'",
      '-frames:v',
      '1',
      mask
    ])
    const ring = join(dir, 'ring.png')
    run(['-f', 'lavfi', '-i', 'color=white@0.6:s=160x90,format=rgba', '-frames:v', '1', ring])
    const shade = join(dir, 'shade.png')
    run(['-f', 'lavfi', '-i', 'color=gray:s=160x90,format=rgba', '-frames:v', '1', shade])

    const clip = project.clips.find((c) => c.trackId === v1.id && c.kind === 'video')!
    clip.effects = EFFECTS.map((d, i) => ({
      id: `e${i}`,
      type: d.type,
      enabled: true,
      params: defaultEffectParams(d.type)
    }))
    clip.mask = { ...defaultMask('circle', 640, 360), feather: 12 }
    clip.border = { width: 6, color: '#ffcc00' }
    clip.shadow = { color: '#000000', opacity: 0.7, blur: 20, distance: 16, angle: 60 }
    clip.transform = { ...clip.transform, rotation: 12 }
    const logo = project.clips.find((c) => c.trackId === v2.id && c.kind === 'image')!
    logo.effects = [
      { id: 's', type: 'sharpen', enabled: true, params: defaultEffectParams('sharpen') },
      {
        id: 'k',
        type: 'chromaKey',
        enabled: true,
        params: { ...defaultEffectParams('chromaKey'), color: '#ff0000' }
      }
    ]
    logo.shadow = { color: '#202020', opacity: 0.5, blur: 8, distance: 6, angle: 90 }

    const vignette = EFFECTS.findIndex((d) => d.type === 'vignette')
    const result = render(
      project,
      settings('mp4-h264', 'mp4', { end: 2, outputPath: join(dir, 'effects.mp4') }),
      {
        [textId]: overlay,
        [fxImageKey.mask(clip.id)]: { path: mask, width: 160, height: 90 },
        [fxImageKey.border(clip.id)]: { path: ring, width: 160, height: 90 },
        [fxImageKey.vignette(clip.id, `e${vignette}`)]: { path: shade, width: 160, height: 90 }
      }
    )
    expect(parseFloat(result.format.duration)).toBeCloseTo(2, 0)
    expect(result.streams.find((s) => s.codec_type === 'video')?.width).toBe(640)
  }, 120_000)

  it('cuts a layer to its mask', () => {
    const project = createProject('Mask', { width: 320, height: 180, fps: 30, background: '#0000ff' })
    const solid = createClip({
      trackId: project.tracks[0].id,
      kind: 'solid',
      start: 0,
      duration: 1,
      solidColor: '#ff0000'
    })
    solid.mask = defaultMask('ellipse', 320, 180)
    project.clips.push(solid)
    const mask = join(dir, 'oval.png')
    run([
      '-f',
      'lavfi',
      '-i',
      "color=black@0:s=320x180,format=rgba,geq=r=255:g=255:b=255:a='if(lt(hypot((X-160)/160,(Y-90)/90),1),255,0)'",
      '-frames:v',
      '1',
      mask
    ])
    const out = join(dir, 'mask.mp4')
    render(
      project,
      settings('mp4-h264', 'mp4', { end: 1, width: 320, height: 180, quality: 'high', outputPath: out }),
      {
        [fxImageKey.mask(solid.id)]: { path: mask, width: 320, height: 180 }
      }
    )
    const frame = execFileSync(ffmpeg, [
      '-v',
      'error',
      '-i',
      out,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ])
    const pixel = (x: number, y: number) => [...frame.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)]
    const [cr, , cb] = pixel(160, 90)
    const [kr, , kb] = pixel(4, 4)
    expect(cr).toBeGreaterThan(200)
    expect(cb).toBeLessThan(60)
    expect(kr).toBeLessThan(60)
    expect(kb).toBeGreaterThan(200)
  }, 60_000)

  it('renders an empty timeline as black with silence', () => {
    const project = createProject('Empty', { width: 320, height: 180 })
    const result = render(
      project,
      settings('mp4-h264', 'mp4', { end: 1, width: 320, height: 180, outputPath: join(dir, 'empty.mp4') })
    )
    expect(result.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video'])
  }, 60_000)
})
