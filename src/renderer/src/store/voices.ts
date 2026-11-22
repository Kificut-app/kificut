import { create } from 'zustand'
import type { CustomVoice, VoiceSupport } from '@shared/voices'

/** The user's own voices and whether this computer can speak them, kept in sync with the main process. */
export const useVoices = create<{ voices: CustomVoice[]; support: VoiceSupport | null }>(() => ({
  voices: [],
  support: null
}))

let started = false

export function startVoiceSync(): void {
  if (started) return
  started = true
  void window.kificut.voices.support().then((support) => useVoices.setState({ support }))
  void window.kificut.voices.list().then((voices) => useVoices.setState({ voices }))
  window.kificut.voices.onChange((voices) => useVoices.setState({ voices }))
}
