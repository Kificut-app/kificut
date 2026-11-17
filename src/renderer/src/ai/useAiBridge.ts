import { useEffect } from 'react'
import { AI_TOOLS } from '@shared/ai-tools'
import type { AiCall } from '@shared/ipc'
import type { AiStatus } from '@shared/types'
import { setAiState, toast, useUi } from '../store/ui'
import { runTool } from './tools'

const TITLES = new Map(AI_TOOLS.map((t) => [t.name, t.title]))

/**
 * Receives tool calls from a connected assistant and runs them one at a time, so edits never
 * interleave. Also keeps the connection status shown in the top bar up to date.
 */
export function useAiBridge(): void {
  useEffect(() => {
    const queue: AiCall[] = []
    let running = false

    const runNext = async (): Promise<void> => {
      if (running) return
      const call = queue.shift()
      if (!call) return
      running = true
      setAiState({ activity: TITLES.get(call.name) ?? call.name })
      const result = await runTool(call.name, call.args)
      window.kificut.ai.respond(call.callId, result)
      running = false
      setAiState({ activity: queue.length ? useUi.getState().ai.activity : null })
      void runNext()
    }

    const onStatus = (status: AiStatus) => {
      const previous = useUi.getState().ai.status
      setAiState({ status })
      if (status.connected && !previous?.connected) {
        toast({
          kind: 'info',
          title: `${status.client ?? 'An assistant'} connected`,
          message: 'It can now edit in Kificut. Every change can be undone.'
        })
      }
    }

    const offCall = window.kificut.ai.onCall((call) => {
      queue.push(call)
      void runNext()
    })
    const offStatus = window.kificut.ai.onStatus(onStatus)
    void window.kificut.ai.status().then((status) => {
      setAiState({ status })
    })
    window.kificut.ai.ready()

    return () => {
      offCall()
      offStatus()
    }
  }, [])
}
