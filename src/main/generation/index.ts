import { app, BrowserWindow, dialog, ipcMain, net } from 'electron'
import { createWriteStream } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  getService,
  type GenerationJob,
  type GenerationRequest,
  type GenerationService,
  type GenerationSettings,
  type GenerationSettingsUpdate,
  type ModelCapabilities
} from '@shared/generation'
import { IPC } from '@shared/ipc'
import { canEncrypt, decryptSecret, encryptSecret, readApiKey, updateProvider } from '../assistant/settings'
import { generatedPath } from '../media'
import { comfyui } from './comfyui'
import { fal } from './fal'
import { google } from './google'
import { ServiceError, type Adapter, type RunContext } from './types'

/*
 * Runs generation jobs in the main process, where the keys are. Jobs keep running in the
 * background; the renderer hears about each step and imports the file when it is done.
 */

const ADAPTERS: Record<GenerationService, Adapter> = { google, fal, comfyui }
const MAX_PROMPT = 4000

interface StoredSettings {
  falKey?: string
  comfyuiUrl?: string
  comfyuiVideoWorkflow?: string
  comfyuiImageWorkflow?: string
}

let cache: StoredSettings | null = null
let sessionFalKey: string | null = null
const jobs = new Map<number, { job: GenerationJob; controller: AbortController }>()
let nextJob = 1

function settingsPath(): string {
  return join(app.getPath('userData'), 'generation.json')
}

async function load(): Promise<StoredSettings> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
  } catch {
    cache = {}
  }
  return cache
}

async function save(next: StoredSettings): Promise<void> {
  cache = next
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
}

async function falKey(): Promise<string | null> {
  if (sessionFalKey) return sessionFalKey
  const stored = (await load()).falKey
  return stored ? decryptSecret(stored) : null
}

export async function generationSettings(): Promise<GenerationSettings> {
  const stored = await load()
  return {
    // Google's key is the Gemini key the assistant uses.
    googleKey: Boolean(readApiKey('gemini')),
    falKey: Boolean(await falKey()),
    keysPersisted: canEncrypt(),
    comfyuiUrl: stored.comfyuiUrl ?? 'http://127.0.0.1:8188',
    comfyuiVideoWorkflow: stored.comfyuiVideoWorkflow ?? '',
    comfyuiImageWorkflow: stored.comfyuiImageWorkflow ?? ''
  }
}

async function updateSettings(update: GenerationSettingsUpdate): Promise<GenerationSettings> {
  const stored = { ...(await load()) }
  if (update.googleKey !== undefined) updateProvider({ id: 'gemini', apiKey: update.googleKey })
  if (update.falKey !== undefined) {
    sessionFalKey = null
    delete stored.falKey
    const key = update.falKey?.trim()
    if (key) {
      const encrypted = encryptSecret(key)
      if (encrypted) stored.falKey = encrypted
      else sessionFalKey = key
    }
  }
  if (update.comfyuiUrl !== undefined) {
    const url = update.comfyuiUrl.trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\/[^\s]+$/i.test(url))
      throw new Error('The address must start with http:// or https://.')
    stored.comfyuiUrl = url
  }
  if (update.comfyuiVideoWorkflow !== undefined) stored.comfyuiVideoWorkflow = update.comfyuiVideoWorkflow
  if (update.comfyuiImageWorkflow !== undefined) stored.comfyuiImageWorkflow = update.comfyuiImageWorkflow
  await save(stored)
  return generationSettings()
}

async function context(
  service: GenerationService,
  signal: AbortSignal,
  progress: RunContext['progress']
): Promise<RunContext> {
  const settings = await generationSettings()
  return {
    fetch: (url, init) => net.fetch(url, init),
    signal,
    progress,
    apiKey: service === 'google' ? readApiKey('gemini') : service === 'fal' ? await falKey() : null,
    comfyui: {
      url: settings.comfyuiUrl,
      videoWorkflow: settings.comfyuiVideoWorkflow,
      imageWorkflow: settings.comfyuiImageWorkflow
    }
  }
}

function adapterFor(service: string): Adapter {
  const adapter = ADAPTERS[service as GenerationService]
  if (!adapter) throw new Error('Unknown generation service.')
  return adapter
}

function validate(request: GenerationRequest): GenerationRequest {
  adapterFor(request.service)
  const prompt = String(request.prompt ?? '').trim()
  if (!prompt) throw new Error('Describe what to generate.')
  return {
    ...request,
    prompt: prompt.slice(0, MAX_PROMPT),
    model: String(request.model ?? '').trim(),
    duration: Math.max(1, Math.min(60, Number(request.duration) || 5))
  }
}

function broadcast(job: GenerationJob): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.generationEvent, { ...job })
}

function fileName(request: GenerationRequest, extension: string): string {
  const words = request.prompt
    .replace(/[^\w\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return `${request.kind === 'video' ? 'Scene' : 'Picture'} - ${words || 'generated'}${extension}`
}

async function saveResult(
  request: GenerationRequest,
  result: Awaited<ReturnType<Adapter['run']>>,
  signal: AbortSignal
): Promise<string> {
  const target = await generatedPath(fileName(request, result.extension))
  if (result.data) {
    await writeFile(target, result.data)
    return target
  }
  const response = await net.fetch(result.url!, { headers: result.headers, signal })
  if (!response.ok || !response.body)
    throw new ServiceError(`Downloading the result failed (HTTP ${response.status}).`)
  const partial = `${target}.part`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial))
    await rename(partial, target)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
  return target
}

async function start(raw: GenerationRequest): Promise<GenerationJob> {
  const request = validate(raw)
  const adapter = adapterFor(request.service)
  const controller = new AbortController()
  const job: GenerationJob = {
    id: nextJob++,
    kind: request.kind,
    prompt: request.prompt,
    service: request.service,
    model: request.model,
    state: 'running',
    message: 'Starting',
    progress: null,
    path: null,
    error: null,
    startedAt: Date.now(),
    estimate: ''
  }
  jobs.set(job.id, { job, controller })
  const update = (patch: Partial<GenerationJob>) => {
    Object.assign(job, patch)
    broadcast(job)
  }
  const ctx = await context(request.service, controller.signal, (message, fraction) =>
    update({ message, progress: fraction ?? null })
  )
  job.estimate = await adapter.estimate(request, ctx).catch(() => '')
  broadcast(job)

  void (async () => {
    try {
      const result = await adapter.run(request, ctx)
      update({ message: 'Downloading the result', progress: null })
      const path = await saveResult(request, result, controller.signal)
      update({ state: 'done', message: 'Done', path })
    } catch (error) {
      if (controller.signal.aborted) update({ state: 'cancelled', message: 'Cancelled' })
      else
        update({
          state: 'failed',
          message: 'Failed',
          error: error instanceof Error ? error.message : String(error)
        })
    }
  })()
  return { ...job }
}

async function capabilities(service: GenerationService, model: string): Promise<ModelCapabilities> {
  const ctx = await context(service, AbortSignal.timeout(30_000), () => undefined)
  return adapterFor(service).capabilities(model, ctx)
}

async function estimate(raw: GenerationRequest): Promise<string> {
  const request = validate({ ...raw, prompt: raw.prompt || 'estimate' })
  const ctx = await context(request.service, AbortSignal.timeout(15_000), () => undefined)
  return adapterFor(request.service).estimate(request, ctx)
}

/** Checks that a service answers with the saved key or address. */
async function test(service: GenerationService): Promise<string> {
  const ctx = await context(service, AbortSignal.timeout(15_000), () => undefined)
  const name = getService(service)?.name ?? service
  if (service === 'comfyui') {
    const response = await ctx
      .fetch(`${ctx.comfyui!.url}/system_stats`, { signal: ctx.signal })
      .catch(() => null)
    if (!response?.ok) throw new Error(`Could not reach ComfyUI at ${ctx.comfyui!.url}. Is it running?`)
    const stats = (await response.json()) as { devices?: Array<{ name?: string }> }
    return `Connected${stats.devices?.[0]?.name ? ` (${stats.devices[0].name})` : ''}.`
  }
  if (!ctx.apiKey) throw new Error(`Add your ${name} key first.`)
  if (service === 'google') {
    const base = process.env.KIFICUT_GOOGLE_API || 'https://generativelanguage.googleapis.com'
    const response = await ctx.fetch(`${base}/v1beta/models?pageSize=1`, {
      headers: { 'x-goog-api-key': ctx.apiKey },
      signal: ctx.signal
    })
    if (!response.ok)
      throw new Error(
        response.status === 400 || response.status === 403
          ? 'Google did not accept the key.'
          : `Google returned HTTP ${response.status}.`
      )
    return 'Connected.'
  }
  // Asking for a price costs nothing and needs a valid key.
  const base = process.env.KIFICUT_FAL_API || 'https://api.fal.ai/v1'
  const response = await ctx
    .fetch(`${base}/models/pricing?endpoint_id=fal-ai%2Fflux%2Fschnell`, {
      headers: { Authorization: `Key ${ctx.apiKey}` },
      signal: ctx.signal
    })
    .catch(() => null)
  if (!response) throw new Error('Could not reach fal.ai. Check your internet connection.')
  if (response.status === 401 || response.status === 403) throw new Error('fal.ai did not accept the key.')
  if (!response.ok) throw new Error(`fal.ai returned HTTP ${response.status}.`)
  return 'Connected.'
}

export function registerGenerationIpc(): void {
  ipcMain.handle(IPC.generationSettings, () => generationSettings())
  ipcMain.handle(IPC.generationUpdate, (_event, update: GenerationSettingsUpdate) => updateSettings(update))
  ipcMain.handle(IPC.generationCapabilities, (_event, service: GenerationService, model: string) =>
    capabilities(service, model)
  )
  ipcMain.handle(IPC.generationEstimate, (_event, request: GenerationRequest) => estimate(request))
  ipcMain.handle(IPC.generationStart, (_event, request: GenerationRequest) => start(request))
  ipcMain.handle(IPC.generationCancel, (_event, id: number) => jobs.get(id)?.controller.abort())
  ipcMain.handle(IPC.generationJobs, () => [...jobs.values()].map(({ job }) => ({ ...job })))
  ipcMain.handle(IPC.generationTest, (_event, service: GenerationService) => test(service))
  ipcMain.handle(IPC.generationPickWorkflow, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose a ComfyUI workflow (API format)',
      filters: [{ name: 'Workflow', extensions: ['json'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
