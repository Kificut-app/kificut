import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export const MEDIA_SCHEME = 'media'
export const MODELS_SCHEME = 'models'

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  txt: 'text/plain',
  onnx: 'application/octet-stream',
  bin: 'application/octet-stream'
}

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  const privileges = { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges },
    { scheme: MODELS_SCHEME, privileges }
  ])
}

/**
 * Serves local files to the renderer as media://local/<encoded path>. Byte ranges are handled
 * explicitly because video elements need them to seek.
 */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname.slice(1))

    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response(null, { status: 404 })
      size = info.size
    } catch {
      return new Response(null, { status: 404 })
    }

    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }

    const range = request.headers.get('range')
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      let start = match[1] ? parseInt(match[1], 10) : 0
      let end = match[2] ? parseInt(match[2], 10) : size - 1
      if (!match[1] && match[2]) {
        start = Math.max(0, size - parseInt(match[2], 10))
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ConstructorParameters<
        typeof Response
      >[0]
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1)
        }
      })
    }

    const body = Readable.toWeb(createReadStream(path)) as unknown as ConstructorParameters<
      typeof Response
    >[0]
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  })
}

/**
 * Serves installed model files as models://store/<path>. Only files inside the models folder can
 * be read.
 */
export function handleModelsProtocol(root: string): void {
  const base = resolve(root)
  protocol.handle(MODELS_SCHEME, async (request) => {
    const url = new URL(request.url)
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const path = resolve(base, relativePath)
    if (path !== base && !path.startsWith(base + sep)) return new Response(null, { status: 403 })
    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response(null, { status: 404 })
      size = info.size
    } catch {
      return new Response(null, { status: 404 })
    }
    const body = Readable.toWeb(createReadStream(path)) as unknown as ConstructorParameters<
      typeof Response
    >[0]
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(size),
        'Access-Control-Allow-Origin': '*'
      }
    })
  })
}
