import { app } from 'electron'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RecoverySnapshot } from '@shared/updates'

/*
 * A copy of unsaved work, written while the user edits. It is removed when the work is saved or
 * discarded, so finding one at startup means Kificut closed before that happened: an update, a
 * crash, or the computer shutting down.
 */

function recoveryPath(): string {
  return join(app.getPath('userData'), 'recovery.json')
}

let writing: Promise<void> = Promise.resolve()

export function saveRecovery(snapshot: RecoverySnapshot): Promise<void> {
  // Writes go one after another so an older snapshot never lands after a newer one.
  writing = writing.then(async () => {
    const path = recoveryPath()
    await writeFile(`${path}.tmp`, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
    await rename(`${path}.tmp`, path)
  })
  return writing
}

export async function readRecovery(): Promise<RecoverySnapshot | null> {
  try {
    const snapshot = JSON.parse(await readFile(recoveryPath(), 'utf8')) as RecoverySnapshot
    return snapshot && typeof snapshot.savedAt === 'string' ? snapshot : null
  } catch {
    return null
  }
}

export function clearRecovery(): Promise<void> {
  writing = writing.then(() => rm(recoveryPath(), { force: true }))
  return writing
}
