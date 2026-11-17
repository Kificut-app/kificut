import type { ToolResult } from '@shared/ai-tools'
import type { AssistantEvent } from '@shared/assistant'

type WithoutTurn<T> = T extends unknown ? Omit<T, 'turnId'> : never

export interface TurnContext {
  apiKey: string | null
  baseUrl: string
  model: string
  system: string
  userText: string
  signal: AbortSignal
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  emit: (event: WithoutTurn<AssistantEvent>) => void
}

/** One conversation with one provider. It keeps the history in the provider's own format. */
export interface ProviderSession {
  run(ctx: TurnContext): Promise<void>
  reset(): void
}

export interface ModelChoice {
  id: string
  name: string
}
