import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/*
 * Downloads one file and checks it against a published hash. A dropped connection (the network
 * changing, Wi-Fi reconnecting, a laptop waking up) is retried and resumes where it stopped.
 */

export interface DownloadTarget {
  url: string
  dest: string
  size: number
  /** Hex digest to compare against, and how to compute it. */
  digest: string
  kind: 'sha256' | 'git-blob'
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<Response>

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const MAX_ATTEMPTS = 5

/** Server errors and rate limits are worth retrying; other HTTP errors are not. Network errors are. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500 || error.status === 408 || error.status === 429
  return true
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

/** Runs work again after network failures, waiting a little longer each time. */
export async function retrying<T>(work: () => Promise<T>, signal: AbortSignal, delayMs = 1000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (signal.aborted || !isRetryable(error) || attempt >= MAX_ATTEMPTS) throw error
      await wait(delayMs * attempt, signal)
    }
  }
}

export function startHash(target: Pick<DownloadTarget, 'kind' | 'size'>): Hash {
  const hash = createHash(target.kind === 'sha256' ? 'sha256' : 'sha1')
  if (target.kind === 'git-blob') hash.update(`blob ${target.size}\0`)
  return hash
}

/** True when the file is already on disk with the right size and hash. */
export async function fileMatches(target: DownloadTarget): Promise<boolean> {
  const info = await stat(target.dest).catch(() => null)
  if (!info || info.size !== target.size) return false
  const hash = startHash(target)
  for await (const chunk of createReadStream(target.dest)) hash.update(chunk as Buffer)
  return hash.digest('hex') === target.digest
}

function finish(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) =>
    out.end((error?: Error | null) => (error ? reject(error) : resolve()))
  )
}

export async function downloadVerified(
  target: DownloadTarget,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  onBytes: (count: number) => void,
  retryDelayMs = 1000
): Promise<void> {
  await mkdir(dirname(target.dest), { recursive: true })
  const partial = `${target.dest}.part`
  let out = createWriteStream(partial)
  let hash = startHash(target)
  let written = 0
  let failures = 0

  try {
    while (written < target.size) {
      try {
        const headers: Record<string, string> = written > 0 ? { Range: `bytes=${written}-` } : {}
        const response = await fetchImpl(target.url, { signal, headers })
        if (!response.ok || !response.body) {
          throw new HttpError(`Download failed (HTTP ${response.status}) for ${target.url}`, response.status)
        }
        if (written > 0 && response.status !== 206) {
          // The server sent the whole file instead of the rest, so start the file again.
          await finish(out)
          out = createWriteStream(partial)
          hash = startHash(target)
          onBytes(-written)
          written = 0
        }
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          written += value.byteLength
          onBytes(value.byteLength)
          failures = 0
          if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        }
        if (written < target.size) throw new Error('The connection closed before the file was complete.')
      } catch (error) {
        if (signal.aborted || !isRetryable(error) || ++failures >= MAX_ATTEMPTS) throw error
        await wait(retryDelayMs * failures, signal)
      }
    }
    await finish(out)
  } catch (error) {
    out.destroy()
    await rm(partial, { force: true })
    throw error
  }

  if (written !== target.size || hash.digest('hex') !== target.digest) {
    await rm(partial, { force: true })
    throw new Error(`${target.url} did not match its published checksum. Try again.`)
  }
  await rename(partial, target.dest)
}
