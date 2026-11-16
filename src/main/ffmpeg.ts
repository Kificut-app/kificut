import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BinaryInfo, ToolInfo } from '@shared/types'
import { getSettings } from './settings'

const exe = process.platform === 'win32' ? '.exe' : ''

function bundledPath(name: 'ffmpeg' | 'ffprobe'): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', name + exe)
  }
  const root = app.getAppPath()
  if (name === 'ffmpeg') {
    return join(root, 'node_modules', 'ffmpeg-static', name + exe)
  }
  return join(root, 'vendor', 'ffprobe', name + exe)
}

export function ffmpegPath(): string {
  const custom = getSettings().ffmpegPath
  return custom && existsSync(custom) ? custom : bundledPath('ffmpeg')
}

export function ffprobePath(): string {
  const custom = getSettings().ffprobePath
  return custom && existsSync(custom) ? custom : bundledPath('ffprobe')
}

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

export interface RunOptions {
  onStdout?: (chunk: Buffer) => void
  onSpawn?: (child: ChildProcess) => void
  collectStdout?: boolean
}

export function run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    options.onSpawn?.(child)
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.collectStdout !== false) out.push(chunk)
      options.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
      if (err.length > 64_000) err = err.slice(-32_000)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
  })
}

async function binaryInfo(path: string): Promise<BinaryInfo> {
  if (!existsSync(path)) return { path, version: null, ok: false }
  try {
    const result = await run(path, ['-hide_banner', '-version'])
    const match = /version\s+(\S+)/.exec(result.stdout.toString())
    return { path, version: match ? match[1] : null, ok: result.code === 0 }
  } catch {
    return { path, version: null, ok: false }
  }
}

export async function toolInfo(): Promise<ToolInfo> {
  const [ffmpeg, ffprobe] = await Promise.all([binaryInfo(ffmpegPath()), binaryInfo(ffprobePath())])
  return { ffmpeg, ffprobe }
}

let majorVersion: number | null | undefined

/** Major FFmpeg version, or null for builds that do not report one (git snapshots are treated as modern). */
export async function ffmpegMajorVersion(): Promise<number | null> {
  if (majorVersion !== undefined) return majorVersion
  const info = await binaryInfo(ffmpegPath())
  const match = info.version ? /^n?(\d+)\./.exec(info.version) : null
  majorVersion = match ? parseInt(match[1], 10) : info.version ? 99 : null
  return majorVersion
}

export function resetVersionCache(): void {
  majorVersion = undefined
}

/** Runs tasks with a fixed number of workers. */
export function createLimiter(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (active >= concurrency) return
    const task = queue.shift()
    if (!task) return
    active++
    task()
  }
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
  }
}
