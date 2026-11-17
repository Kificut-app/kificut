import { app, BrowserWindow, net, shell } from 'electron'
import { join } from 'node:path'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import { isNewerVersion, pickMacInstaller, type ReleaseAsset, type UpdateStatus } from '@shared/updates'
import { downloadVerified, fileMatches, HttpError, retrying, type FetchLike } from './download'

/*
 * Keeps Kificut up to date.
 *
 * Windows (and Linux AppImage): electron-updater downloads the new version from the GitHub release
 * in the background, checks it against the SHA-512 in latest.yml, and installs it when the user
 * restarts or quits.
 *
 * macOS: an app may only replace itself when it is signed with an Apple Developer ID, and release
 * builds are not yet. So Kificut downloads the installer for this Mac from the latest release,
 * checks it against the SHA-256 GitHub publishes for it, and opens it for the user.
 */

const FIRST_CHECK_MS = 20_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const LATEST_RELEASE =
  process.env.KIFICUT_RELEASES_API || 'https://api.github.com/repos/Kificut-app/kificut/releases/latest'

interface GitHubRelease {
  tag_name: string
  html_url: string
  assets: ReleaseAsset[]
}

let status: UpdateStatus = { state: 'idle' }
let mode: 'updater' | 'download' | 'off' = 'off'
let updater: AppUpdater | null = null
let installerPath: string | null = null
let lastManual = false
let pendingVersion = ''

const fetchWithNet: FetchLike = (url, init) => net.fetch(url, init)

function setStatus(next: UpdateStatus): void {
  status = next
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.updatesStatus, next)
}

export function updateStatus(): UpdateStatus {
  return status
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ENOTFOUND/.test(
      message
    )
  ) {
    return 'Could not reach the update server. Check your internet connection.'
  }
  if (/\b404\b/.test(message)) return 'No published release was found.'
  return message.split('\n')[0].slice(0, 300)
}

function setUpUpdater(): void {
  // Read only where it is used: the first read creates the platform's updater, and on macOS that
  // native updater needs a signed app.
  updater = electronUpdater.autoUpdater
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.logger = null
  if (process.env.KIFICUT_UPDATE_FEED)
    updater.setFeedURL({ provider: 'generic', url: process.env.KIFICUT_UPDATE_FEED })

  let lastSent = 0
  updater.on('update-available', (info) => {
    pendingVersion = info.version
    setStatus({ state: 'downloading', version: info.version, percent: 0 })
  })
  updater.on('download-progress', (progress) => {
    if (Date.now() - lastSent < 250) return
    lastSent = Date.now()
    setStatus({ state: 'downloading', version: pendingVersion, percent: progress.percent })
  })
  updater.on('update-downloaded', (info) =>
    setStatus({ state: 'ready', version: info.version, action: 'restart' })
  )
  updater.on('update-not-available', () => setStatus({ state: 'up-to-date', manual: lastManual }))
  updater.on('error', (error) => setStatus({ state: 'error', message: describe(error), manual: lastManual }))
}

async function latestRelease(): Promise<GitHubRelease> {
  const signal = AbortSignal.timeout(60_000)
  return retrying(async () => {
    const response = await net.fetch(LATEST_RELEASE, {
      signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Kificut' }
    })
    if (!response.ok)
      throw new HttpError(`The release server returned HTTP ${response.status}.`, response.status)
    return (await response.json()) as GitHubRelease
  }, signal)
}

async function checkGitHub(manual: boolean): Promise<void> {
  const release = await latestRelease()
  const version = release.tag_name.replace(/^v/, '')
  if (!isNewerVersion(version, app.getVersion())) {
    setStatus({ state: 'up-to-date', manual })
    return
  }
  const installer =
    process.platform === 'darwin' ? pickMacInstaller(release.assets, version, process.arch) : null
  if (!installer) {
    // Nothing this platform can install by itself, or no checksum to trust it with.
    setStatus({ state: 'available', version, url: release.html_url })
    return
  }

  const { asset, sha256 } = installer
  const target = {
    url: asset.browser_download_url,
    dest: join(app.getPath('downloads'), asset.name),
    size: asset.size,
    digest: sha256,
    kind: 'sha256' as const
  }
  if (!(await fileMatches(target))) {
    setStatus({ state: 'downloading', version, percent: 0 })
    let received = 0
    let lastSent = 0
    await downloadVerified(target, fetchWithNet, AbortSignal.timeout(60 * 60 * 1000), (count) => {
      received += count
      if (Date.now() - lastSent < 250) return
      lastSent = Date.now()
      setStatus({ state: 'downloading', version, percent: (received / asset.size) * 100 })
    })
  }
  installerPath = target.dest
  setStatus({ state: 'ready', version, action: 'installer' })
}

export async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  if (mode === 'off') return status
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') {
    if (manual) setStatus(status)
    return status
  }
  lastManual = manual
  setStatus({ state: 'checking', manual })
  try {
    if (mode === 'updater') {
      if (!updater) setUpUpdater()
      await updater!.checkForUpdates()
    } else {
      await checkGitHub(manual)
    }
  } catch (error) {
    setStatus({ state: 'error', message: describe(error), manual })
  }
  return status
}

/** Installs the downloaded update. The caller has already let the windows close. */
export async function installUpdate(): Promise<void> {
  if (status.state !== 'ready') throw new Error('No update is ready to install yet.')
  if (status.action === 'restart') {
    // Silent install, then Kificut starts again.
    updater!.quitAndInstall(true, true)
    return
  }
  const error = await shell.openPath(installerPath!)
  if (error) throw new Error(error)
  // Quit so the new version can replace this one; the installer window stays open.
  setTimeout(() => app.quit(), 800)
}

export function startUpdater(autoCheck: () => boolean): void {
  const testing = Boolean(process.env.KIFICUT_UPDATE_FEED || process.env.KIFICUT_RELEASES_API)
  if (!app.isPackaged && !testing) {
    status = { state: 'unsupported', message: 'Updates are turned off in development builds.' }
    return
  }
  const canReplaceItself =
    process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.APPIMAGE))
  mode = canReplaceItself && !process.env.KIFICUT_RELEASES_API ? 'updater' : 'download'
  const scheduled = () => {
    if (autoCheck()) void checkForUpdates(false)
  }
  setTimeout(scheduled, Number(process.env.KIFICUT_FIRST_UPDATE_CHECK_MS) || FIRST_CHECK_MS)
  setInterval(scheduled, CHECK_EVERY_MS)
}
