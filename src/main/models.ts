import { app, BrowserWindow, net } from 'electron'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { getLocalModel, LOCAL_MODELS, type LocalModelInfo, type ModelStatus } from '@shared/models'
import {
  downloadVerified,
  HttpError,
  retrying,
  startHash,
  type DownloadTarget,
  type FetchLike
} from './download'

/*
 * Downloads, verifies and removes local AI models. Files go to <userData>/models, laid out like the
 * Hugging Face repositories so transformers.js can load them by repository id.
 */

type PlannedFile = DownloadTarget

const fetchWithNet: FetchLike = (url, init) => net.fetch(url, init)

interface MarkerFile {
  revision: string
  installedAt: string
}

interface TreeEntry {
  type: string
  path: string
  size: number
  oid: string
  lfs?: { oid: string; size: number }
}

const MARKER = '.kificut-model.json'
const active = new Map<string, { controller: AbortController; status: ModelStatus }>()
/** The last failed install of each model, so the error is still shown after the window reloads. */
const failures = new Map<string, string>()

export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

function repoDir(model: LocalModelInfo): string {
  return join(modelsDir(), ...model.repo.split('/'))
}

function broadcast(status: ModelStatus): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.modelsStatus, status)
}

async function folderSize(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await folderSize(full)
    else total += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}

async function readMarker(model: LocalModelInfo): Promise<MarkerFile | null> {
  try {
    return JSON.parse(await readFile(join(repoDir(model), MARKER), 'utf8')) as MarkerFile
  } catch {
    return null
  }
}

export async function modelStatus(id: string): Promise<ModelStatus> {
  const model = getLocalModel(id)
  if (!model) return { id, state: 'error', received: 0, total: 0, size: 0, error: 'Unknown model.' }
  const running = active.get(id)
  if (running) return running.status
  const marker = await readMarker(model)
  if (marker?.revision === model.revision) {
    const extras = await Promise.all(
      model.extras.map((e) => stat(join(modelsDir(), e.path)).catch(() => null))
    )
    if (extras.every(Boolean)) {
      // Extras stored inside the model's own folder are already counted.
      const outside = model.extras
        .map((e, i) => (e.path.startsWith(`${model.repo}/`) ? 0 : (extras[i]?.size ?? 0)))
        .reduce((sum, n) => sum + n, 0)
      const size = (await folderSize(repoDir(model))) + outside
      return { id, state: 'installed', received: 0, total: 0, size }
    }
  }
  const error = failures.get(id)
  if (error) return { id, state: 'error', received: 0, total: 0, size: 0, error }
  return { id, state: 'not-installed', received: 0, total: 0, size: 0 }
}

export async function listModelStatus(): Promise<ModelStatus[]> {
  return Promise.all(LOCAL_MODELS.map((m) => modelStatus(m.id)))
}

function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  return retrying(async () => {
    const response = await net.fetch(url, { signal })
    if (!response.ok) throw new HttpError(`${url} returned HTTP ${response.status}`, response.status)
    return (await response.json()) as T
  }, signal)
}

async function plan(model: LocalModelInfo, signal: AbortSignal): Promise<PlannedFile[]> {
  // Models from elsewhere come only as pinned extras.
  const tree =
    model.files.length === 0
      ? []
      : await fetchJson<TreeEntry[]>(
          `https://huggingface.co/api/models/${model.repo}/tree/${model.revision}?recursive=true`,
          signal
        )
  const byPath = new Map(tree.filter((e) => e.type === 'file').map((e) => [e.path, e]))
  const files: PlannedFile[] = model.files.map((path) => {
    const entry = byPath.get(path)
    if (!entry) throw new Error(`${model.repo} has no file ${path} at the pinned revision.`)
    return {
      url: `https://huggingface.co/${model.repo}/resolve/${model.revision}/${path}`,
      dest: join(repoDir(model), ...path.split('/')),
      size: entry.lfs?.size ?? entry.size,
      digest: entry.lfs?.oid ?? entry.oid,
      kind: entry.lfs ? 'sha256' : 'git-blob'
    }
  })
  for (const extra of model.extras) {
    files.push({
      url: extra.url,
      dest: join(modelsDir(), ...extra.path.split('/')),
      size: extra.size,
      digest: extra.sha256,
      kind: 'sha256'
    })
  }
  return files
}

async function verifyExisting(file: PlannedFile): Promise<boolean> {
  const info = await stat(file.dest).catch(() => null)
  if (!info || info.size !== file.size) return false
  const hash = startHash(file)
  hash.update(await readFile(file.dest))
  return hash.digest('hex') === file.digest
}

export async function installModel(id: string): Promise<ModelStatus> {
  const model = getLocalModel(id)
  if (!model) throw new Error('Unknown model.')
  const running = active.get(id)
  if (running) return running.status

  failures.delete(id)
  const controller = new AbortController()
  const status: ModelStatus = { id, state: 'downloading', received: 0, total: model.approximateSize, size: 0 }
  active.set(id, { controller, status })
  broadcast(status)

  let lastSent = 0
  const report = (force = false) => {
    if (force || Date.now() - lastSent > 200) {
      lastSent = Date.now()
      broadcast({ ...status })
    }
  }

  void (async () => {
    try {
      const files = await plan(model, controller.signal)
      status.total = files.reduce((sum, f) => sum + f.size, 0)
      for (const file of files) {
        if (await verifyExisting(file)) {
          status.received += file.size
          report()
          continue
        }
        await downloadVerified(file, fetchWithNet, controller.signal, (n) => {
          status.received += n
          report()
        })
      }
      const marker: MarkerFile = { revision: model.revision, installedAt: new Date().toISOString() }
      await writeFile(join(repoDir(model), MARKER), JSON.stringify(marker, null, 2))
      active.delete(id)
      broadcast(await modelStatus(id))
    } catch (error) {
      active.delete(id)
      if (!controller.signal.aborted) failures.set(id, describeError(error))
      broadcast(await modelStatus(id))
    }
  })()

  return { ...status }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK_CHANGED|ERR_TIMED_OUT/.test(
      message
    )
  ) {
    return 'Could not reach the download server. Check your internet connection and try again.'
  }
  if (/ENOSPC/.test(message)) return 'There is not enough free disk space for this model.'
  return message
}

export function cancelModelInstall(id: string): void {
  active.get(id)?.controller.abort()
}

export async function removeModel(id: string): Promise<ModelStatus> {
  const model = getLocalModel(id)
  if (!model) throw new Error('Unknown model.')
  cancelModelInstall(id)
  failures.delete(id)
  await rm(repoDir(model), { recursive: true, force: true })
  for (const extra of model.extras) {
    const usedElsewhere = LOCAL_MODELS.some((m) => m.id !== id && m.extras.some((e) => e.path === extra.path))
    if (!usedElsewhere) await rm(join(modelsDir(), ...extra.path.split('/')), { force: true })
  }
  const status = await modelStatus(id)
  broadcast(status)
  return status
}

export function isModelInstalled(id: string): Promise<boolean> {
  return modelStatus(id).then((s) => s.state === 'installed')
}
