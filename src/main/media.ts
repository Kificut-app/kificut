import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import type {
  Filmstrip,
  MediaAnalysis,
  MediaFileEntry,
  MediaFileList,
  MediaItem,
  MediaKind,
  ProbeResult,
  ProxyStatus,
  SampledFrame,
  Waveform
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { isMediaFile } from '@shared/media-formats'
import { createLimiter, ffmpegPath, ffprobePath, run } from './ffmpeg'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'])
const IMAGE_FORMATS = new Set([
  'image2',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
  'bmp_pipe',
  'tiff_pipe',
  'gif'
])

const thumbLimit = createLimiter(3)
const waveLimit = createLimiter(2)
const proxyLimit = createLimiter(1)

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string; size?: string }
}

function parseRate(rate?: string): number {
  if (!rate) return 0
  const [n, d] = rate.split('/').map(Number)
  if (!n || !d) return 0
  return n / d
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

export async function probe(path: string): Promise<ProbeResult> {
  try {
    const result = await run(ffprobePath(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path
    ])
    if (result.code !== 0) {
      return { path, ok: false, error: lastLine(result.stderr) || 'The file could not be read.' }
    }
    const data = JSON.parse(result.stdout.toString()) as FfprobeOutput
    const streams = data.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
    const audio = streams.find((s) => s.codec_type === 'audio')
    if (!video && !audio) return { path, ok: false, error: 'No audio or video found in this file.' }

    const ext = extname(path).slice(1).toLowerCase()
    const formatName = data.format?.format_name ?? ''
    const isImage = !!video && !audio && (IMAGE_EXTENSIONS.has(ext) || IMAGE_FORMATS.has(formatName))

    let width = video?.width ?? 0
    let height = video?.height ?? 0
    const rotationTag = video?.tags?.rotate ? parseFloat(video.tags.rotate) : NaN
    const rotationSide = video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation
    const rotation = Number.isFinite(rotationTag) ? rotationTag : (rotationSide ?? 0)
    if (Math.abs(Math.round(rotation / 90)) % 2 === 1) [width, height] = [height, width]

    const duration = isImage
      ? 0
      : parseFloat(data.format?.duration ?? '') ||
        parseFloat(video?.duration ?? '') ||
        parseFloat(audio?.duration ?? '') ||
        0

    const kind: MediaKind = isImage ? 'image' : video ? 'video' : 'audio'
    const info = await stat(path)
    const media: Omit<MediaItem, 'id'> = {
      kind,
      name: basename(path),
      path,
      duration,
      width,
      height,
      fps: video ? parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30 : 0,
      hasVideo: !!video,
      hasAudio: !!audio && !isImage,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      container: formatName,
      size: info.size
    }
    if (kind === 'video' && duration <= 0) {
      return { path, ok: false, error: 'Could not determine the duration of this file.' }
    }
    return { path, ok: true, media }
  } catch (error) {
    return { path, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function cacheDir(path: string): Promise<string> {
  const info = await stat(path)
  const key = createHash('sha1').update(`${path}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 20)
  const dir = join(app.getPath('userData'), 'cache', key)
  await mkdir(dir, { recursive: true })
  return dir
}

async function extractFrame(path: string, time: number, height: number, out: string): Promise<boolean> {
  const args = ['-hide_banner', '-loglevel', 'error']
  if (time > 0) args.push('-ss', time.toFixed(3))
  args.push('-i', path, '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '5', '-y', out)
  const result = await run(ffmpegPath(), args)
  return result.code === 0 && existsSync(out)
}

export async function poster(path: string, duration: number): Promise<string | null> {
  try {
    const dir = await cacheDir(path)
    const out = join(dir, 'poster.jpg')
    if (existsSync(out)) return out
    const time = duration > 0 ? Math.min(1, duration * 0.1) : 0
    const ok = await thumbLimit(() => extractFrame(path, time, 180, out))
    return ok ? out : null
  } catch {
    return null
  }
}

const filmstripJobs = new Map<string, Promise<Filmstrip | null>>()

export function filmstrip(path: string, duration: number): Promise<Filmstrip | null> {
  const existing = filmstripJobs.get(path)
  if (existing) return existing
  const job = buildFilmstrip(path, duration).finally(() => filmstripJobs.delete(path))
  filmstripJobs.set(path, job)
  return job
}

async function buildFilmstrip(path: string, duration: number): Promise<Filmstrip | null> {
  try {
    const dir = await cacheDir(path)
    const manifest = join(dir, 'filmstrip.json')
    if (existsSync(manifest)) {
      return JSON.parse(await readFile(manifest, 'utf8')) as Filmstrip
    }
    const count = Math.min(60, Math.max(1, Math.ceil(duration / 2)))
    const interval = duration / count
    const frames = await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const out = join(dir, `strip_${String(i).padStart(3, '0')}.jpg`)
        const time = Math.min(duration - 0.05, (i + 0.5) * interval)
        return thumbLimit(() => extractFrame(path, Math.max(0, time), 90, out)).then((ok) => (ok ? out : ''))
      })
    )
    const result: Filmstrip = { interval, frames }
    if (frames.every(Boolean)) await writeFile(manifest, JSON.stringify(result))
    return result
  } catch {
    return null
  }
}

const PEAKS_PER_SECOND = 100
const WAVE_SAMPLE_RATE = 8000

export async function waveform(path: string): Promise<Waveform | null> {
  try {
    const dir = await cacheDir(path)
    const out = join(dir, 'waveform.f32')
    if (existsSync(out)) {
      const buffer = await readFile(out)
      const peaks = new Float32Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      )
      return { peaks, rate: PEAKS_PER_SECOND }
    }

    return await waveLimit(async () => {
      const samplesPerPeak = WAVE_SAMPLE_RATE / PEAKS_PER_SECOND
      const peaks: number[] = []
      let current = 0
      let counted = 0
      let carry: Buffer | null = null

      const result = await run(
        ffmpegPath(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path,
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(WAVE_SAMPLE_RATE),
          '-f',
          's16le',
          '-acodec',
          'pcm_s16le',
          'pipe:1'
        ],
        {
          collectStdout: false,
          onStdout: (chunk) => {
            let data = carry ? Buffer.concat([carry, chunk]) : chunk
            const usable = data.length - (data.length % 2)
            carry = usable < data.length ? data.subarray(usable) : null
            data = data.subarray(0, usable)
            for (let i = 0; i < data.length; i += 2) {
              const sample = Math.abs(data.readInt16LE(i)) / 32768
              if (sample > current) current = sample
              if (++counted >= samplesPerPeak) {
                peaks.push(current)
                current = 0
                counted = 0
              }
            }
          }
        }
      )
      if (counted > 0) peaks.push(current)
      if (result.code !== 0 || peaks.length === 0) return null

      const array = Float32Array.from(peaks)
      await writeFile(out, Buffer.from(array.buffer))
      return { peaks: array, rate: PEAKS_PER_SECOND }
    })
  } catch {
    return null
  }
}

const proxies = new Map<string, ProxyStatus>()

function broadcastProxy(path: string, status: ProxyStatus): void {
  proxies.set(path, status)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.mediaProxyProgress, path, status)
  }
}

/**
 * Creates an H.264 preview copy for footage Chromium cannot decode (ProRes, DNxHD, AVI and so on).
 * Exports always read the original file.
 */
export async function requestProxy(path: string): Promise<ProxyStatus> {
  const known = proxies.get(path)
  if (known && known.state !== 'failed') return known

  const dir = await cacheDir(path)
  const probed = await probe(path)
  const audioOnly = probed.media?.kind === 'audio'
  const out = join(dir, audioOnly ? 'proxy.m4a' : 'proxy.mp4')
  if (existsSync(out)) {
    const ready: ProxyStatus = { state: 'ready', progress: 1, path: out }
    proxies.set(path, ready)
    return ready
  }

  const pending: ProxyStatus = { state: 'pending', progress: 0 }
  proxies.set(path, pending)
  const duration = probed.media?.duration ?? 0

  proxyLimit(async () => {
    const temp = join(dir, audioOnly ? 'proxy.partial.m4a' : 'proxy.partial.mp4')
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-i', path]
    if (audioOnly) {
      args.push('-vn', '-c:a', 'aac', '-b:a', '192k')
    } else {
      args.push(
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "scale=-2:'min(720,ih)'",
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-g',
        '15',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k'
      )
    }
    args.push('-movflags', '+faststart', '-y', temp)

    let lastSent = 0
    const result = await run(ffmpegPath(), args, {
      collectStdout: false,
      onStdout: (chunk) => {
        const match = /out_time_us=(\d+)/.exec(chunk.toString())
        if (!match || duration <= 0) return
        const progress = Math.min(0.99, parseInt(match[1], 10) / 1e6 / duration)
        if (Date.now() - lastSent > 250) {
          lastSent = Date.now()
          broadcastProxy(path, { state: 'pending', progress })
        }
      }
    })

    if (result.code === 0 && existsSync(temp)) {
      await rename(temp, out)
      broadcastProxy(path, { state: 'ready', progress: 1, path: out })
    } else {
      await rm(temp, { force: true })
      broadcastProxy(path, { state: 'failed', progress: 0, error: lastLine(result.stderr) })
    }
  }).catch((error: unknown) => {
    broadcastProxy(path, { state: 'failed', progress: 0, error: String(error) })
  })

  return pending
}

/* Helpers for AI tools */

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

const MAX_LISTED_FILES = 500

/** Media files in a folder, optionally three levels deep. Hidden files and folders are skipped. */
export async function listMediaFiles(folder: string, recursive: boolean): Promise<MediaFileList> {
  const root = resolve(expandHome(folder))
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`Not a folder: ${root}`)

  const files: MediaFileEntry[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && depth < 3) await walk(full, depth + 1)
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        if (files.length >= MAX_LISTED_FILES) {
          truncated = true
          return
        }
        const s = await stat(full).catch(() => null)
        if (s) files.push({ path: full, name: entry.name, size: s.size, modified: s.mtime.toISOString() })
      }
    }
  }
  await walk(root, 0)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { folder: root, files, truncated }
}

/** Still frames across a source range, scaled so the longest side is 640 pixels, as base64 JPEG. */
export async function sampleFrames(
  path: string,
  duration: number,
  count: number,
  start = 0,
  end = duration
): Promise<SampledFrame[]> {
  const dir = await cacheDir(path)
  const still = duration <= 0
  const from = Math.max(0, Math.min(start, duration))
  const to = Math.max(from, Math.min(end > 0 ? end : duration, duration))
  const span = to - from
  const times = still ? [0] : Array.from({ length: count }, (_, i) => from + ((i + 0.5) * span) / count)

  return Promise.all(
    times.map((time) =>
      thumbLimit(async () => {
        const out = join(dir, `inspect_${Math.round(time * 1000)}.jpg`)
        if (!existsSync(out)) {
          const args = ['-hide_banner', '-loglevel', 'error']
          if (time > 0) args.push('-ss', time.toFixed(3))
          args.push(
            '-i',
            path,
            '-frames:v',
            '1',
            '-vf',
            'scale=w=640:h=640:force_original_aspect_ratio=decrease',
            '-q:v',
            '4',
            '-y',
            out
          )
          const result = await run(ffmpegPath(), args)
          if (result.code !== 0 || !existsSync(out))
            throw new Error(`Could not read a frame at ${time.toFixed(2)}s`)
        }
        return { time, data: (await readFile(out)).toString('base64') }
      })
    )
  )
}

/** Scene changes (video) and silences (audio) found by FFmpeg. Results are cached per file. */
export async function analyzeMedia(
  path: string,
  duration: number,
  hasVideo: boolean,
  hasAudio: boolean
): Promise<MediaAnalysis> {
  const dir = await cacheDir(path)
  const cached = join(dir, 'analysis.json')
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8')) as MediaAnalysis

  const args = ['-hide_banner', '-nostats', '-i', path]
  if (hasVideo) args.push('-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo")
  else args.push('-vn')
  if (hasAudio) args.push('-af', 'silencedetect=noise=-35dB:d=0.6')
  else args.push('-an')
  args.push('-f', 'null', '-')

  const scenes: number[] = []
  const silences: Array<{ start: number; end: number }> = []
  let open: number | null = null
  let pending = ''
  const round = (n: number) => Math.round(n * 100) / 100
  const result = await run(ffmpegPath(), args, {
    collectStdout: false,
    onStderr: (chunk) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const scene = /showinfo.*pts_time:\s*([\d.]+)/.exec(line)
        if (scene) scenes.push(round(parseFloat(scene[1])))
        const silenceStart = /silence_start:\s*(-?[\d.]+)/.exec(line)
        if (silenceStart) open = Math.max(0, parseFloat(silenceStart[1]))
        const silenceEnd = /silence_end:\s*([\d.]+)/.exec(line)
        if (silenceEnd && open !== null) {
          silences.push({ start: round(open), end: round(parseFloat(silenceEnd[1])) })
          open = null
        }
      }
    }
  })
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || 'Analysis failed.')
  if (open !== null) silences.push({ start: round(open), end: round(duration) })

  const analysis: MediaAnalysis = { scenes, silences }
  await writeFile(cached, JSON.stringify(analysis))
  return analysis
}

const MAX_DECODE_SECONDS = 3 * 60 * 60

/** Decodes a file's audio to mono 32-bit float samples, for speech recognition. */
export async function decodeAudio(path: string, sampleRate: number): Promise<Float32Array> {
  const result = await run(ffmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-t',
    String(MAX_DECODE_SECONDS),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    'pipe:1'
  ])
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || 'Could not read the audio.')
  const bytes = result.stdout
  // Copy into a fresh, aligned buffer; Node's pooled buffers can start at an odd offset.
  const samples = new Float32Array(Math.floor(bytes.length / 4))
  new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 4))
  return samples
}

/** Saves generated media (such as a voiceover) in Documents/Kificut/Generated. */
export async function saveGenerated(name: string, data: Uint8Array): Promise<string> {
  const dir = join(app.getPath('documents'), 'Kificut', 'Generated')
  await mkdir(dir, { recursive: true })
  const dot = name.lastIndexOf('.')
  const stem =
    (dot > 0 ? name.slice(0, dot) : name)
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .slice(0, 60) || 'generated'
  const ext = dot > 0 ? name.slice(dot).replace(/[^\w.]/g, '') : '.wav'
  let target = join(dir, `${stem}${ext}`)
  for (let i = 2; existsSync(target); i++) target = join(dir, `${stem} ${i}${ext}`)
  await writeFile(target, data)
  return target
}
