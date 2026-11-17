import { create } from 'zustand'
import { getLocalModel, LOCAL_MODELS, type ModelStatus, type ModelTask } from '@shared/models'
import { toast } from './ui'

/** Install state of the local AI models, kept in sync with the main process. */
export const useModels = create<Record<string, ModelStatus>>(() => ({}))

let started = false

export function startModelSync(): void {
  if (started) return
  started = true
  void window.kificut.models
    .list()
    .then((list) => useModels.setState(Object.fromEntries(list.map((s) => [s.id, s]))))
  window.kificut.models.onStatus((status) => {
    const before = useModels.getState()[status.id]
    useModels.setState({ [status.id]: status })
    const name = getLocalModel(status.id)?.name ?? status.id
    if (before?.state === 'downloading' && status.state === 'installed') {
      toast({
        kind: 'success',
        title: `${name} is installed`,
        message: 'It runs on this computer, even offline.'
      })
    } else if (before?.state === 'downloading' && status.state === 'error') {
      toast({ kind: 'error', title: `${name} could not be installed`, message: status.error })
    }
  })
}

export function installModel(id: string): void {
  void window.kificut.models.install(id).then((status) => useModels.setState({ [id]: status }))
}

export function cancelModelInstall(id: string): void {
  void window.kificut.models.cancel(id)
}

export function removeModel(id: string): void {
  void window.kificut.models.remove(id).then((status) => useModels.setState({ [id]: status }))
}

/** True when at least one model for the task is installed. */
export function useTaskReady(task: ModelTask): boolean {
  return useModels((s) => LOCAL_MODELS.some((m) => m.task === task && s[m.id]?.state === 'installed'))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
