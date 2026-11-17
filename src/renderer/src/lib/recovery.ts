import type { RecoverySnapshot } from '@shared/updates'
import { isDirty, loadProject, useEditor } from '../store/editor'
import { errorText, openProjectPath, refreshMediaStatus, zoomToFit } from '../store/actions'
import { confirmDialog, toast } from '../store/ui'
import { parseProjectFile, toProjectFile } from './project-io'

/*
 * Keeps a copy of unsaved work on disk while the user edits, and offers it back at startup if
 * Kificut closed before the work was saved: an update, a crash, a power cut.
 */

const WRITE_DELAY_MS = 2000

/** Set while Kificut closes for an update, so the copy written for it is not replaced. */
let frozen = false

export function freezeRecovery(frozenNow = true): void {
  frozen = frozenNow
}

/** The current project as a recovery copy, or null when there is no project. */
export function currentSnapshot(reason: RecoverySnapshot['reason']): RecoverySnapshot | null {
  const state = useEditor.getState()
  if (!state.project) return null
  return {
    savedAt: new Date().toISOString(),
    reason,
    name: state.project.name,
    filePath: state.filePath,
    // A saved project only needs reopening from its file.
    data: isDirty(state) ? toProjectFile(state.project) : null
  }
}

/** Writes a recovery copy whenever the project has unsaved changes, and removes it once they are saved. */
export function startRecoveryWriter(): () => void {
  let timer: number | null = null
  // A copy may be left from the last session, so the first clean state clears it.
  let stored = true
  let lastProject: unknown = undefined
  let lastSaved: unknown = undefined

  const write = () => {
    timer = null
    const state = useEditor.getState()
    if (frozen || !state.project || !isDirty(state)) return
    const snapshot = currentSnapshot('session')
    if (!snapshot) return
    stored = true
    void window.kificut.recovery.save(snapshot).catch(() => undefined)
  }

  const unsubscribe = useEditor.subscribe((state) => {
    // Saving changes only savedProject, so watch both.
    if (frozen || (state.project === lastProject && state.savedProject === lastSaved)) return
    lastProject = state.project
    lastSaved = state.savedProject
    if (state.project && isDirty(state)) {
      // Wait for a pause in editing, and for drags to finish.
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(write, state.gestureBase ? WRITE_DELAY_MS * 2 : WRITE_DELAY_MS)
    } else if (stored) {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      stored = false
      void window.kificut.recovery.clear()
    }
  })
  return () => {
    unsubscribe()
    if (timer !== null) window.clearTimeout(timer)
  }
}

function describeTime(iso: string): string {
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? `today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

async function restore(snapshot: RecoverySnapshot): Promise<void> {
  if (snapshot.data) {
    loadProject(parseProjectFile(snapshot.data), snapshot.filePath, true)
    await refreshMediaStatus()
    requestAnimationFrame(() => zoomToFit())
  } else if (snapshot.filePath) {
    await openProjectPath(snapshot.filePath)
  }
}

/** Offers recovered work at startup. After an update it is restored without asking. */
export async function offerRecovery(): Promise<void> {
  const snapshot = await window.kificut.recovery.read()
  if (!snapshot) return
  try {
    if (snapshot.reason === 'update') {
      await restore(snapshot)
      toast({
        kind: 'success',
        title: 'Kificut was updated',
        message: snapshot.data
          ? `"${snapshot.name}" is back as you left it, unsaved changes included.`
          : `"${snapshot.name}" is open again.`
      })
    } else if (snapshot.data) {
      const choice = await confirmDialog({
        title: 'Recover unsaved work?',
        message: `Kificut closed before your changes to "${snapshot.name}" were saved. The last copy is from ${describeTime(snapshot.savedAt)}.`,
        buttons: [
          { id: 'discard', label: 'Discard', danger: true },
          { id: 'recover', label: 'Recover', primary: true }
        ]
      })
      if (choice === 'recover') await restore(snapshot)
    }
  } catch (error) {
    toast({ kind: 'error', title: 'Could not recover the project', message: errorText(error) })
  }
  // A recovered project is still unsaved, so the writer stores it again.
  await window.kificut.recovery.clear()
  const state = useEditor.getState()
  if (state.project && isDirty(state)) {
    const again = currentSnapshot('session')
    if (again) await window.kificut.recovery.save(again)
  }
}
