import { computeLayer, fitsToFrame } from './geometry'
import type { ExportSettings } from './export-formats'
import type { Clip, ColorAdjust, MediaItem, Project } from './types'

/** A rasterized text layer, written to disk by the renderer before export. */
export interface OverlayImage {
  path: string
  width: number
  height: number
}

export interface RenderJob {
  project: Project
  settings: ExportSettings
  overlays: Record<string, OverlayImage>
}

export interface RenderPlan {
  inputs: string[][]
  filterGraph: string
  outputArgs: string[]
  duration: number
}

export const SAMPLE_RATE = 48000
const EPSILON = 1e-4

/** Formats a number for FFmpeg without exponent notation or trailing zeros. */
export function num(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '0'
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed
}

export function ffColor(hex: string): string {
  const clean = hex.replace('#', '').trim()
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.slice(0, 6)
  return /^[0-9a-fA-F]{6}$/.test(full) ? `0x${full.toUpperCase()}` : '0x000000'
}

/** atempo accepts 0.5..100 per instance, so slower speeds are split into a chain. */
export function atempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < EPSILON) return []
  const filters: string[] = []
  let remaining = speed
  while (remaining < 0.5) {
    filters.push('atempo=0.5')
    remaining /= 0.5
  }
  while (remaining > 100) {
    filters.push('atempo=100')
    remaining /= 100
  }
  filters.push(`atempo=${num(remaining)}`)
  return filters
}

export function isDefaultColor(color: ColorAdjust): boolean {
  return (
    Math.abs(color.brightness) < EPSILON &&
    Math.abs(color.contrast - 1) < EPSILON &&
    Math.abs(color.saturation - 1) < EPSILON &&
    Math.abs(color.gamma - 1) < EPSILON
  )
}

function eqFilter(color: ColorAdjust): string {
  return `eq=brightness=${num(color.brightness)}:contrast=${num(color.contrast)}:saturation=${num(
    color.saturation
  )}:gamma=${num(color.gamma)}`
}

/** A clip cut down to the export range, with times relative to the range start. */
export interface RangeClip {
  clip: Clip
  start: number
  duration: number
  inPoint: number
  fadeIn: number
  /** Local time where the fade out begins, or null for none. */
  fadeOutStart: number | null
  fadeOut: number
}

export function clipToRange(clip: Clip, rangeStart: number, rangeEnd: number): RangeClip | null {
  const clipEnd = clip.start + clip.duration
  if (clipEnd <= rangeStart + EPSILON || clip.start >= rangeEnd - EPSILON) return null

  const head = Math.max(0, rangeStart - clip.start)
  const tail = Math.max(0, clipEnd - rangeEnd)
  const duration = clip.duration - head - tail
  if (duration <= EPSILON) return null

  const fadeOutStart = clip.fadeOut > 0 ? clip.duration - clip.fadeOut - head : null
  return {
    clip,
    start: clip.start + head - rangeStart,
    duration,
    inPoint: clip.inPoint + head * clip.speed,
    fadeIn: Math.max(0, clip.fadeIn - head),
    fadeOutStart: fadeOutStart !== null && fadeOutStart < duration ? Math.max(0, fadeOutStart) : null,
    fadeOut: clip.fadeOut
  }
}

class Graph {
  private statements: string[] = []
  private count = 0

  label(prefix: string): string {
    return `[${prefix}${this.count++}]`
  }

  add(inputs: string | string[], filters: string[], outputs?: string | string[]): string {
    const ins = Array.isArray(inputs) ? inputs.join('') : inputs
    const outs = outputs ?? this.label('n')
    const outText = Array.isArray(outs) ? outs.join('') : outs
    this.statements.push(`${ins}${filters.join(',')}${outText}`)
    return Array.isArray(outs) ? outs[0] : outs
  }

  toString(): string {
    return this.statements.join(';\n')
  }
}

function videoCodecArgs(settings: ExportSettings): string[] {
  const q = settings.quality
  switch (settings.format) {
    case 'mp4-h264':
      return [
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        q === 'high' ? '18' : q === 'standard' ? '21' : '26',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-movflags',
        '+faststart'
      ]
    case 'mp4-h265':
      return [
        '-c:v',
        'libx265',
        '-preset',
        'medium',
        '-crf',
        q === 'high' ? '20' : q === 'standard' ? '24' : '28',
        '-pix_fmt',
        'yuv420p',
        '-tag:v',
        'hvc1',
        '-movflags',
        '+faststart'
      ]
    case 'webm-vp9':
      return [
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        q === 'high' ? '24' : q === 'standard' ? '31' : '38',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '2',
        '-pix_fmt',
        'yuv420p'
      ]
    case 'mov-prores':
      return [
        '-c:v',
        'prores_ks',
        '-profile:v',
        q === 'high' ? '3' : q === 'standard' ? '2' : '1',
        '-pix_fmt',
        'yuv422p10le',
        '-vendor',
        'apl0'
      ]
    case 'gif':
      return ['-loop', '0']
    default:
      return []
  }
}

function audioCodecArgs(settings: ExportSettings): string[] {
  const bitrate = `${Math.round(settings.audioBitrate)}k`
  switch (settings.format) {
    case 'mp4-h264':
    case 'mp4-h265':
      return ['-c:a', 'aac', '-b:a', bitrate]
    case 'webm-vp9':
      return ['-c:a', 'libopus', '-b:a', bitrate]
    case 'mov-prores':
    case 'wav':
      return ['-c:a', 'pcm_s16le']
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', bitrate]
    default:
      return []
  }
}

function hasVideoOutput(settings: ExportSettings): boolean {
  return settings.format !== 'mp3' && settings.format !== 'wav'
}

function hasAudioOutput(settings: ExportSettings): boolean {
  return settings.format !== 'gif'
}

export function buildRenderPlan(job: RenderJob): RenderPlan {
  const { project, settings, overlays } = job
  const { width: projectWidth, height: projectHeight } = project.settings
  const outWidth = even(settings.width)
  const outHeight = even(settings.height)
  const fps = settings.fps
  const total = Math.max(settings.end - settings.start, 1 / fps)
  const k = outWidth / projectWidth
  const media = new Map<string, MediaItem>(project.media.map((m) => [m.id, m]))

  const graph = new Graph()
  const inputs: string[][] = []
  const addInput = (args: string[]): number => {
    inputs.push(args)
    return inputs.length - 1
  }

  const wantVideo = hasVideoOutput(settings)
  const wantAudio = hasAudioOutput(settings)

  let videoOut: string | null = null
  if (wantVideo) {
    let current = graph.add(
      '',
      [
        `color=c=${ffColor(project.settings.background)}:s=${outWidth}x${outHeight}:r=${num(fps)}:d=${num(total)}`
      ],
      graph.label('base')
    )

    const videoTracks = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
    for (const track of videoTracks) {
      const clips = project.clips
        .filter((c) => c.trackId === track.id && c.kind !== 'audio')
        .sort((a, b) => a.start - b.start)

      for (const clip of clips) {
        const ranged = clipToRange(clip, settings.start, settings.end)
        if (!ranged) continue

        let source: { input: string; width: number; height: number; alpha: boolean } | null = null

        if (clip.kind === 'video' || clip.kind === 'image') {
          const item = clip.mediaId ? media.get(clip.mediaId) : undefined
          if (!item || !item.hasVideo) continue
          if (clip.kind === 'video') {
            const index = addInput([
              '-ss',
              num(ranged.inPoint),
              '-t',
              num(ranged.duration * clip.speed),
              // FFmpeg's built-in VP8/VP9 decoders drop the alpha channel; libvpx keeps it.
              ...(item.alpha ? ['-c:v', item.videoCodec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : []),
              '-i',
              item.path
            ])
            source = {
              input: `[${index}:v]`,
              width: item.width,
              height: item.height,
              alpha: Boolean(item.alpha)
            }
          } else {
            const index = addInput([
              '-loop',
              '1',
              '-framerate',
              num(fps),
              '-t',
              num(ranged.duration),
              '-i',
              item.path
            ])
            source = { input: `[${index}:v]`, width: item.width, height: item.height, alpha: true }
          }
        } else if (clip.kind === 'text') {
          const overlay = overlays[clip.id]
          if (!overlay) continue
          const index = addInput([
            '-loop',
            '1',
            '-framerate',
            num(fps),
            '-t',
            num(ranged.duration),
            '-i',
            overlay.path
          ])
          source = { input: `[${index}:v]`, width: overlay.width, height: overlay.height, alpha: true }
        } else if (clip.kind === 'solid') {
          const label = graph.add(
            '',
            [
              `color=c=${ffColor(clip.solidColor ?? '#000000')}:s=${projectWidth}x${projectHeight}:r=${num(
                fps
              )}:d=${num(ranged.duration)}`
            ],
            graph.label('solid')
          )
          source = { input: label, width: projectWidth, height: projectHeight, alpha: false }
        }

        if (!source) continue

        const layer = computeLayer(
          clip.transform,
          source.width,
          source.height,
          projectWidth,
          projectHeight,
          fitsToFrame(clip.kind)
        )
        const t = clip.transform
        const scaledWidth = Math.max(2, Math.round(layer.width * k))
        const scaledHeight = Math.max(2, Math.round(layer.height * k))

        const head: string[] = []
        if (clip.kind === 'video' && Math.abs(clip.speed - 1) > EPSILON) {
          head.push(`setpts=(PTS-STARTPTS)/${num(clip.speed)}`)
        } else {
          head.push('setpts=PTS-STARTPTS')
        }
        head.push(`fps=${num(fps)}`)
        if (t.flipH) head.push('hflip')
        if (t.flipV) head.push('vflip')
        const cropW = 1 - t.cropLeft - t.cropRight
        const cropH = 1 - t.cropTop - t.cropBottom
        if (cropW < 1 - EPSILON || cropH < 1 - EPSILON) {
          head.push(`crop=iw*${num(cropW)}:ih*${num(cropH)}:iw*${num(t.cropLeft)}:ih*${num(t.cropTop)}`)
        }
        head.push(`scale=${scaledWidth}:${scaledHeight}:flags=bicubic`)

        const colorize = clip.kind !== 'text' && clip.kind !== 'solid' && !isDefaultColor(clip.color)
        let stream: string
        if (colorize && source.alpha) {
          // eq only works on YUV without alpha, so grade the color planes and merge the alpha back.
          const colorLabel = graph.label('c')
          const alphaLabel = graph.label('a')
          graph.add(source.input, [...head, 'format=rgba', 'split=2'], [colorLabel, alphaLabel])
          const alpha = graph.add(alphaLabel, ['alphaextract'])
          const graded = graph.add(colorLabel, [eqFilter(clip.color)])
          stream = graph.add([graded, alpha], ['alphamerge'])
        } else {
          const filters = [...head]
          if (colorize) filters.push(eqFilter(clip.color))
          stream = graph.add(source.input, filters)
        }

        const tail: string[] = ['format=rgba']
        if (Math.abs(t.rotation) > EPSILON) {
          const rad = num((t.rotation * Math.PI) / 180, 8)
          tail.push(`rotate=a=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none`)
        }
        if (t.opacity < 1 - EPSILON) tail.push(`colorchannelmixer=aa=${num(Math.max(0, t.opacity))}`)
        if (ranged.fadeIn > EPSILON) tail.push(`fade=t=in:st=0:d=${num(ranged.fadeIn)}:alpha=1`)
        if (ranged.fadeOutStart !== null) {
          tail.push(`fade=t=out:st=${num(ranged.fadeOutStart)}:d=${num(ranged.fadeOut)}:alpha=1`)
        }
        tail.push(`setpts=PTS+${num(ranged.start)}/TB`)
        const prepared = graph.add(stream, tail)

        const cx = layer.cx * k
        const cy = layer.cy * k
        const end = ranged.start + ranged.duration
        current = graph.add(
          [current, prepared],
          [
            `overlay=x=${num(cx, 3)}-overlay_w/2:y=${num(cy, 3)}-overlay_h/2:eof_action=pass:enable='between(t,${num(
              ranged.start
            )},${num(end)})'`
          ],
          graph.label('v')
        )
      }
    }

    if (settings.format === 'gif') {
      const a = graph.label('g')
      const b = graph.label('g')
      graph.add(current, ['split=2'], [a, b])
      const palette = graph.add(a, ['palettegen=stats_mode=diff'])
      videoOut = graph.add([b, palette], ['paletteuse=dither=bayer:bayer_scale=4'], '[vout]')
    } else {
      videoOut = graph.add(current, ['null'], '[vout]')
    }
  }

  let audioOut: string | null = null
  if (wantAudio) {
    const audioTracks = project.tracks.filter((t) => t.kind === 'audio' && !t.muted)
    const streams: string[] = []
    for (const track of audioTracks) {
      for (const clip of project.clips.filter((c) => c.trackId === track.id && c.kind === 'audio')) {
        const item = clip.mediaId ? media.get(clip.mediaId) : undefined
        if (!item || !item.hasAudio || clip.volume <= 0) continue
        const ranged = clipToRange(clip, settings.start, settings.end)
        if (!ranged) continue

        const index = addInput([
          '-ss',
          num(ranged.inPoint),
          '-t',
          num(ranged.duration * clip.speed),
          '-i',
          item.path
        ])
        const filters = [
          'asetpts=PTS-STARTPTS',
          `aresample=${SAMPLE_RATE}`,
          `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`,
          ...atempoChain(clip.speed)
        ]
        if (Math.abs(clip.volume - 1) > EPSILON) filters.push(`volume=${num(clip.volume)}`)
        if (ranged.fadeIn > EPSILON) filters.push(`afade=t=in:st=0:d=${num(ranged.fadeIn)}`)
        if (ranged.fadeOutStart !== null) {
          filters.push(`afade=t=out:st=${num(ranged.fadeOutStart)}:d=${num(ranged.fadeOut)}`)
        }
        const delay = Math.round(ranged.start * 1000)
        if (delay > 0) filters.push(`adelay=${delay}:all=1`)
        streams.push(graph.add(`[${index}:a]`, filters))
      }
    }

    if (streams.length === 0) {
      audioOut = graph.add(
        '',
        [`anullsrc=r=${SAMPLE_RATE}:cl=stereo`, `atrim=duration=${num(total)}`],
        '[aout]'
      )
    } else {
      const mixed =
        streams.length === 1
          ? streams[0]
          : graph.add(streams, [
              `amix=inputs=${streams.length}:duration=longest:dropout_transition=0:normalize=0`
            ])
      audioOut = graph.add(mixed, [`apad=whole_dur=${num(total)}`, `atrim=duration=${num(total)}`], '[aout]')
    }
  }

  const outputArgs: string[] = []
  if (videoOut) outputArgs.push('-map', videoOut, ...videoCodecArgs(settings), '-r', num(fps))
  if (audioOut) outputArgs.push('-map', audioOut, ...audioCodecArgs(settings), '-ar', String(SAMPLE_RATE))
  outputArgs.push('-t', num(total), '-map_metadata', '-1')

  return { inputs, filterGraph: graph.toString(), outputArgs, duration: total }
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * Assembles the full argument list. The filter graph is passed through a script file so large
 * projects do not hit command line length limits on Windows.
 */
export function planToArgs(
  plan: RenderPlan,
  filterScriptPath: string,
  outputPath: string,
  ffmpegMajorVersion: number | null
): string[] {
  const scriptArgs =
    ffmpegMajorVersion !== null && ffmpegMajorVersion >= 7
      ? ['-/filter_complex', filterScriptPath]
      : ['-filter_complex_script', filterScriptPath]
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-nostats',
    ...plan.inputs.flat(),
    ...scriptArgs,
    ...plan.outputArgs,
    '-y',
    outputPath
  ]
}
