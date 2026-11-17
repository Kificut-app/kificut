/*
 * The in-app assistant: a chat panel that edits the project with the same tools the Claude
 * connector uses, powered by the user's own AI provider and API key. Keys never reach the
 * renderer; it only learns whether one is saved.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom'

export interface ProviderPreset {
  id: ProviderId
  name: string
  /** How Kificut talks to it. */
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  /** Whether the user can change the address. */
  editableUrl: boolean
  needsKey: boolean
  /** Used until the user picks one. Empty means the user has to choose. */
  defaultModel: string
  /** Where to get a key, or how to set the provider up. */
  helpUrl: string
  hint: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    editableUrl: false,
    needsKey: true,
    defaultModel: 'claude-opus-5-5',
    helpUrl: 'https://platform.claude.com/settings/keys',
    hint: 'Create a key in the Claude Console.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    editableUrl: false,
    needsKey: true,
    defaultModel: '',
    helpUrl: 'https://platform.openai.com/api-keys',
    hint: 'Create a key in the OpenAI dashboard.'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    editableUrl: false,
    needsKey: true,
    defaultModel: '',
    helpUrl: 'https://aistudio.google.com/apikey',
    hint: 'Create a key in Google AI Studio.'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    editableUrl: false,
    needsKey: true,
    defaultModel: '',
    helpUrl: 'https://openrouter.ai/keys',
    hint: 'One key for models from many providers.'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    editableUrl: true,
    needsKey: false,
    defaultModel: '',
    helpUrl: 'https://ollama.com/search?c=tools',
    hint: 'Runs models on this computer. Pick a model that supports tools.'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    editableUrl: true,
    needsKey: false,
    defaultModel: '',
    helpUrl: 'https://lmstudio.ai/docs/app/api/tools',
    hint: 'Start the local server in LM Studio first.'
  },
  {
    id: 'custom',
    name: 'Other (OpenAI compatible)',
    protocol: 'openai',
    baseUrl: '',
    editableUrl: true,
    needsKey: false,
    defaultModel: '',
    helpUrl: '',
    hint: 'Any server with an OpenAI style /chat/completions endpoint, for example vLLM or LiteLLM.'
  }
]

export function getProvider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** What the renderer sees of a provider's settings. */
export interface ProviderState {
  id: ProviderId
  baseUrl: string
  model: string
  hasKey: boolean
  /** False when the system has no secure storage, so the key is kept for this session only. */
  keyPersisted: boolean
}

export interface AssistantSettings {
  active: ProviderId | null
  providers: ProviderState[]
}

export interface ProviderUpdate {
  id: ProviderId
  baseUrl?: string
  model?: string
  /** A new key, or null to forget the saved one. Leave out to keep it. */
  apiKey?: string | null
}

export type AssistantEvent =
  | { type: 'start'; turnId: number }
  | { type: 'text'; turnId: number; text: string }
  | { type: 'tool-start'; turnId: number; callId: string; name: string; title: string }
  | { type: 'tool-end'; turnId: number; callId: string; ok: boolean; summary: string }
  | { type: 'notice'; turnId: number; message: string }
  | { type: 'done'; turnId: number; stopped: boolean }
  | { type: 'error'; turnId: number; message: string }

export const ASSISTANT_SYSTEM_PROMPT = `You are the assistant built into Kificut, a video editor. The user is chatting with you in a panel next to their timeline and can watch every change you make.

Edit with the tools. Look before you change things: call get_project first, and use inspect_media, analyze_media or view_frame when what you do depends on what the footage shows. Group related edits in one go so the user can undo them together, and keep the project tidy (sensible track use, no overlapping clips on a track unless intended).

Answer in short, plain sentences. After editing, say briefly what changed and where (times in seconds, track names). If a request is ambiguous or would remove a lot of work, ask first. Never invent media files: only use paths the user gave you or that list_media_files found.`
