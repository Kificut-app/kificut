import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadVerified, type DownloadTarget } from './download'

/* The model downloader against a server that drops connections and may or may not resume. */

const DATA = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251))
const SHA256 = createHash('sha256').update(DATA).digest('hex')

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, count: number) => void
): Promise<string> {
  let count = 0
  server = createServer((req, res) => handler(req, res, ++count))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/model.onnx`
}

function target(url: string, digest = SHA256): DownloadTarget {
  return {
    url,
    dest: join(mkdtempSync(join(tmpdir(), 'kificut-dl-')), 'model.onnx'),
    size: DATA.length,
    digest,
    kind: 'sha256'
  }
}

/** Sends the start of the file, then cuts the connection. */
function dropHalfway(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Length': DATA.length })
  res.write(DATA.subarray(0, 100_000), () => res.destroy())
}

const run = (t: DownloadTarget, signal = new AbortController().signal) => {
  let progress = 0
  const done = downloadVerified(
    t,
    (url, init) => fetch(url, init),
    signal,
    (n) => (progress += n),
    5
  )
  return { done, progress: () => progress }
}

describe('downloadVerified', () => {
  it('resumes a dropped download with a range request', async () => {
    const ranges: Array<string | undefined> = []
    const url = await serve((req, res, count) => {
      ranges.push(req.headers.range)
      if (count === 1) return dropHalfway(res)
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${DATA.length - 1}/${DATA.length}` })
      res.end(DATA.subarray(from))
    })
    const t = target(url)
    const { done, progress } = run(t)
    await done
    expect(readFileSync(t.dest).equals(DATA)).toBe(true)
    expect(ranges[0]).toBeUndefined()
    expect(ranges[1]).toMatch(/^bytes=\d+-$/)
    expect(progress()).toBe(DATA.length)
    expect(existsSync(`${t.dest}.part`)).toBe(false)
  })

  it('starts over when the server ignores the range', async () => {
    const url = await serve((_req, res, count) => {
      if (count === 1) return dropHalfway(res)
      res.writeHead(200, { 'Content-Length': DATA.length })
      res.end(DATA)
    })
    const t = target(url)
    const { done, progress } = run(t)
    await done
    expect(readFileSync(t.dest).equals(DATA)).toBe(true)
    expect(progress()).toBe(DATA.length)
  })

  it('does not retry a missing file', async () => {
    let requests = 0
    const url = await serve((_req, res) => {
      requests++
      res.writeHead(404)
      res.end()
    })
    const t = target(url)
    await expect(run(t).done).rejects.toThrow('HTTP 404')
    expect(requests).toBe(1)
    expect(existsSync(`${t.dest}.part`)).toBe(false)
  })

  it('gives up after repeated failures', async () => {
    let requests = 0
    const url = await serve((_req, res) => {
      requests++
      res.writeHead(503)
      res.end()
    })
    await expect(run(target(url)).done).rejects.toThrow('HTTP 503')
    expect(requests).toBe(5)
  })

  it('rejects a file that does not match its hash', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200)
      res.end(DATA)
    })
    const t = target(url, '0'.repeat(64))
    await expect(run(t).done).rejects.toThrow('checksum')
    expect(existsSync(t.dest)).toBe(false)
    expect(existsSync(`${t.dest}.part`)).toBe(false)
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const url = await serve((_req, res) => {
      dropHalfway(res)
      controller.abort()
    })
    await expect(run(target(url), controller.signal).done).rejects.toBeDefined()
  })
})
