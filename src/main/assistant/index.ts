import { ipcMain, type WebContents } from 'electron'
import { AI_INSTRUCTIONS } from '@shared/ai-tools'
import {
  ASSISTANT_SYSTEM_PROMPT,
  getProvider,
  type AssistantEvent,
  type ProviderId,
  type ProviderUpdate
} from '@shared/assistant'
import { IPC } from '@shared/ipc'
import { callTool } from '../connector'
import { AnthropicSession, describeAnthropicError, listAnthropicModels } from './anthropic'
import { listOpenAiModels, OpenAiSession } from './openai'
import {
  getAssistantSettings,
  getProviderState,
  readApiKey,
  setActiveProvider,
  updateProvider
} from './settings'
import type { ModelChoice, ProviderSession } from './types'

/*
 * Runs the assistant chat. The provider loop lives here, in the main process, so API keys never
 * reach the renderer; tool calls go to the renderer through the same path as the Claude connector.
 */

const SYSTEM = `${ASSISTANT_SYSTEM_PROMPT}\n\n${AI_INSTRUCTIONS}`

let session: { provider: ProviderId; impl: ProviderSession } | null = null
let running: { controller: AbortController; turnId: number } | null = null
let nextTurn = 1

function resetSession(): void {
  running?.controller.abort()
  session = null
}

function sessionFor(provider: ProviderId): ProviderSession {
  if (session?.provider !== provider) {
    const preset = getProvider(provider)!
    session = {
      provider,
      impl: preset.protocol === 'anthropic' ? new AnthropicSession() : new OpenAiSession()
    }
  }
  return session.impl
}

function describe(error: unknown): string {
  return describeAnthropicError(error) ?? (error instanceof Error ? error.message : String(error))
}

async function send(sender: WebContents, text: string): Promise<number> {
  if (running) throw new Error('The assistant is still working on the last message.')
  const { active } = getAssistantSettings()
  if (!active) throw new Error('Choose an AI provider in the assistant settings first.')
  const preset = getProvider(active)!
  const state = getProviderState(active)
  const apiKey = readApiKey(active)
  if (preset.needsKey && !apiKey)
    throw new Error(`Add your ${preset.name} API key in the assistant settings.`)

  const turnId = nextTurn++
  const controller = new AbortController()
  running = { controller, turnId }
  const emit = (event: AssistantEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC.assistantEvent, event)
  }
  emit({ type: 'start', turnId })

  void sessionFor(active)
    .run({
      apiKey,
      baseUrl: state.baseUrl,
      model: state.model,
      system: SYSTEM,
      userText: text,
      signal: controller.signal,
      callTool,
      emit: (event) => emit({ ...event, turnId } as AssistantEvent)
    })
    .then(() => emit({ type: 'done', turnId, stopped: false }))
    .catch((error: unknown) => {
      if (controller.signal.aborted) emit({ type: 'done', turnId, stopped: true })
      else emit({ type: 'error', turnId, message: describe(error) })
    })
    .finally(() => {
      if (running?.turnId === turnId) running = null
    })
  return turnId
}

async function listModels(id: ProviderId): Promise<ModelChoice[]> {
  const preset = getProvider(id)
  if (!preset) throw new Error('Unknown provider.')
  const state = getProviderState(id)
  const apiKey = readApiKey(id)
  if (preset.needsKey && !apiKey) throw new Error(`Add your ${preset.name} API key first.`)
  try {
    if (preset.protocol === 'anthropic') return await listAnthropicModels(apiKey!, state.baseUrl)
    if (!state.baseUrl) throw new Error('Enter the address of the server first.')
    return await listOpenAiModels(state.baseUrl, apiKey)
  } catch (error) {
    throw new Error(describe(error), { cause: error })
  }
}

export function registerAssistantIpc(): void {
  ipcMain.handle(IPC.assistantSettings, () => getAssistantSettings())
  ipcMain.handle(IPC.assistantUpdateProvider, (_event, update: ProviderUpdate) => {
    const before = getProviderState(update.id)
    const settings = updateProvider(update)
    const after = getProviderState(update.id)
    // A different model or server starts a new conversation.
    if (
      session?.provider === update.id &&
      (before.model !== after.model || before.baseUrl !== after.baseUrl)
    ) {
      resetSession()
    }
    return settings
  })
  ipcMain.handle(IPC.assistantSetActive, (_event, id: ProviderId | null) => {
    if (session && session.provider !== id) resetSession()
    return setActiveProvider(id)
  })
  ipcMain.handle(IPC.assistantListModels, (_event, id: ProviderId) => listModels(id))
  ipcMain.handle(IPC.assistantSend, (event, text: string) => {
    const message = String(text ?? '').trim()
    if (!message) throw new Error('Type a message first.')
    return send(event.sender, message.slice(0, 20000))
  })
  ipcMain.handle(IPC.assistantStop, () => running?.controller.abort())
  ipcMain.handle(IPC.assistantReset, () => {
    running?.controller.abort()
    session?.impl.reset()
  })
}
