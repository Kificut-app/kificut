import { app, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * Desktop integration for the Linux AppImage. An AppImage runs without installing anything, so on
 * start Kificut adds a desktop entry, icons and the .kificut file type for the current user. That
 * gives it a menu entry and its own icon in the dock, opens projects with a double click, and gives
 * it an identity that Wayland's portals accept: GNOME and xdg-desktop-portal 1.21 and later refuse
 * screen recording and global shortcuts to apps whose ID (desktopName, "kificut") has no installed
 * .desktop file. The entry follows the AppImage when an update renames it.
 */

const ID = 'kificut'
const MARKER = 'X-Kificut-Managed=true'
const ICON_SIZES = [512, 256, 128, 64, 48, 32]

/** Quotes one argument of an Exec line as the Desktop Entry specification asks. */
function execArgument(value: string): string {
  // Inside quotes " ` $ \ take a backslash; then the whole value is a string, whose backslashes
  // double; and a literal % is written %% so it is not read as a field code.
  const quoted = `"${value.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

/** Escapes a plain string value (TryExec, Name). */
function stringValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
}

export function desktopEntry(appImage: string, version: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Kificut',
    'GenericName=Video Editor',
    'Comment=Edit videos on a multi-track timeline',
    `Exec=${execArgument(appImage)} %U`,
    // Desktops hide the entry once the AppImage is gone.
    `TryExec=${stringValue(appImage)}`,
    'Icon=kificut',
    'Terminal=false',
    'StartupWMClass=kificut',
    'MimeType=application/x-kificut-project;',
    'Categories=AudioVideo;Video;AudioVideoEditing;',
    'Keywords=video;editor;',
    `X-AppImage-Version=${version}`,
    MARKER,
    ''
  ].join('\n')
}

export const MIME_PACKAGE = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-kificut-project">
    <comment>Kificut project</comment>
    <glob pattern="*.kificut"/>
  </mime-type>
</mime-info>
`

function dataHome(): string {
  const configured = process.env.XDG_DATA_HOME
  return configured && configured.startsWith('/') ? configured : join(homedir(), '.local', 'share')
}

/** Runs a desktop database tool if it is installed; integration works without them, just later. */
function refresh(tool: string, folder: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(tool, [folder], { timeout: 10_000 }, () => resolve())
  })
}

async function writeIfChanged(path: string, data: string | Buffer): Promise<boolean> {
  const current = await readFile(path).catch(() => null)
  if (current && Buffer.compare(current, Buffer.from(data)) === 0) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  return true
}

/** Adds or updates the desktop entry, icons and file type. Does nothing outside an AppImage. */
export async function integrateAppImage(): Promise<void> {
  const appImage = process.env.APPIMAGE
  const appDir = process.env.APPDIR
  if (process.platform !== 'linux' || !appImage || !appDir || process.env.KIFICUT_NO_DESKTOP_INTEGRATION)
    return

  const home = dataHome()
  const desktopFile = join(home, 'applications', `${ID}.desktop`)
  const existing = await readFile(desktopFile, 'utf8').catch(() => null)
  // An entry written by the user or another tool is theirs to keep.
  if (existing !== null && !existing.includes(MARKER)) return

  const entryChanged = await writeIfChanged(desktopFile, desktopEntry(appImage, app.getVersion()))

  const icon = nativeImage.createFromPath(join(appDir, `${ID}.png`))
  if (!icon.isEmpty()) {
    for (const size of ICON_SIZES) {
      const png = icon.resize({ width: size, height: size, quality: 'best' }).toPNG()
      await writeIfChanged(join(home, 'icons', 'hicolor', `${size}x${size}`, 'apps', `${ID}.png`), png)
    }
  }

  const mimeChanged = await writeIfChanged(join(home, 'mime', 'packages', `${ID}.xml`), MIME_PACKAGE)
  if (mimeChanged) await refresh('update-mime-database', join(home, 'mime'))
  if (entryChanged) await refresh('update-desktop-database', join(home, 'applications'))
}
