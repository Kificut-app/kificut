import { create } from 'zustand'
import type { UpdateStatus } from '@shared/updates'
import { currentSnapshot, freezeRecovery } from '../lib/recovery'
import { errorText } from './actions'
import { toast } from './ui'

export const useUpdates = create<{ status: UpdateStatus }>(() => ({ status: { state: 'idle' } }))

const KEEP_WORK = 'Your work is kept, saved or not.'

function readyToast(status: Extract<UpdateStatus, { state: 'ready' }>): void {
  toast({
    kind: 'info',
    title: `Kificut ${status.version} is ready`,
    message:
      status.action === 'restart'
        ? `Restart to install it. ${KEEP_WORK}`
        : `Open the installer and drag Kificut into Applications. ${KEEP_WORK}`,
    action: {
      label: status.action === 'restart' ? 'Restart Now' : 'Open Installer',
      run: () => void installUpdate()
    }
  })
}

function onStatus(next: UpdateStatus): void {
  const before = useUpdates.getState().status
  useUpdates.setState({ status: next })
  if (next.state === 'ready' && before.state !== 'ready') readyToast(next)
  if (next.state === 'available' && before.state !== 'available') {
    toast({
      kind: 'info',
      title: `Kificut ${next.version} is available`,
      action: { label: 'Download', run: () => window.kificut.shell.openExternal(next.url) }
    })
  }
  if (next.state === 'up-to-date' && next.manual) {
    toast({
      kind: 'success',
      title: 'Kificut is up to date',
      message: `Version ${window.kificut.versions.app} is the latest.`
    })
  }
  if (next.state === 'error' && next.manual) {
    toast({ kind: 'error', title: 'Could not check for updates', message: next.message })
  }
}

let started = false

export function startUpdateSync(): void {
  if (started) return
  started = true
  void window.kificut.updates.status().then((status) => useUpdates.setState({ status }))
  window.kificut.updates.onStatus(onStatus)
}

/** Checks now, from the menu or Settings. */
export async function checkForUpdates(): Promise<void> {
  const status = await window.kificut.updates.check()
  if (status.state === 'unsupported')
    toast({ kind: 'info', title: 'Updates are off', message: status.message })
  if (status.state === 'downloading') {
    toast({
      kind: 'info',
      title: `Downloading Kificut ${status.version}`,
      message: 'Keep working; Kificut will say when it is ready.'
    })
  }
  if (status.state === 'ready') readyToast(status)
}

/** Keeps the current work for after the restart, then installs. */
export async function installUpdate(): Promise<void> {
  const snapshot = currentSnapshot('update')
  freezeRecovery()
  try {
    if (snapshot) await window.kificut.recovery.save(snapshot)
    else await window.kificut.recovery.clear()
    await window.kificut.updates.install()
  } catch (error) {
    freezeRecovery(false)
    toast({ kind: 'error', title: 'Could not install the update', message: errorText(error) })
  }
}
