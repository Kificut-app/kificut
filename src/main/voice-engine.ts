import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { getLocalModel } from '@shared/models'
import { VOICE_CLONE_MODEL, type SpeechChunk, type VoiceSupport } from '@shared/voices'
import { modelsDir } from './models'

/*
 * Runs Chatterbox Turbo for custom voices in a utility process with the native ONNX Runtime. The
 * renderer's WebAssembly runtime cannot load Turbo's 4 bit weights and runs the full precision
 * model at a fraction of real time, so this model lives here instead. The process starts on the
 * first request and stops after a few idle minutes, which frees the 1.5 GB or so it holds.
 */

export type VoiceWorkerRequest = {
  id: number
  type: 'speak'
  /** The models folder, with forward slashes and a trailing slash. */
  modelsRoot: string
  repo: string
  dtype: string
  threads: number
  /** Changes when the recording changes, so the worker knows when to listen again. */
  voiceKey: string
  /** The reference recording as 24 kHz mono samples. */
  reference: Float32Array
  chunks: SpeechChunk[]
}

export type VoiceWorkerResponse =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'audio'; samples: Float32Array; sampleRate: number }
  | { id: number; type: 'error'; message: string }

const IDLE_MS = 3 * 60_000

export class VoiceCancelledError extends Error {
  constructor() {
    super('The voiceover was cancelled.')
  }
}

/**
 * Whether this build ships the native runtime for this computer. Intel Macs are left out on
 * purpose: onnxruntime-node 1.30 has no build for them.
 */
export function voiceSupport(): VoiceSupport {
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { supported: false, reason: 'Custom voices need a Mac with Apple silicon for now.' }
  }
  try {
    const root = dirname(require.resolve('onnxruntime-node/package.json'))
    const binding = join(root, 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node')
    if (existsSync(binding)) return { supported: true }
  } catch {
    // Not shipped in this build.
  }
  return { supported: false, reason: 'Custom voices are not available on this kind of computer yet.' }
}

interface Pending {
  resolve: (response: Extract<VoiceWorkerResponse, { type: 'audio' }>) => void
  reject: (error: Error) => void
  onStatus?: (message: string) => void
}

class VoiceEngine {
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  /** Requests run one after another; Chatterbox already uses every core it is given. */
  private queue: Promise<unknown> = Promise.resolve()
  private cancelled = false

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(join(__dirname, 'voice-worker.js'), [], {
      serviceName: 'Kificut Voices',
      stdio: 'pipe',
      // macOS starts it from the plugin helper, which may load the runtime's libraries.
      allowLoadingUnsignedLibraries: process.platform === 'darwin'
    })
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[voices] ${chunk}`))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[voices] ${chunk}`))
    child.on('message', (message: VoiceWorkerResponse) => {
      const call = this.pending.get(message.id)
      if (!call) return
      if (message.type === 'status') {
        call.onStatus?.(message.message)
        return
      }
      this.pending.delete(message.id)
      if (message.type === 'error') call.reject(new Error(message.message))
      else call.resolve(message)
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      const error = this.cancelled
        ? new VoiceCancelledError()
        : new Error(`The voice engine stopped unexpectedly (exit code ${code}).`)
      for (const call of this.pending.values()) call.reject(error)
      this.pending.clear()
    })
    this.child = child
    return child
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stop()
    }, IDLE_MS)
  }

  speak(
    request: Omit<VoiceWorkerRequest, 'id' | 'type'>,
    onStatus?: (message: string) => void
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    const run = async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.cancelled = false
      const id = this.nextId++
      try {
        const response = await new Promise<Extract<VoiceWorkerResponse, { type: 'audio' }>>(
          (resolve, reject) => {
            this.pending.set(id, { resolve, reject, onStatus })
            this.ensureChild().postMessage({ ...request, id, type: 'speak' } satisfies VoiceWorkerRequest)
          }
        )
        return { samples: response.samples, sampleRate: response.sampleRate }
      } finally {
        this.scheduleIdleStop()
      }
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  /** Stops the voiceover being made. The process starts again for the next one. */
  cancel(): void {
    if (!this.child) return
    this.cancelled = true
    this.child.kill()
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.child?.kill()
    this.child = null
  }
}

const engine = new VoiceEngine()

/** Speaks sentence sized chunks in the voice of a reference recording. */
export function speakChunks(
  reference: Float32Array,
  voiceKey: string,
  chunks: SpeechChunk[],
  onStatus?: (message: string) => void
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const model = getLocalModel(VOICE_CLONE_MODEL)!
  return engine.speak(
    {
      modelsRoot: `${modelsDir().replace(/\\/g, '/').replace(/\/?$/, '/')}`,
      repo: model.repo,
      dtype: model.dtype ?? 'q4',
      // Leave a core for the interface and playback.
      threads: Math.max(1, availableParallelism() - 1),
      voiceKey,
      reference,
      chunks
    },
    onStatus
  )
}

export function cancelVoiceEngine(): void {
  engine.cancel()
}

/** Stops the process, for example before the model's files are removed. */
export function stopVoiceEngine(): void {
  engine.stop()
}
