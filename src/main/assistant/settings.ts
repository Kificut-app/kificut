import { app, safeStorage } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getProvider,
  PROVIDERS,
  type AssistantSettings,
  type ProviderId,
  type ProviderState,
  type ProviderUpdate
} from '@shared/assistant'

/*
 * Provider settings and API keys for the assistant. Keys are encrypted with the operating system's
 * key store (Keychain on macOS, DPAPI on Windows) before they touch the disk, and are only ever
 * decrypted in the main process.
 */

interface StoredProvider {
  baseUrl?: string
  model?: string
  /** Base64 of the encrypted key. */
  key?: string
}

interface StoredSettings {
  active: ProviderId | null
  providers: Partial<Record<ProviderId, StoredProvider>>
}

/** Keys entered on systems without a secure key store live here until Kificut quits. */
const sessionKeys = new Map<ProviderId, string>()
let cache: StoredSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'assistant.json')
}

function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // On Linux without a keyring Electron falls back to a fixed password, which protects nothing.
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.()
    if (backend === 'basic_text' || backend === 'unknown') return false
  }
  return true
}

function load(): StoredSettings {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as StoredSettings
    cache = {
      active: parsed.active && getProvider(parsed.active) ? parsed.active : null,
      providers: parsed.providers ?? {}
    }
  } catch {
    cache = { active: null, providers: {} }
  }
  return cache
}

function save(settings: StoredSettings): void {
  cache = settings
  const path = settingsPath()
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

function stateOf(id: ProviderId, settings: StoredSettings): ProviderState {
  const preset = getProvider(id)!
  const stored = settings.providers[id] ?? {}
  return {
    id,
    baseUrl: preset.editableUrl ? (stored.baseUrl ?? preset.baseUrl) : preset.baseUrl,
    model: stored.model ?? preset.defaultModel,
    hasKey: Boolean(stored.key) || sessionKeys.has(id),
    keyPersisted: canEncrypt()
  }
}

export function getAssistantSettings(): AssistantSettings {
  const settings = load()
  return { active: settings.active, providers: PROVIDERS.map((p) => stateOf(p.id, settings)) }
}

export function getProviderState(id: ProviderId): ProviderState {
  return stateOf(id, load())
}

export function updateProvider(update: ProviderUpdate): AssistantSettings {
  const preset = getProvider(update.id)
  if (!preset) throw new Error('Unknown provider.')
  const settings = load()
  const stored: StoredProvider = { ...(settings.providers[update.id] ?? {}) }

  if (update.baseUrl !== undefined && preset.editableUrl) {
    const url = update.baseUrl.trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\/[^\s]+$/i.test(url))
      throw new Error('The address must start with http:// or https://.')
    stored.baseUrl = url
  }
  if (update.model !== undefined) stored.model = update.model.trim()
  if (update.apiKey !== undefined) {
    sessionKeys.delete(update.id)
    delete stored.key
    const key = update.apiKey?.trim()
    if (key) {
      if (canEncrypt()) stored.key = safeStorage.encryptString(key).toString('base64')
      else sessionKeys.set(update.id, key)
    }
  }

  save({ ...settings, providers: { ...settings.providers, [update.id]: stored } })
  return getAssistantSettings()
}

export function setActiveProvider(id: ProviderId | null): AssistantSettings {
  if (id !== null && !getProvider(id)) throw new Error('Unknown provider.')
  save({ ...load(), active: id })
  return getAssistantSettings()
}

/** The decrypted key, for the main process only. */
export function readApiKey(id: ProviderId): string | null {
  const session = sessionKeys.get(id)
  if (session) return session
  const stored = load().providers[id]?.key
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // The key store changed (for example a new user account); the key has to be entered again.
    return null
  }
}
