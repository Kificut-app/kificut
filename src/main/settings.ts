import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppSettings, RecentProject } from '@shared/types'

const DEFAULTS: AppSettings = {
  ffmpegPath: '',
  ffprobePath: '',
  autosave: true,
  autosaveMinutes: 3,
  proxyAboveHeight: 0,
  previewScale: 1,
  showWaveforms: true,
  showThumbnails: true,
  connectorEnabled: true,
  autoUpdate: true
}

const MAX_RECENT = 12

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Writes through a temp file so a crash never leaves a half written file behind. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

let cached: AppSettings | null = null

export function getSettings(): AppSettings {
  if (!cached) cached = { ...DEFAULTS, ...readJson<Partial<AppSettings>>('settings.json', {}) }
  return cached
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  cached = { ...getSettings(), ...patch }
  writeJsonAtomic(filePath('settings.json'), cached)
  return cached
}

export function getRecentProjects(): RecentProject[] {
  const list = readJson<RecentProject[]>('recent.json', [])
  return Array.isArray(list) ? list.filter((r) => existsSync(r.path)) : []
}

export function addRecentProject(path: string, name?: string): RecentProject[] {
  const entry: RecentProject = {
    path,
    name: name || basename(path).replace(/\.[^.]+$/, ''),
    openedAt: new Date().toISOString()
  }
  const list = [entry, ...getRecentProjects().filter((r) => r.path !== path)].slice(0, MAX_RECENT)
  writeJsonAtomic(filePath('recent.json'), list)
  app.addRecentDocument(path)
  return list
}

export function removeRecentProject(path: string): RecentProject[] {
  const list = getRecentProjects().filter((r) => r.path !== path)
  writeJsonAtomic(filePath('recent.json'), list)
  return list
}
