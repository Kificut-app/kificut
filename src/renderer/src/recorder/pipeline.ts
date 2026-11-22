import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  type StreamTargetChunk,
  type VideoCodec
} from 'mediabunny'
import {
  AUDIO_BITRATE,
  areaToPixels,
  fitOutputSize,
  videoBitrate,
  type FilePlan,
  type PixelRect,
  type RecorderSession,
  type RecordingOptions
} from '@shared/recording'

/*
 * Captures and encodes a recording. Every source is read frame by frame with its capture time, all
 * of them are put on one clock (recording time, without pauses), and each planned file gets its own
 * MP4 that starts at the same instant. Video is written at a constant frame rate: for each output
 * frame the newest frame captured by then is used, so a still screen costs almost nothing and the
 * picture never drifts from the sound.
 */

/** How far behind real time frames are picked, so a frame captured at T has arrived by then. */
const PICK_DELAY_MS = 80
/** Encoder work allowed to queue up before frames are dropped instead. */
const MAX_PENDING = 4

/**
 * Maps a track's timestamps (milliseconds) onto performance.now(). Video frames and audio carry
 * different clocks in Chromium; the smallest gap seen between capture and arrival is the best
 * estimate of the offset, and it settles during the countdown.
 */
class TrackClock {
  private offset = Infinity

  observe(timestamp: number, arrival: number): void {
    this.offset = Math.min(this.offset, arrival - timestamp)
  }

  toPerformance(timestamp: number): number {
    return timestamp + (Number.isFinite(this.offset) ? this.offset : 0)
  }
}

/** Recording time, in seconds without pauses, for any moment, and back. */
export class Timeline {
  start: number | null = null
  private pauses: Array<{ from: number; to: number | null }> = []

  begin(now: number): void {
    this.start = now
  }

  pause(now: number): void {
    if (this.start !== null && !this.paused) this.pauses.push({ from: now, to: null })
  }

  resume(now: number): void {
    const last = this.pauses[this.pauses.length - 1]
    if (last && last.to === null) last.to = now
  }

  get paused(): boolean {
    const last = this.pauses[this.pauses.length - 1]
    return !!last && last.to === null
  }

  /** Seconds recorded at `time`, or null before the start or during a pause. */
  at(time: number): number | null {
    if (this.start === null || time < this.start) return null
    let paused = 0
    for (const p of this.pauses) {
      if (time < p.from) break
      if (p.to === null || time < p.to) return null
      paused += p.to - p.from
    }
    return (time - this.start - paused) / 1000
  }

  /** Seconds recorded by `time`, counting a running pause as stopped time. */
  elapsed(time: number): number {
    if (this.start === null) return 0
    let paused = 0
    for (const p of this.pauses) {
      if (time < p.from) break
      paused += (p.to ?? time) - p.from
    }
    return Math.max(0, (time - this.start - paused) / 1000)
  }

  /** The moment (performance.now() time) at which `seconds` of recording were reached. */
  momentOf(seconds: number): number {
    let time = this.start! + seconds * 1000
    for (const p of this.pauses) {
      if (time < p.from) break
      time += (p.to ?? Infinity) - p.from
    }
    return time
  }
}

/** The first error from an encoder; the recording stops with it rather than write empty files. */
type ErrorSink = (error: unknown) => void

/**
 * Copies the visible part of a frame into a frame of exactly that size. Encoders take their size
 * from the coded frame, so a crop made with visibleRect alone would still encode the whole picture.
 * The copy happens on the CPU, which avoids a canvas (and the GPU) for every frame.
 */
async function cropFrame(frame: VideoFrame, rect: PixelRect): Promise<VideoFrame> {
  const region = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  const buffer = new Uint8Array(frame.allocationSize({ rect: region }))
  const layout = await frame.copyTo(buffer, { rect: region })
  return new VideoFrame(buffer, {
    format: frame.format!,
    codedWidth: rect.width,
    codedHeight: rect.height,
    timestamp: frame.timestamp,
    layout,
    colorSpace: frame.colorSpace
  })
}

interface Held {
  frame: VideoFrame
  time: number
}

class VideoChannel {
  private clock = new TrackClock()
  private frames: Held[] = []
  private next = 0
  private pending = 0
  /** Samples go to the encoder one after another. */
  private queue: Promise<void> = Promise.resolve()
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null
  dropped = 0
  written = 0
  /** Size of the frames the track delivers, known after the first frame. */
  size: { width: number; height: number } | null = null
  /** The part of each frame to record, when not all of it (an area, or an odd size made even). */
  crop: PixelRect | null = null

  constructor(
    readonly track: MediaStreamVideoTrack,
    private timeline: Timeline,
    private fps: number,
    private source: () => VideoSampleSource | null,
    private onError: ErrorSink
  ) {}

  /** Starts reading frames. Resolves with the size of the first one. */
  read(): Promise<{ width: number; height: number }> {
    const processor = new MediaStreamTrackProcessor({ track: this.track })
    this.reader = processor.readable.getReader()
    return new Promise((resolve, reject) => {
      const loop = async () => {
        for (;;) {
          const { value: frame, done } = await this.reader!.read()
          if (done || !frame) return
          const now = performance.now()
          this.clock.observe(frame.timestamp / 1000, now)
          if (!this.size) {
            this.size = { width: frame.displayWidth, height: frame.displayHeight }
            resolve(this.size)
          }
          this.frames.push({ frame, time: this.clock.toPerformance(frame.timestamp / 1000) })
          // Before recording starts only the newest frame is needed.
          if (this.timeline.start === null) while (this.frames.length > 1) this.frames.shift()!.frame.close()
          // Never hold on to many frames: the capture pool is small.
          while (this.frames.length > 8) this.frames.shift()!.frame.close()
        }
      }
      loop().catch(reject)
    })
  }

  /** Writes every output frame due by `now`. */
  tick(now: number): void {
    const source = this.source()
    if (!source || this.timeline.start === null) return
    const due = this.timeline.at(now - PICK_DELAY_MS)
    if (due === null) return
    while (this.next / this.fps <= due) {
      const moment = this.timeline.momentOf(this.next / this.fps)
      let pick = -1
      for (let i = 0; i < this.frames.length; i++) if (this.frames[i].time <= moment) pick = i
      if (pick === -1 && this.frames.length > 0) pick = 0
      if (pick >= 0) {
        // Older frames are never needed again.
        for (let i = 0; i < pick; i++) this.frames.shift()!.frame.close()
        if (this.pending < MAX_PENDING) {
          const frame = this.frames[0].frame.clone()
          const timestamp = this.next / this.fps
          const crop = this.crop
          this.pending++
          this.queue = this.queue
            .then(async () => {
              let input = frame
              if (crop) {
                input = await cropFrame(frame, crop)
                frame.close()
              }
              const sample = new VideoSample(input, { timestamp, duration: 1 / this.fps })
              try {
                await source.add(sample)
              } finally {
                sample.close()
              }
            })
            .catch((error: unknown) => {
              frame.close()
              this.onError(error)
            })
            .finally(() => {
              this.pending--
            })
          this.written++
        } else {
          this.dropped++
        }
      }
      this.next++
    }
  }

  /** Resolves when every sample handed over so far is with the encoder. */
  flush(): Promise<void> {
    return this.queue
  }

  stop(): void {
    void this.reader?.cancel().catch(() => undefined)
    for (const held of this.frames) held.frame.close()
    this.frames = []
  }
}

class AudioChannel {
  private clock = new TrackClock()
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private nextTimestamp = 0
  private queue: Promise<void> = Promise.resolve()
  private levelBuffer = new Float32Array(0)
  /** Peak level of the latest audio, 0 to 1. */
  level = 0

  constructor(
    readonly track: MediaStreamAudioTrack,
    private timeline: Timeline,
    private source: () => AudioSampleSource | null,
    private onError: ErrorSink
  ) {}

  read(): void {
    const processor = new MediaStreamTrackProcessor({ track: this.track })
    this.reader = processor.readable.getReader()
    const loop = async () => {
      for (;;) {
        const { value: data, done } = await this.reader!.read()
        if (done || !data) return
        this.handle(data, performance.now())
      }
    }
    void loop().catch(() => undefined)
  }

  private measure(data: AudioData): void {
    const frames = data.numberOfFrames
    if (this.levelBuffer.length < frames) this.levelBuffer = new Float32Array(frames)
    try {
      data.copyTo(this.levelBuffer, { planeIndex: 0, format: 'f32-planar' })
      let peak = 0
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(this.levelBuffer[i]))
      this.level = Math.max(peak, this.level * 0.85)
    } catch {
      // The level meter is a nicety; never let it stop the recording.
    }
  }

  private handle(data: AudioData, now: number): void {
    const timestamp = data.timestamp / 1000
    this.clock.observe(timestamp, now)
    this.measure(data)
    const source = this.source()
    const at = this.timeline.at(this.clock.toPerformance(timestamp))
    if (!source || at === null) {
      data.close()
      return
    }
    // Keep the sound continuous; only a real gap (a hiccup of more than 30 ms) is kept as a gap.
    let start = at
    if (start < this.nextTimestamp || start - this.nextTimestamp < 0.03) start = this.nextTimestamp
    const sample = new AudioSample(data)
    sample.setTimestamp(start)
    this.nextTimestamp = start + data.numberOfFrames / data.sampleRate
    this.queue = this.queue
      .then(() => source.add(sample))
      .catch(this.onError)
      .finally(() => sample.close())
  }

  flush(): Promise<void> {
    return this.queue
  }

  stop(): void {
    void this.reader?.cancel().catch(() => undefined)
  }
}

interface FileOutput {
  plan: FilePlan
  output: Output
  video: VideoSampleSource | null
  audio: AudioSampleSource | null
}

export interface Streams {
  screen: MediaStream | null
  camera: MediaStream | null
  microphone: MediaStream | null
}

/** Opens every source the recording needs. The screen comes from the main process's choice. */
export async function openStreams(session: RecorderSession): Promise<Streams> {
  const { options, display } = session
  const streams: Streams = { screen: null, camera: null, microphone: null }
  try {
    if (options.mode !== 'camera' && options.screen) {
      const wantsArea = options.screen.kind === 'screen' && options.screen.area !== null
      // Screens are captured at the output size, so Chromium scales them; an area is cut from the
      // full resolution picture and scaled afterwards.
      let size: { width: number; height: number } | null = null
      if (display) size = captureSize(display, wantsArea ? options.screen.area : null, options.resolution)
      else if (options.resolution !== 'original') {
        const h = Number(options.resolution)
        size = { width: Math.round((h * 16) / 9), height: h }
      }
      try {
        streams.screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: options.fps, max: options.fps },
            ...(size ? { width: { max: size.width }, height: { max: size.height } } : {})
          },
          audio: options.systemAudio
        })
      } catch (error) {
        // Cancelling the system's picker (Wayland) or the screen recording prompt ends here.
        if (session.systemPicker && error instanceof DOMException && error.name === 'NotAllowedError') {
          throw new Error('No screen or window was chosen, so nothing was recorded.', { cause: error })
        }
        throw error
      }
    }
    if (options.mode !== 'screen' && options.camera) {
      const { width, height } =
        options.camera.resolution === '1080' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
      streams.camera = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: options.camera.deviceId },
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: options.fps }
        }
      })
    }
    if (options.microphone) {
      streams.microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: options.microphone.deviceId },
          noiseSuppression: options.microphone.noiseSuppression,
          // Echo cancellation colours a voice and is only needed for calls.
          echoCancellation: false,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48_000 }
        }
      })
    }
    return streams
  } catch (error) {
    closeStreams(streams)
    throw describeCaptureError(error)
  }
}

/**
 * The size to capture a screen at. For an area, the whole screen is scaled so the area alone comes
 * out at the chosen resolution, then the area is cut out of each frame.
 */
function captureSize(
  display: { width: number; height: number },
  area: { width: number; height: number } | null,
  resolution: RecordingOptions['resolution']
): { width: number; height: number } {
  if (!area) return fitOutputSize(display.width, display.height, resolution)
  const width = display.width * area.width
  const height = display.height * area.height
  const target = resolution === 'original' ? null : Number(resolution)
  const scale = target ? Math.min(1, (target * 16) / 9 / width, target / height) : 1
  // Within a couple of percent, keep the full resolution rather than scale the whole screen.
  if (scale > 0.98) return { width: display.width, height: display.height }
  return { width: Math.round(display.width * scale), height: Math.round(display.height * scale) }
}

export function closeStreams(streams: Streams): void {
  for (const stream of [streams.screen, streams.camera, streams.microphone]) {
    stream?.getTracks().forEach((t) => t.stop())
  }
}

function describeCaptureError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') {
    return new Error(
      'Kificut was not allowed to record. Check the screen, camera and microphone permissions in your system settings.'
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('The camera or microphone could not be found. It may have been unplugged.')
  }
  if (name === 'NotReadableError') {
    return new Error('The camera or microphone is in use by another app, or could not be started.')
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function pickVideoCodec(width: number, height: number, bitrate: number): Promise<VideoCodec> {
  for (const codec of ['avc', 'vp9'] as const) {
    if (await canEncodeVideo(codec, { width, height, bitrate })) return codec
  }
  throw new Error(`This computer cannot encode ${width} × ${height} video. Choose a lower resolution.`)
}

/** One recording: channels reading the sources and one output file per plan. */
export class Recording {
  readonly timeline = new Timeline()
  private channels: {
    screen?: VideoChannel
    camera?: VideoChannel
    microphone?: AudioChannel
    system?: AudioChannel
  } = {}
  private files: FileOutput[] = []
  private ticker: number | null = null
  private ended = new Set<string>()
  /** Called when a source stops by itself (a window closed, a camera unplugged). */
  onSourceEnded: (what: string) => void = () => undefined
  /** Called once when encoding or writing fails. */
  onFailure: (error: Error) => void = () => undefined
  private failed = false

  private fail = (error: unknown): void => {
    if (this.failed) return
    this.failed = true
    console.error('Recording failed', error)
    this.onFailure(error instanceof Error ? error : new Error(String(error)))
  }

  constructor(
    private session: RecorderSession,
    private streams: Streams
  ) {}

  get level(): number | null {
    return this.channels.microphone ? Math.min(1, this.channels.microphone.level) : null
  }

  /** Starts reading every source, so clocks settle and frame sizes are known before the start. */
  async prepare(): Promise<void> {
    const { options } = this.session
    const sourceOf = (video: 'screen' | 'camera') => () =>
      this.files.find((f) => f.plan.video === video)?.video ?? null
    const audioOf = (audio: 'microphone' | 'system') => () =>
      this.files.find((f) => f.plan.audio === audio)?.audio ?? null
    const watch = (track: MediaStreamTrack, what: string) =>
      track.addEventListener('ended', () => {
        if (!this.ended.has(what)) {
          this.ended.add(what)
          this.onSourceEnded(what)
        }
      })

    const sizes: Promise<unknown>[] = []
    const screenTrack = this.streams.screen?.getVideoTracks()[0]
    if (screenTrack) {
      this.channels.screen = new VideoChannel(
        screenTrack,
        this.timeline,
        options.fps,
        sourceOf('screen'),
        this.fail
      )
      sizes.push(this.channels.screen.read())
      watch(screenTrack, 'screen')
    }
    const cameraTrack = this.streams.camera?.getVideoTracks()[0]
    if (cameraTrack) {
      this.channels.camera = new VideoChannel(
        cameraTrack,
        this.timeline,
        options.fps,
        sourceOf('camera'),
        this.fail
      )
      sizes.push(this.channels.camera.read())
      watch(cameraTrack, 'camera')
    }
    const micTrack = this.streams.microphone?.getAudioTracks()[0]
    if (micTrack) {
      this.channels.microphone = new AudioChannel(micTrack, this.timeline, audioOf('microphone'), this.fail)
      this.channels.microphone.read()
      watch(micTrack, 'microphone')
    }
    const systemTrack = this.streams.screen?.getAudioTracks()[0]
    if (systemTrack) {
      this.channels.system = new AudioChannel(systemTrack, this.timeline, audioOf('system'), this.fail)
      this.channels.system.read()
    }
    // A still screen may not send a frame for a while; do not wait forever for one.
    await Promise.race([Promise.all(sizes), new Promise((resolve) => setTimeout(resolve, 5000))])
    if (screenTrack && !this.channels.screen?.size)
      throw new Error('The screen did not send a picture. Try again.')
    if (cameraTrack && !this.channels.camera?.size)
      throw new Error('The camera did not send a picture. Try again.')
  }

  private async createFile(plan: FilePlan): Promise<FileOutput> {
    const { options } = this.session
    let position = 0
    const writable = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        await window.kificut.recorder.write(plan.role, chunk.position, chunk.data)
        position = Math.max(position, chunk.position + chunk.data.length)
      }
    })
    const output = new Output({
      // Fragments are written at each key frame (every two seconds), so a crash loses little.
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new StreamTarget(writable)
    })

    let video: VideoSampleSource | null = null
    if (plan.video) {
      const channel = this.channels[plan.video]!
      const captured = channel.size!
      // Sources are captured at the size to record (see openStreams); only an area, or an odd size
      // that H.264 cannot encode, needs cutting.
      const area = plan.video === 'screen' ? options.screen?.area : null
      const even = { left: 0, top: 0, width: captured.width & ~1, height: captured.height & ~1 }
      channel.crop = area
        ? areaToPixels(area, captured.width, captured.height)
        : even.width !== captured.width || even.height !== captured.height
          ? even
          : null
      const outputSize = channel.crop ? { width: channel.crop.width, height: channel.crop.height } : captured
      const bitrate = videoBitrate(outputSize.width, outputSize.height, options.fps, options.quality)
      const codec = await pickVideoCodec(outputSize.width, outputSize.height, bitrate)
      video = new VideoSampleSource({
        codec,
        bitrate,
        bitrateMode: 'variable',
        keyFrameInterval: 2,
        // Text stays sharp on screens; cameras favour smooth motion.
        contentHint: plan.video === 'screen' ? 'detail' : 'motion',
        // A recorded window can change size; it is letterboxed into the first size.
        sizeChangeBehavior: 'contain'
      })
      output.addVideoTrack(video, { frameRate: options.fps })
    }

    let audio: AudioSampleSource | null = null
    if (plan.audio && this.channels[plan.audio]) {
      const codec = (await canEncodeAudio('opus')) ? 'opus' : 'aac'
      audio = new AudioSampleSource({ codec, bitrate: AUDIO_BITRATE })
      output.addAudioTrack(audio)
    }
    await output.start()
    return { plan, output, video, audio }
  }

  /** Creates the files and starts the clock. */
  async start(): Promise<void> {
    this.files = await Promise.all(this.session.plans.map((plan) => this.createFile(plan)))
    this.timeline.begin(performance.now())
    // Frame writing runs on a timer so a still screen still gets its frames.
    this.ticker = window.setInterval(() => this.tick(), 10)
  }

  private tick(): void {
    const now = performance.now()
    this.channels.screen?.tick(now)
    this.channels.camera?.tick(now)
  }

  pause(): void {
    this.timeline.pause(performance.now())
  }

  resume(): void {
    this.timeline.resume(performance.now())
  }

  get elapsed(): number {
    return this.timeline.elapsed(performance.now())
  }

  /** Writes what is left and closes the files. Resolves with the recorded length in seconds. */
  async stop(): Promise<number> {
    const end = performance.now()
    if (this.timeline.paused) this.timeline.resume(end)
    const duration = this.timeline.elapsed(end)
    // Let the last frames be picked before the sources close.
    await new Promise((resolve) => setTimeout(resolve, PICK_DELAY_MS + 30))
    this.tick()
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
    for (const channel of Object.values(this.channels)) channel?.stop()
    closeStreams(this.streams)
    await Promise.all(Object.values(this.channels).map((channel) => channel?.flush()))
    for (const file of this.files) {
      file.video?.close()
      file.audio?.close()
    }
    await Promise.all(this.files.map((f) => f.output.finalize()))
    return duration
  }

  async discard(): Promise<void> {
    if (this.ticker !== null) clearInterval(this.ticker)
    for (const channel of Object.values(this.channels)) channel?.stop()
    closeStreams(this.streams)
    await Promise.all(this.files.map((f) => f.output.cancel().catch(() => undefined)))
  }

  /** Frames written and dropped, for the console when testing. */
  stats(): Record<string, { written: number; dropped: number }> {
    const out: Record<string, { written: number; dropped: number }> = {}
    for (const name of ['screen', 'camera'] as const) {
      const c = this.channels[name]
      if (c) out[name] = { written: c.written, dropped: c.dropped }
    }
    return out
  }
}
