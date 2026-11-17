/*
 * App updates and recovery of unsaved work. On Windows an update downloads in the background and
 * installs on restart. Release builds for macOS are not signed with an Apple Developer ID, which
 * macOS requires for an app to replace itself, so there Kificut downloads the new installer and
 * opens it. Either way unsaved work is kept as a recovery copy and restored afterwards.
 */

export const RELEASES_URL = 'https://github.com/Kificut-app/kificut/releases'

export type UpdateStatus =
  | { state: 'unsupported'; message: string }
  | { state: 'idle' }
  | { state: 'checking'; manual: boolean }
  | { state: 'up-to-date'; manual: boolean }
  | { state: 'downloading'; version: string; percent: number }
  /** Downloaded. "restart" installs and reopens Kificut; "installer" opens the downloaded installer. */
  | { state: 'ready'; version: string; action: 'restart' | 'installer' }
  /** Newer, but it has to be downloaded from the releases page. */
  | { state: 'available'; version: string; url: string }
  | { state: 'error'; message: string; manual: boolean }

/** Unsaved work, kept on disk until it is saved or discarded. */
export interface RecoverySnapshot {
  savedAt: string
  /** "update" when Kificut closed to install an update; it is restored without asking. */
  reason: 'session' | 'update'
  name: string
  /** The project's file, if it has one. */
  filePath: string | null
  /** The project in file format, or null when it was saved and only needs reopening. */
  data: unknown
}

/** True when version a is newer than version b (both like "1.2.3"). */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  /** "sha256:<hex>", which GitHub publishes for release assets. */
  digest?: string | null
}

/** The installer this Mac should download from a release, with its SHA-256, or null. */
export function pickMacInstaller(
  assets: ReleaseAsset[],
  version: string,
  arch: string
): { asset: ReleaseAsset; sha256: string } | null {
  const name = `Kificut-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  const asset = assets.find((a) => a.name === name)
  const digest = asset?.digest ?? ''
  if (!asset || !/^sha256:[0-9a-f]{64}$/i.test(digest)) return null
  return { asset, sha256: digest.slice(7).toLowerCase() }
}
