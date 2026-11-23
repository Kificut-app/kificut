import { computeLayer, fitsToFrame, type LayerRect } from './geometry'
import type { ExportSettings } from './export-formats'
import type { Clip, ColorAdjust, MediaItem, Project } from './types'
import {
  activeEffects,
  colorMatrix,
  effectColor,
  effectNumber,
  fxImageKey,
  grainStrength,
  pixelateCells,
  rgbSplitOffset,
  screenType,
  shadowLayout,
  shakeExpressions,
  temperatureGains,
  type ClipShadow,
  type Effect
} from './effects'

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

/** Whether the brightness, contrast, saturation and gamma part needs FFmpeg's eq filter. */
function needsEq(color: ColorAdjust): boolean {
  return (
    Math.abs(color.brightness) >= EPSILON ||
    Math.abs(color.contrast - 1) >= EPSILON ||
    Math.abs(color.saturation - 1) >= EPSILON ||
    Math.abs(color.gamma - 1) >= EPSILON
  )
}

export function isDefaultColor(color: ColorAdjust): boolean {
  return !needsEq(color) && Math.abs(color.temperature ?? 0) < EPSILON && Math.abs(color.tint ?? 0) < EPSILON
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

/** Export pixels per project pixel. */
export function exportScale(project: Project, settings: ExportSettings): number {
  return even(settings.width) / project.settings.width
}

/** Size in export pixels a layer is scaled to before its effects, mask and rotation. */
export function exportLayerSize(layer: LayerRect, k: number): [number, number] {
  return [Math.max(2, Math.round(layer.width * k)), Math.max(2, Math.round(layer.height * k))]
}

/**
 * The filters of one visual clip. Filters that keep transparency are collected into one statement;
 * the rest run on the color planes with the alpha split off and merged back, as eq needs.
 */
class ClipChain {
  private pending: string[]

  constructor(
    private graph: Graph,
    private stream: string,
    head: string[],
    private alpha: boolean
  ) {
    this.pending = [...head]
  }

  add(filters: string[]): void {
    this.pending.push(...filters)
  }

  /** Marks the stream as having transparency from here on (after a key or a mask). */
  hasAlpha(): void {
    this.alpha = true
  }

  alphaUnsafe(filters: string[]): void {
    if (!this.alpha) return this.add(filters)
    const color = this.graph.label('c')
    const alpha = this.graph.label('a')
    this.graph.add(this.stream, [...this.pending, 'format=rgba', 'split=2'], [color, alpha])
    this.pending = []
    const extracted = this.graph.add(alpha, ['alphaextract'])
    const graded = this.graph.add(color, filters)
    this.stream = this.graph.add([graded, extracted], ['alphamerge'])
  }

  /** Ends the current statement and returns its output label. */
  flush(extra: string[] = []): string {
    if (this.pending.length || extra.length) {
      this.stream = this.graph.add(this.stream, [...this.pending, ...extra])
      this.pending = []
    }
    return this.stream
  }

  /** Blends an image of the same size on top, in planar RGB with alpha. */
  blend(image: string, modes: string): void {
    const base = this.flush(['format=gbrap'])
    this.stream = this.graph.add([base, image], [`blend=${modes}`])
    if (modes.includes('c3_mode')) this.alpha = true
  }

  overlay(image: string): void {
    const base = this.flush(['format=rgba'])
    this.stream = this.graph.add([base, image], ['overlay=0:0:format=auto'])
  }

  /** Runs `branch` on a copy of the stream and blends the result with the original using `modes`. */
  splitBlend(branch: string[], modes: string): void {
    const a = this.graph.label('s')
    const b = this.graph.label('s')
    this.graph.add(this.stream, [...this.pending, 'format=gbrap', 'split=2'], [a, b])
    this.pending = []
    const processed = this.graph.add(b, [...branch, 'format=gbrap'])
    this.stream = this.graph.add([a, processed], [`blend=${modes}`])
  }

  /** Pads the layer and puts a soft, offset copy of its alpha in the shadow color underneath. */
  shadow(
    shadow: ClipShadow,
    layout: { pad: number; sigma: number; offset: [number, number] },
    size: { width: number; height: number; fps: number; duration: number }
  ): void {
    const { pad, sigma, offset } = layout
    const w = size.width + 2 * pad
    const h = size.height + 2 * pad
    const layer = this.graph.label('l')
    const copy = this.graph.label('l')
    this.graph.add(this.stream, [...this.pending, 'format=rgba', 'split=2'], [layer, copy])
    this.pending = []
    const padded = this.graph.add(layer, [`pad=${w}:${h}:${pad}:${pad}:color=black@0`])
    const alphaFilters = [`pad=${w}:${h}:${pad + offset[0]}:${pad + offset[1]}:color=black@0`, 'alphaextract']
    if (sigma > 0.3) alphaFilters.push(`gblur=sigma=${num(sigma)}:steps=4`)
    const alpha = this.graph.add(copy, alphaFilters)
    const fill = this.graph.add('', [
      `color=c=${ffColor(shadow.color)}:s=${w}x${h}:r=${num(size.fps)}:d=${num(size.duration)}`
    ])
    const tinted = this.graph.add(
      [fill, alpha],
      ['alphamerge', `colorchannelmixer=aa=${num(shadow.opacity)}`]
    )
    this.stream = this.graph.add([tinted, padded], ['overlay=0:0:format=auto'])
    this.alpha = true
  }

  finish(): string {
    return this.flush()
  }
}

/** Adds one effect's filters. Sizes are in export pixels (`k` per project pixel). */
function addEffect(
  chain: ClipChain,
  effect: Effect,
  ctx: { k: number; width: number; height: number; vignette: () => string | null }
): void {
  const n = (key: string) => effectNumber(effect, key)
  switch (effect.type) {
    case 'blur': {
      const sigma = (n('amount') * ctx.k) / 2
      if (sigma > 0.3) chain.add([`gblur=sigma=${num(sigma)}:steps=4`])
      return
    }
    case 'sharpen':
      chain.alphaUnsafe([`unsharp=lx=5:ly=5:la=${num(n('amount'))}:cx=5:cy=5:ca=0`])
      return
    case 'pixelate': {
      const [cols, rows] = pixelateCells(ctx.width, ctx.height, n('size') * ctx.k)
      chain.add([`scale=${cols}:${rows}:flags=area`, `scale=${ctx.width}:${ctx.height}:flags=neighbor`])
      return
    }
    case 'glow': {
      const low = Math.min(254, Math.round(n('threshold') * 255))
      const gain = num(255 / (255 - low))
      const lut = `'clip((val-${low})*${gain},0,255)'`
      const sigma = (n('radius') * ctx.k) / 2
      const branch = ['format=rgba', `lutrgb=r=${lut}:g=${lut}:b=${lut}`]
      if (sigma > 0.3) branch.push(`gblur=sigma=${num(sigma)}:steps=4`)
      // Screen keeps the picture and adds the blurred highlights on top, by the intensity.
      chain.splitBlend(branch, `all_mode=screen:all_opacity=${num(n('intensity'))}`)
      return
    }
    case 'vignette': {
      const image = ctx.vignette()
      if (image) chain.blend(image, 'c0_mode=multiply:c1_mode=multiply:c2_mode=multiply')
      return
    }
    case 'grain':
      chain.add([`noise=c0s=${grainStrength(effect)}:c0f=t`])
      return
    case 'rgbSplit': {
      const [dx, dy] = rgbSplitOffset(effect, ctx.k)
      if (dx || dy) chain.add([`rgbashift=rh=${dx}:rv=${dy}:bh=${-dx}:bv=${-dy}:edge=smear`])
      return
    }
    case 'blackWhite':
    case 'sepia':
    case 'hue': {
      const m = colorMatrix(effect)!
      const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb']
      chain.add([`colorchannelmixer=${names.map((name, i) => `${name}=${num(m[i])}`).join(':')}`])
      return
    }
    case 'invert': {
      const lut = `'val+(255-2*val)*${num(n('amount'))}'`
      chain.add([`lutrgb=r=${lut}:g=${lut}:b=${lut}`])
      return
    }
    case 'chromaKey': {
      const color = effectColor(effect, 'color')
      chain.add([
        `chromakey=color=${ffColor(color)}:similarity=${num(n('similarity'))}:blend=${num(n('smoothness'))}`
      ])
      chain.hasAlpha()
      const spill = n('spill')
      if (spill > EPSILON) {
        const type = screenType(color)
        const scales = type === 'green' ? `green=${num(-spill)}` : `green=0:blue=${num(-spill)}`
        chain.add([`despill=type=${type}:mix=0.5:expand=0:${scales}`])
      }
      return
    }
    case 'shake':
      return
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
        const [scaledWidth, scaledHeight] = exportLayerSize(layer, k)

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

        const chain = new ClipChain(graph, source.input, head, source.alpha)
        const image = (key: string): string | null => {
          const file = overlays[key]
          if (!file) return null
          const index = addInput([
            '-loop',
            '1',
            '-framerate',
            num(fps),
            '-t',
            num(ranged.duration),
            '-i',
            file.path
          ])
          return graph.add(`[${index}:v]`, [`scale=${scaledWidth}:${scaledHeight}`, 'format=gbrap'])
        }

        if (clip.kind === 'video' || clip.kind === 'image') {
          if (needsEq(clip.color)) chain.alphaUnsafe([eqFilter(clip.color)])
          const gains = temperatureGains(clip.color.temperature ?? 0, clip.color.tint ?? 0)
          if (gains.some((g) => Math.abs(g - 1) > EPSILON)) {
            chain.add([`colorchannelmixer=rr=${num(gains[0])}:gg=${num(gains[1])}:bb=${num(gains[2])}`])
          }
        }
        for (const effect of activeEffects(clip)) {
          addEffect(chain, effect, {
            k,
            width: scaledWidth,
            height: scaledHeight,
            vignette: () => image(fxImageKey.vignette(clip.id, effect.id))
          })
        }

        const mask = clip.mask ? image(fxImageKey.mask(clip.id)) : null
        if (mask) chain.blend(mask, 'c3_mode=multiply')
        const border = clip.border ? image(fxImageKey.border(clip.id)) : null
        if (border) chain.overlay(border)
        if (clip.shadow && clip.shadow.opacity > EPSILON) {
          chain.shadow(clip.shadow, shadowLayout(clip.shadow, k, t.rotation), {
            width: scaledWidth,
            height: scaledHeight,
            fps,
            duration: ranged.duration
          })
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
        chain.add(tail)
        const prepared = chain.finish()

        const cx = num(layer.cx * k, 3)
        const cy = num(layer.cy * k, 3)
        let x = `x=${cx}-overlay_w/2`
        let y = `y=${cy}-overlay_h/2`
        const shakes = activeEffects(clip).filter((e) => e.type === 'shake')
        if (shakes.length) {
          // Clip time: export time plus where the export starts, minus where the clip starts.
          const offset = settings.start - clip.start
          const local = `t${offset < 0 ? '-' : '+'}${num(Math.abs(offset))}`
          const parts = shakes.map((e) => shakeExpressions(e, local, k, (n) => num(n, 4)))
          x = `x='${cx}-overlay_w/2+${parts.map((p) => p[0]).join('+')}'`
          y = `y='${cy}-overlay_h/2+${parts.map((p) => p[1]).join('+')}'`
        }
        const end = ranged.start + ranged.duration
        current = graph.add(
          [current, prepared],
          [`overlay=${x}:${y}:eof_action=pass:enable='between(t,${num(ranged.start)},${num(end)})'`],
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
