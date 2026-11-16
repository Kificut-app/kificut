import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportProgress, ExportResult } from '@shared/export-formats'
import { buildRenderPlan, planToArgs, type OverlayImage } from '@shared/ffmpeg-graph'
import { IPC, type ExportRequest } from '@shared/ipc'
import { ffmpegMajorVersion, ffmpegPath, run } from './ffmpeg'

interface ActiveExport {
  child: ChildProcess | null
  cancelled: boolean
}

let active: ActiveExport | null = null

function friendlyError(stderr: string): string {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'FFmpeg stopped unexpectedly.'
  const permission = lines.find((l) => /permission denied/i.test(l))
  if (permission) return 'Kificut does not have permission to write to that location.'
  const space = lines.find((l) => /no space left/i.test(l))
  if (space) return 'The destination drive is out of space.'
  return lines.slice(-3).join('\n')
}

export async function startExport(request: ExportRequest, win: BrowserWindow | null): Promise<ExportResult> {
  if (active) return { ok: false, error: 'An export is already running.' }
  const job: ActiveExport = { child: null, cancelled: false }
  active = job

  const started = Date.now()
  const tempDir = await mkdtemp(join(app.getPath('temp'), 'kificut-export-'))
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  const outputPath = request.settings.outputPath

  try {
    const overlays: Record<string, OverlayImage> = {}
    for (const [clipId, overlay] of Object.entries(request.overlays)) {
      const path = join(tempDir, `text-${clipId}.png`)
      await writeFile(path, Buffer.from(overlay.png))
      overlays[clipId] = { path, width: overlay.width, height: overlay.height }
    }

    const plan = buildRenderPlan({ project: request.project, settings: request.settings, overlays })
    const scriptPath = join(tempDir, 'graph.txt')
    await writeFile(scriptPath, plan.filterGraph, 'utf8')
    const args = planToArgs(plan, scriptPath, outputPath, await ffmpegMajorVersion())

    let lastSent = 0
    let buffer = ''
    const send = (progress: ExportProgress) => {
      win?.webContents.send(IPC.exportProgress, progress)
      win?.setProgressBar(progress.progress)
    }
    send({ progress: 0, time: 0, speed: null, etaSeconds: null })

    const state: Record<string, string> = {}
    const result = await run(ffmpegPath(), args, {
      collectStdout: false,
      onSpawn: (child) => {
        job.child = child
        if (job.cancelled) child.kill()
      },
      onStdout: (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const eq = line.indexOf('=')
          if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1).trim()
          if (!line.startsWith('progress=')) continue

          const micros = parseInt(state.out_time_us ?? state.out_time_ms ?? '0', 10)
          const time = Number.isFinite(micros) ? Math.max(0, micros / 1e6) : 0
          const speed = parseFloat(state.speed ?? '') || null
          const progress = Math.min(0.999, time / plan.duration)
          const elapsed = (Date.now() - started) / 1000
          const etaSeconds = progress > 0.02 ? (elapsed / progress) * (1 - progress) : null
          if (Date.now() - lastSent > 120) {
            lastSent = Date.now()
            send({ progress, time, speed, etaSeconds })
          }
        }
      }
    })

    if (job.cancelled) {
      await rm(outputPath, { force: true })
      return { ok: false, cancelled: true }
    }
    if (result.code !== 0) {
      await rm(outputPath, { force: true })
      return { ok: false, error: friendlyError(result.stderr) }
    }
    send({ progress: 1, time: plan.duration, speed: null, etaSeconds: 0 })
    return { ok: true, outputPath, elapsed: (Date.now() - started) / 1000 }
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    powerSaveBlocker.stop(blocker)
    win?.setProgressBar(-1)
    active = null
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function cancelExport(): void {
  if (!active) return
  active.cancelled = true
  active.child?.kill()
}

export function isExporting(): boolean {
  return active !== null
}
