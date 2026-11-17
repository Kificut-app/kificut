import { useEffect } from 'react'
import { isDirty, useEditor } from '../store/editor'
import { handleWindowClose, openProjectPath, saveProject, setProxyStatus } from '../store/actions'
import { startModelSync } from '../store/models'
import { startAssistantSync } from '../store/assistant'

/** Wires the renderer to the main process: settings, proxies, window title, close requests and autosave. */
export function useBoot(): void {
  useEffect(() => {
    startModelSync()
    startAssistantSync()
    void window.kificut.settings.get().then((settings) => {
      useEditor.setState({ settings, previewScale: settings.previewScale || 1 })
    })

    const offProxy = window.kificut.media.onProxyProgress((path, status) => setProxyStatus(path, status))
    const offClose = window.kificut.app.onCloseRequest(() => void handleWindowClose())
    const offOpen = window.kificut.app.onOpenProject((path) => void openProjectPath(path))

    let last = ''
    const sync = () => {
      const state = useEditor.getState()
      const dirty = isDirty(state)
      const title = state.project ? `${state.project.name}${dirty ? ' (edited)' : ''} - Kificut` : 'Kificut'
      const key = `${title}|${dirty}|${!!state.project}`
      if (key === last) return
      last = key
      window.kificut.project.setState({ dirty, title, hasProject: !!state.project })
    }
    sync()
    const offStore = useEditor.subscribe(sync)

    return () => {
      offProxy()
      offClose()
      offOpen()
      offStore()
    }
  }, [])

  const autosave = useEditor((s) => s.settings?.autosave ?? false)
  const minutes = useEditor((s) => s.settings?.autosaveMinutes ?? 3)

  useEffect(() => {
    if (!autosave) return
    const timer = window.setInterval(
      () => {
        const state = useEditor.getState()
        if (state.filePath && isDirty(state) && !state.gestureBase && !state.dialog) void saveProject()
      },
      Math.max(1, minutes) * 60_000
    )
    return () => window.clearInterval(timer)
  }, [autosave, minutes])
}
