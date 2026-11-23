import { clampCrop, layerCorners } from '@shared/geometry'
import { clamp, snapToFrame } from '@shared/time'
import type { Clip, MediaItem, Project } from '@shared/types'
import { useEditor, type EditorState } from '../store/editor'
import { fadeFactor, projectDuration, sourceTime } from '../lib/timeline'
import { mediaUrl, previewPath } from '../lib/media'
import { defaultColor } from '../lib/factory'
import { Compositor, hexToRgb, type LayerRenderer } from './compositor'
import { CanvasCompositor } from './canvas-compositor'
import { onFontLoaded, rasterizeText } from './text'
import { clipLayer } from './layers'
import { layerFx } from './fx'
import { clipShake, temperatureGains } from '@shared/effects'

interface MediaEntry {
  kind: 'video' | 'audio' | 'image'
  src: string
  el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement
  source: MediaElementAudioSourceNode | null
  gain: GainNode | null
  loaded: boolean
  uploaded: string | null
}

const NEUTRAL = defaultColor()
const NO_GAIN: [number, number, number] = [1, 1, 1]
const LOOKAHEAD_PLAYING = 2.5
const LOOKAHEAD_PAUSED = 0.75
const DRIFT_LIMIT = 0.2

/**
 * Drives the program monitor. Media elements are created for clips near the playhead, kept in sync
 * with a master clock, and composited through WebGL every frame while playing.
 */
class Player {
  private compositor: LayerRenderer | null = null
  private canvas: HTMLCanvasElement | null = null
  private entries = new Map<string, MediaEntry>()
  /** Canvas pixels per project pixel in the last render. */
  private pixelScale = 1
  private audio: AudioContext | null = null
  private master: GainNode | null = null
  private analysers: AnalyserNode[] = []
  private levelBuffer = new Float32Array(2048)
  private raf = 0
  private dirty = true
  private rate = 1
  private clockStart = 0
  private clockOrigin = 0
  private ownPlayhead = -1
  private textKeys = new Map<string, string>()
  private mediaIndex = new WeakMap<Project, Map<string, MediaItem>>()
  private unsubscribe: (() => void) | null = null
  error: string | null = null

  attach(canvas: HTMLCanvasElement): void {
    this.detach()
    this.compositor = this.createRenderer(canvas)
    onFontLoaded(() => this.invalidate())
    this.unsubscribe = useEditor.subscribe((state, prev) => this.onStoreChange(state, prev))
    this.dirty = true
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Prefers WebGL 2 and falls back to a 2D canvas, so playback works even without GPU support. */
  private createRenderer(canvas: HTMLCanvasElement): LayerRenderer | null {
    this.error = null
    try {
      this.canvas = canvas
      return new Compositor(canvas)
    } catch (err) {
      console.info('WebGL 2 preview unavailable, using the 2D canvas renderer.', err)
    }
    let target = canvas
    if (canvas.getContext('2d') === null) {
      // The canvas is already bound to a WebGL context, so swap in a fresh element.
      target = document.createElement('canvas')
      target.className = canvas.className
      canvas.replaceWith(target)
    }
    try {
      this.canvas = target
      return new CanvasCompositor(target)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  get backend(): 'webgl' | 'canvas' | null {
    return this.compositor?.backend ?? null
  }

  detach(): void {
    cancelAnimationFrame(this.raf)
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const id of [...this.entries.keys()]) this.release(id)
    this.compositor?.destroy()
    this.compositor = null
  }

  invalidate(): void {
    this.dirty = true
  }

  get playing(): boolean {
    return useEditor.getState().playing
  }

  get playbackRate(): number {
    return this.rate
  }

  private onStoreChange(state: EditorState, prev: EditorState): void {
    if (state.playhead !== prev.playhead && state.playhead !== this.ownPlayhead) {
      if (state.playing) {
        this.clockOrigin = state.playhead
        this.clockStart = performance.now()
      }
      this.dirty = true
    }
    if (
      state.project !== prev.project ||
      state.previewScale !== prev.previewScale ||
      state.proxies !== prev.proxies ||
      state.offline !== prev.offline
    ) {
      this.dirty = true
    }
    if (prev.playing && !state.playing) this.pauseElements()
  }

  private range(state: EditorState): [number, number] {
    const project = state.project!
    const end = projectDuration(project)
    if (
      state.loop &&
      project.inPoint !== null &&
      project.outPoint !== null &&
      project.outPoint > project.inPoint
    ) {
      return [project.inPoint, project.outPoint]
    }
    return [0, end]
  }

  play(rate = 1): void {
    const state = useEditor.getState()
    if (!state.project) return
    const [start, end] = this.range(state)
    let t = state.playhead
    if (rate > 0 && (t >= end - 1e-3 || (state.loop && t < start))) t = start
    if (end <= 0) return

    this.ensureAudio()
    void this.audio?.resume()
    this.rate = rate
    this.clockOrigin = t
    this.clockStart = performance.now()
    this.ownPlayhead = t
    useEditor.setState({ playing: true, playhead: t })
  }

  pause(): void {
    const state = useEditor.getState()
    this.rate = 1
    if (!state.playing) return
    const fps = state.project?.settings.fps ?? 30
    const t = snapToFrame(state.playhead, fps)
    this.ownPlayhead = t
    useEditor.setState({ playing: false, playhead: t })
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play(1)
  }

  /** J/K/L style shuttle. Pressing the same direction again doubles the speed. */
  shuttle(direction: -1 | 1): void {
    if (!this.playing) {
      this.play(direction)
      return
    }
    if (Math.sign(this.rate) === direction) {
      const next = clamp(Math.abs(this.rate) * 2, 1, 8) * direction
      this.clockOrigin = useEditor.getState().playhead
      this.clockStart = performance.now()
      this.rate = next
    } else {
      this.play(direction)
    }
  }

  levels(): [number, number] {
    if (this.analysers.length < 2 || !this.playing) return [0, 0]
    const out: [number, number] = [0, 0]
    this.analysers.forEach((analyser, i) => {
      analyser.getFloatTimeDomainData(this.levelBuffer)
      let peak = 0
      for (let j = 0; j < this.levelBuffer.length; j++) {
        const v = Math.abs(this.levelBuffer[j])
        if (v > peak) peak = v
      }
      out[i] = peak
    })
    return out
  }

  private ensureAudio(): void {
    if (this.audio) return
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const master = ctx.createGain()
    master.channelCount = 2
    master.channelCountMode = 'explicit'
    master.channelInterpretation = 'speakers'
    const splitter = ctx.createChannelSplitter(2)
    master.connect(ctx.destination)
    master.connect(splitter)
    this.analysers = [0, 1].map((channel) => {
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      splitter.connect(analyser, channel)
      return analyser
    })
    this.audio = ctx
    this.master = master
  }

  private mediaMap(project: Project): Map<string, MediaItem> {
    let map = this.mediaIndex.get(project)
    if (!map) {
      map = new Map(project.media.map((m) => [m.id, m]))
      this.mediaIndex.set(project, map)
    }
    return map
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick)
    const state = useEditor.getState()
    const project = state.project
    if (!project) return

    let t = state.playhead
    if (state.playing) {
      t = this.clockOrigin + ((performance.now() - this.clockStart) / 1000) * this.rate
      const [start, end] = this.range(state)
      if (this.rate > 0 && t >= end) {
        if (state.loop && end > start) {
          t = start
          this.clockOrigin = start
          this.clockStart = performance.now()
          this.restartElements()
        } else {
          t = end
          this.rate = 1
          this.ownPlayhead = t
          useEditor.setState({ playing: false, playhead: t })
        }
      } else if (this.rate < 0 && t <= 0) {
        t = 0
        this.rate = 1
        this.ownPlayhead = 0
        useEditor.setState({ playing: false, playhead: 0 })
      }
      if (useEditor.getState().playing) {
        this.ownPlayhead = t
        useEditor.setState({ playhead: t })
      }
    }

    const current = useEditor.getState()
    this.sync(project, t, current)
    if (this.compositor && (current.playing || this.dirty)) {
      this.dirty = false
      this.render(project, t, current)
    }
  }

  /** Pauses media so the next sync re-seeks it, used when looping back to the start. */
  private restartElements(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'image') (entry.el as HTMLMediaElement).pause()
    }
  }

  private pauseElements(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === 'image') continue
      ;(entry.el as HTMLMediaElement).pause()
      if (entry.gain && this.audio) entry.gain.gain.setTargetAtTime(0, this.audio.currentTime, 0.01)
    }
    this.dirty = true
  }

  private ensure(clip: Clip, media: MediaItem): MediaEntry {
    const src = mediaUrl(previewPath(media))
    const existing = this.entries.get(clip.id)
    if (existing && existing.src === src && existing.kind === clip.kind) return existing
    if (existing) this.release(clip.id)

    const markDirty = () => {
      entry.loaded = true
      this.dirty = true
    }
    let entry: MediaEntry
    if (clip.kind === 'image') {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = markDirty
      img.src = src
      entry = { kind: 'image', src, el: img, source: null, gain: null, loaded: false, uploaded: null }
    } else if (clip.kind === 'video') {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.preload = 'auto'
      video.playsInline = true
      video.addEventListener('loadeddata', markDirty)
      video.addEventListener('seeked', markDirty)
      video.src = src
      entry = { kind: 'video', src, el: video, source: null, gain: null, loaded: false, uploaded: null }
    } else {
      this.ensureAudio()
      const audio = new Audio()
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      audio.src = src
      const source = this.audio!.createMediaElementSource(audio)
      const gain = this.audio!.createGain()
      gain.gain.value = 0
      source.connect(gain).connect(this.master!)
      entry = { kind: 'audio', src, el: audio, source, gain, loaded: false, uploaded: null }
    }
    this.entries.set(clip.id, entry)
    return entry
  }

  private release(clipId: string): void {
    const entry = this.entries.get(clipId)
    if (!entry) return
    this.entries.delete(clipId)
    if (entry.kind !== 'image') {
      const el = entry.el as HTMLMediaElement
      el.pause()
      el.removeAttribute('src')
      el.load()
    } else {
      ;(entry.el as HTMLImageElement).src = ''
    }
    entry.source?.disconnect()
    entry.gain?.disconnect()
  }

  private sync(project: Project, t: number, state: EditorState): void {
    const forward = state.playing && this.rate > 0
    const lookahead = state.playing ? LOOKAHEAD_PLAYING : LOOKAHEAD_PAUSED
    const fps = project.settings.fps
    const media = this.mediaMap(project)
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]))
    const needed = new Set<string>()

    for (const clip of project.clips) {
      if (clip.kind === 'text' || clip.kind === 'solid' || !clip.mediaId) continue
      const track = tracks.get(clip.trackId)
      if (!track || (clip.kind === 'audio' ? track.muted : track.hidden)) continue
      const end = clip.start + clip.duration
      if (end < t - 0.25 || clip.start > t + lookahead) continue
      const item = media.get(clip.mediaId)
      if (!item || state.offline[item.id]) continue

      needed.add(clip.id)
      const entry = this.ensure(clip, item)
      if (entry.kind === 'image') continue

      const el = entry.el as HTMLMediaElement
      const active = t >= clip.start && t < end
      const target = clamp(sourceTime(clip, t), 0, Math.max(0, item.duration - 0.001))

      if (active && forward) {
        const rate = clip.speed * this.rate
        if (el.playbackRate !== rate) el.playbackRate = rate
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target
          void el.play().catch(() => undefined)
        } else if (Math.abs(el.currentTime - target) > DRIFT_LIMIT * Math.max(1, rate)) {
          el.currentTime = target
        }
      } else {
        if (!el.paused) el.pause()
        const want = active ? target : clip.start > t ? clip.inPoint : null
        if (want !== null && !el.seeking && Math.abs(el.currentTime - want) > 0.5 / fps) {
          el.currentTime = want
        }
      }

      if (entry.gain && this.audio) {
        const level = active && forward ? clip.volume * fadeFactor(clip, t) : 0
        entry.gain.gain.setTargetAtTime(level, this.audio.currentTime, 0.012)
      }
    }

    for (const id of [...this.entries.keys()]) if (!needed.has(id)) this.release(id)
  }

  /**
   * Renders the frame at the playhead once every visible video has seeked to it, and returns it as
   * a base64 JPEG no wider than maxWidth. Used when an assistant asks to see the timeline.
   */
  async capture(maxWidth = 960): Promise<string> {
    const project = useEditor.getState().project
    if (!project || !this.compositor || !this.canvas) throw new Error('The preview is not available.')
    const t = useEditor.getState().playhead
    const deadline = performance.now() + 6000
    while (performance.now() < deadline) {
      this.sync(project, t, useEditor.getState())
      if (this.settled(project, t)) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    this.render(project, t, useEditor.getState(), Math.min(1, maxWidth / project.settings.width))
    const copy = document.createElement('canvas')
    copy.width = this.canvas.width
    copy.height = this.canvas.height
    copy.getContext('2d')!.drawImage(this.canvas, 0, 0)
    this.dirty = true
    return copy.toDataURL('image/jpeg', 0.86).split(',')[1]
  }

  private settled(project: Project, t: number): boolean {
    const fps = project.settings.fps
    for (const clip of project.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'image') continue
      if (t < clip.start || t >= clip.start + clip.duration) continue
      const track = project.tracks.find((tr) => tr.id === clip.trackId)
      if (!track || track.hidden || (clip.mediaId && useEditor.getState().offline[clip.mediaId])) continue
      const entry = this.entries.get(clip.id)
      if (!entry || !entry.loaded) return false
      if (entry.kind !== 'video') continue
      const video = entry.el as HTMLVideoElement
      if (video.readyState < 2 || video.seeking) return false
      if (Math.abs(video.currentTime - sourceTime(clip, t)) > 1.5 / fps) return false
    }
    return true
  }

  private render(project: Project, t: number, state: EditorState, scaleOverride?: number): void {
    const compositor = this.compositor!
    const { width, height, background } = project.settings
    const scale = scaleOverride ?? clamp(state.previewScale, 0.25, 1)
    compositor.resize(Math.round(width * scale), Math.round(height * scale), width, height)
    this.pixelScale = Math.round(width * scale) / width
    compositor.begin(background)

    const media = this.mediaMap(project)
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue
      for (const clip of project.clips) {
        if (clip.trackId !== track.id || clip.kind === 'audio') continue
        if (t < clip.start || t >= clip.start + clip.duration) continue
        this.drawClip(project, clip, t, clip.mediaId ? media.get(clip.mediaId) : undefined)
      }
    }
    compositor.end()
  }

  private drawClip(project: Project, clip: Clip, t: number, item: MediaItem | undefined): void {
    const compositor = this.compositor!
    let key = clip.id
    let source: TexImageSource | null = null
    let upload = false
    let solid: [number, number, number] | undefined

    if (clip.kind === 'video') {
      const entry = this.entries.get(clip.id)
      if (!entry) return
      const video = entry.el as HTMLVideoElement
      if (video.readyState >= 2) {
        source = video
        upload = true
      }
    } else if (clip.kind === 'image') {
      const entry = this.entries.get(clip.id)
      if (!entry || !entry.loaded) return
      source = entry.el as HTMLImageElement
      upload = !compositor.hasTexture(key) || entry.uploaded !== entry.src
      entry.uploaded = entry.src
    } else if (clip.kind === 'text' && clip.text) {
      const raster = rasterizeText(clip.text)
      key = `text:${clip.id}`
      source = raster.canvas
      upload = !compositor.hasTexture(key) || this.textKeys.get(clip.id) !== raster.key
      this.textKeys.set(clip.id, raster.key)
    } else if (clip.kind === 'solid') {
      solid = hexToRgb(clip.solidColor ?? '#000000')
    } else {
      return
    }

    const [sx, sy] = clipShake(clip, t - clip.start)
    const base = clipLayer(project, clip, item)
    const layer = sx || sy ? { ...base, cx: base.cx + sx, cy: base.cy + sy } : base
    const built = layerFx(clip, layer, this.pixelScale, Math.floor((t - clip.start) * project.settings.fps))
    // A shadow pads the finished layer on every side.
    const pad = built ? built.pad / this.pixelScale : 0
    const tr = clip.transform
    const [cl, cr] = clampCrop(tr.cropLeft, tr.cropRight)
    const [ct, cb] = clampCrop(tr.cropTop, tr.cropBottom)
    let u0 = cl
    let u1 = 1 - cr
    let v0 = ct
    let v1 = 1 - cb
    if (tr.flipH) [u0, u1] = [1 - u0, 1 - u1]
    if (tr.flipV) [v0, v1] = [1 - v0, 1 - v1]
    const graded = clip.kind === 'video' || clip.kind === 'image'

    compositor.draw({
      key,
      source,
      upload,
      solid,
      corners: layerCorners(
        pad ? { ...layer, width: layer.width + 2 * pad, height: layer.height + 2 * pad } : layer
      ),
      uv: [u0, v0, u1, v1],
      color: graded ? clip.color : NEUTRAL,
      gain: graded ? temperatureGains(clip.color.temperature ?? 0, clip.color.tint ?? 0) : NO_GAIN,
      opacity: tr.opacity * fadeFactor(clip, t),
      fx: built?.fx
    })
  }
}

export const player = new Player()
