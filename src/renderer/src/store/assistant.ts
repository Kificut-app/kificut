import { create } from 'zustand'
import { AI_TOOLS } from '@shared/ai-tools'
import { getProvider, type AssistantEvent, type AssistantSettings } from '@shared/assistant'
import { errorText } from './actions'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; turnId: number; text: string }
  | { kind: 'tool'; id: string; title: string; state: 'running' | 'ok' | 'error'; summary: string }
  | { kind: 'notice'; id: string; text: string; error?: boolean }

interface AssistantState {
  items: ChatItem[]
  busy: boolean
  settings: AssistantSettings | null
  draft: string
}

export const useAssistant = create<AssistantState>(() => ({
  items: [],
  busy: false,
  settings: null,
  draft: ''
}))

const TITLES = new Map(AI_TOOLS.map((t) => [t.name, t.title]))
let nextItem = 1
const itemId = () => `item-${nextItem++}`

function push(item: ChatItem): void {
  useAssistant.setState((s) => ({ items: [...s.items, item] }))
}

function onEvent(event: AssistantEvent): void {
  switch (event.type) {
    case 'start':
      useAssistant.setState({ busy: true })
      break
    case 'text':
      useAssistant.setState((s) => {
        const last = s.items[s.items.length - 1]
        if (last?.kind === 'assistant' && last.turnId === event.turnId) {
          return { items: [...s.items.slice(0, -1), { ...last, text: last.text + event.text }] }
        }
        return {
          items: [...s.items, { kind: 'assistant', id: itemId(), turnId: event.turnId, text: event.text }]
        }
      })
      break
    case 'tool-start':
      push({
        kind: 'tool',
        id: event.callId,
        title: TITLES.get(event.name) ?? event.title,
        state: 'running',
        summary: ''
      })
      break
    case 'tool-end':
      useAssistant.setState((s) => ({
        items: s.items.map((item) =>
          item.kind === 'tool' && item.id === event.callId
            ? { ...item, state: event.ok ? 'ok' : 'error', summary: event.summary }
            : item
        )
      }))
      break
    case 'notice':
      push({ kind: 'notice', id: itemId(), text: event.message })
      break
    case 'error':
      push({ kind: 'notice', id: itemId(), text: event.message, error: true })
      useAssistant.setState({ busy: false })
      break
    case 'done':
      if (event.stopped) push({ kind: 'notice', id: itemId(), text: 'Stopped.' })
      useAssistant.setState({ busy: false })
      break
  }
}

let started = false

export function startAssistantSync(): void {
  if (started) return
  started = true
  window.kificut.assistant.onEvent(onEvent)
  void refreshAssistantSettings()
}

export async function refreshAssistantSettings(): Promise<void> {
  useAssistant.setState({ settings: await window.kificut.assistant.settings() })
}

export async function sendToAssistant(text: string): Promise<void> {
  const message = text.trim()
  if (!message || useAssistant.getState().busy) return
  push({ kind: 'user', id: itemId(), text: message })
  useAssistant.setState({ draft: '', busy: true })
  try {
    await window.kificut.assistant.send(message)
  } catch (error) {
    push({ kind: 'notice', id: itemId(), text: errorText(error), error: true })
    useAssistant.setState({ busy: false })
  }
}

export function stopAssistant(): void {
  void window.kificut.assistant.stop()
}

export function newChat(): void {
  void window.kificut.assistant.reset()
  useAssistant.setState({ items: [], busy: false })
}

/** "Claude Opus 5.5 via Anthropic" style label for the active provider, or null. */
export function activeLabel(settings: AssistantSettings | null): string | null {
  if (!settings?.active) return null
  const preset = getProvider(settings.active)
  const state = settings.providers.find((p) => p.id === settings.active)
  if (!preset || !state) return null
  return state.model ? `${state.model} · ${preset.name}` : preset.name
}
