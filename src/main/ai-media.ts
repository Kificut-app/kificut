import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { RNNOISE_FILE, RNNOISE_FOLDER } from '@shared/models'
import { ffmpegPath, run } from './ffmpeg'
import { cacheDir, generatedPath } from './media'
import { modelsDir } from './models'

/*
 * FFmpeg work for the local AI features: frames for footage search, noise reduction with RNNoise,
 * and the decode and encode ends of background removal for video.
 */

function stem(path: string): string {
  return basename(path, extname(path))
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
}

/** Copies a Node buffer into its own aligned array, so it can be transferred onwards. */
function own(bytes: Buffer): Uint8Array {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}

/* Footage search */

export const SEARCH_FRAME_SIZE = 224
const MAX_SEARCH_FRAMES = 400

export interface SearchFrames {
  /** Seconds into the file for each frame. */
  times: number[]
  width: number
  height: number
  /** RGB frames, one after another. */
  data: Uint8Array
}

/** Small square frames through a whole file in one pass: every 2 seconds, or fewer for long files. */
export async function searchFrames(path: string, duration: number): Promise<SearchFrames> {
  const size = SEARCH_FRAME_SIZE
  const step = duration > 0 ? Math.max(2, duration / MAX_SEARCH_FRAMES) : 0
  const crop = `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`
  const args = ['-hide_banner', '-loglevel', 'error', '-i', path, '-an']
  if (step > 0) args.push('-vf', `fps=1/${step.toFixed(4)},${crop}`)
  else args.push('-frames:v', '1', '-vf', crop)
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1')
  const result = await run(ffmpegPath(), args)
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || 'Could not read frames from this file.')
  const count = Math.floor(result.stdout.length / (size * size * 3))
  return {
    times: Array.from({ length: count }, (_, i) => i * step),
    width: size,
    height: size,
    data: own(result.stdout.subarray(0, count * size * size * 3))
  }
}

/** The search index is cached next to the file's thumbnails, so it is rebuilt when the file changes. */
export async function readSearchIndex(path: string, model: string): Promise<string | null> {
  try {
    return await readFile(join(await cacheDir(path), `search-${model}.json`), 'utf8')
  } catch {
    return null
  }
}

export async function writeSearchIndex(path: string, model: string, data: string): Promise<void> {
  await writeFile(join(await cacheDir(path), `search-${model}.json`), data, 'utf8')
}

/* Noise reduction */

/**
 * Writes a copy of the file's sound with background noise removed by RNNoise (FFmpeg's arnndn
 * filter), as FLAC in Documents/Kificut/Generated. `strength` from 0 to 1 sets how much of the
 * cleaned signal is used.
 */
export async function reduceNoise(
  path: string,
  strength: number,
  duration: number,
  onProgress: (fraction: number) => void
): Promise<string> {
  const folder = join(modelsDir(), ...RNNOISE_FOLDER.split('/'))
  if (!existsSync(join(folder, RNNOISE_FILE))) {
    throw new Error('The RNNoise model is not installed. Install it from the AI button in Kificut.')
  }
  const out = await generatedPath(`${stem(path)} (clean).flac`)
  const mix = Math.max(0, Math.min(1, strength)).toFixed(2)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-y',
    '-i',
    path,
    '-map',
    '0:a:0',
    // The model is read from the working folder, which avoids escaping a full path inside the filter.
    '-af',
    `arnndn=m=${RNNOISE_FILE}:mix=${mix}`,
    '-c:a',
    'flac',
    '-progress',
    'pipe:1',
    out
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd: folder, windowsHide: true })
    let errors = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const match = /out_time_us=(\d+)/.exec(chunk)
      if (match && duration > 0) onProgress(Math.min(1, Number(match[1]) / 1e6 / duration))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (errors += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(lastLine(errors) || 'FFmpeg could not clean the audio.'))
    )
  })
  return out
}

/* Background removal for video */

interface MatteSession {
  decoder: ChildProcess
  encoder: ChildProcess
  chunks: Buffer[]
  buffered: number
  frameBytes: number
  ended: boolean
  error: string
  wake: (() => void) | null
  out: string
  encoded: Promise<void>
}

const sessions = new Map<number, MatteSession>()
let nextSession = 1
const MAX_BUFFERED_FRAMES = 48

/** The size frames are matted at: long side 512, both sides multiples of 32 as MODNet needs. */
export function matteSize(width: number, height: number): { width: number; height: number } {
  const scale = 512 / Math.max(width, height, 1)
  const round = (n: number) => Math.max(32, Math.round((n * scale) / 32) * 32)
  return { width: round(width), height: round(height) }
}

export interface MatteStart {
  id: number
  width: number
  height: number
  frames: number
}

/**
 * Starts background removal for part of a video. One FFmpeg reads small frames for the model;
 * another takes the masks back and writes the full size video with them as its alpha channel,
 * as VP9 WebM, which Chromium plays with transparency.
 */
export async function startMatte(
  path: string,
  start: number,
  duration: number,
  fps: number,
  sourceWidth: number,
  sourceHeight: number
): Promise<MatteStart> {
  const size = matteSize(sourceWidth, sourceHeight)
  const rate = Math.max(1, Math.min(60, Math.round(fps * 1000) / 1000 || 30))
  const out = await generatedPath(`${stem(path)} (no background).webm`)
  const range = ['-ss', start.toFixed(3), '-t', duration.toFixed(3)]
  const width = Math.max(2, Math.round(sourceWidth / 2) * 2)
  const height = Math.max(2, Math.round(sourceHeight / 2) * 2)

  const decoder = spawn(
    ffmpegPath(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...range,
      '-i',
      path,
      '-an',
      '-vf',
      `fps=${rate},scale=${size.width}:${size.height}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
    { windowsHide: true }
  )
  const encoder = spawn(
    ffmpegPath(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...range,
      '-i',
      path,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-s',
      `${size.width}x${size.height}`,
      '-framerate',
      String(rate),
      '-i',
      'pipe:0',
      '-filter_complex',
      `[0:v]fps=${rate},scale=${width}:${height},format=rgba[v];` +
        `[1:v]scale=${width}:${height}:flags=bicubic,format=gray[m];` +
        `[v][m]alphamerge,format=yuva420p[out]`,
      '-map',
      '[out]',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      '0',
      '-crf',
      '30',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-row-mt',
      '1',
      // VP9 cannot encode transparency with alternate reference frames.
      '-auto-alt-ref',
      '0',
      out
    ],
    { windowsHide: true }
  )

  const session: MatteSession = {
    decoder,
    encoder,
    chunks: [],
    buffered: 0,
    frameBytes: size.width * size.height * 3,
    ended: false,
    error: '',
    wake: null,
    out,
    encoded: Promise.resolve()
  }
  const wake = () => {
    session.wake?.()
    session.wake = null
  }
  decoder.stdout.on('data', (chunk: Buffer) => {
    session.chunks.push(chunk)
    session.buffered += chunk.length
    if (session.buffered > MAX_BUFFERED_FRAMES * session.frameBytes) decoder.stdout.pause()
    wake()
  })
  decoder.stderr.setEncoding('utf8')
  decoder.stderr.on('data', (chunk: string) => (session.error += chunk))
  decoder.on('close', (code) => {
    session.ended = true
    if (code !== 0 && !session.error) session.error = 'FFmpeg could not read this video.'
    else if (code === 0) session.error = ''
    wake()
  })
  let encoderErrors = ''
  encoder.stderr.setEncoding('utf8')
  encoder.stderr.on('data', (chunk: string) => (encoderErrors += chunk))
  encoder.stdin.on('error', () => undefined)
  session.encoded = new Promise((resolve, reject) => {
    encoder.on('error', reject)
    encoder.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(lastLine(encoderErrors) || 'FFmpeg could not write the video.'))
    )
  })
  session.encoded.catch(() => undefined)

  const id = nextSession++
  sessions.set(id, session)
  return { id, ...size, frames: Math.max(1, Math.round(duration * rate)) }
}

function sessionFor(id: number): MatteSession {
  const session = sessions.get(id)
  if (!session) throw new Error('This background removal has already finished.')
  return session
}

/** Up to `max` frames, waiting for the decoder when needed. Empty when there are no more. */
export async function readMatteFrames(id: number, max: number): Promise<Uint8Array> {
  const session = sessionFor(id)
  while (session.buffered < session.frameBytes && !session.ended) {
    await new Promise<void>((resolve) => (session.wake = resolve))
  }
  if (session.error) throw new Error(lastLine(session.error))
  const count = Math.min(max, Math.floor(session.buffered / session.frameBytes))
  const bytes = count * session.frameBytes
  const joined = Buffer.concat(session.chunks)
  session.chunks = joined.length > bytes ? [joined.subarray(bytes)] : []
  session.buffered = joined.length - bytes
  if (session.buffered < MAX_BUFFERED_FRAMES * session.frameBytes) session.decoder.stdout?.resume()
  return own(joined.subarray(0, bytes))
}

export async function writeMatteMasks(id: number, masks: Uint8Array): Promise<void> {
  const stdin = sessionFor(id).encoder.stdin!
  if (!stdin.write(Buffer.from(masks.buffer, masks.byteOffset, masks.byteLength))) {
    await new Promise<void>((resolve) => stdin.once('drain', () => resolve()))
  }
}

/** Finishes the video and returns its path. */
export async function finishMatte(id: number): Promise<string> {
  const session = sessionFor(id)
  sessions.delete(id)
  session.encoder.stdin!.end()
  await session.encoded
  return session.out
}

export async function cancelMatte(id: number): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  session.decoder.kill()
  session.encoder.kill()
  await session.encoded.catch(() => undefined)
  await rm(session.out, { force: true })
}
