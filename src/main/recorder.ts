import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type Display,
  type IpcMainInvokeEvent
} from 'electron'
import { open, readdir, rename, rm, mkdir, stat, statfs, type FileHandle } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import {
  formatClock,
  isWaylandSession,
  planFiles,
  RECORDING_SHORTCUTS,
  SYSTEM_PICKER_SOURCE,
  recordingFileName,
  recordingStamp,
  type AreaRect,
  type CaptureSource,
  type DisplayInfo,
  type FilePlan,
  type FileRole,
  type RecordedFile,
  type RecorderCommand,
  type RecorderSession,
  type RecorderStatus,
  type RecorderSummary,
  type RecorderSupport,
  type RecordingOptions,
  type RecordingResult
} from '@shared/recording'
import { ffmpegPath, run } from './ffmpeg'

/*
 * Screen and camera recording, main process side. The editor window starts a recording with
 * options; a small always-on-top recorder window (src/renderer/src/recorder) captures and encodes
 * every source and streams the files here as fragmented MP4, so a crash loses only the last couple
 * of seconds (fragments end on key frames, every two seconds).
 * When it finishes, FFmpeg turns each file into a regular MP4 with AAC sound and the editor window
 * imports them.
 */

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
/** On Wayland the desktop portal shows its own picker; see RecorderSupport.systemPicker. */
const systemPicker = process.platform === 'linux' && isWaylandSession(process.env)
/** Below this, Kificut stops and saves the recording rather than fill the disk. */
const MIN_FREE_BYTES = 1e9
/** A file with less than this holds only the MP4 header, no media. */
const MIN_MEDIA_BYTES = 4096
const OWN_WINDOW_TITLES = new Set(['Kificut Recorder', 'Kificut Camera', 'Kificut Area'])

export function recordingsFolder(): string {
  return join(app.getPath('documents'), 'Kificut', 'Recordings')
}

async function freeBytes(folder: string): Promise<number | null> {
  try {
    await mkdir(folder, { recursive: true })
    const info = await statfs(folder)
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

/** Windows 10 version 2004 (build 19041) and later leave excluded windows out of captures entirely. */
function windowsExcludesFromCapture(): boolean {
  if (!isWindows) return false
  const [major, , build] = release().split('.').map(Number)
  return major > 10 || (major === 10 && build >= 19041)
}

export async function recorderSupport(): Promise<RecorderSupport> {
  const folder = recordingsFolder()
  return {
    platform: process.platform,
    systemPicker,
    systemAudio: isWindows,
    controlsHiddenFromCapture: windowsExcludesFromCapture(),
    screenAccess: isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    recordingsFolder: folder,
    freeBytes: await freeBytes(folder)
  }
}

function displayInfo(display: Display): DisplayInfo {
  return {
    id: display.id,
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
    scaleFactor: display.scaleFactor,
    bounds: { ...display.bounds },
    primary: display.id === screen.getPrimaryDisplay().id
  }
}

export async function listSources(): Promise<CaptureSource[]> {
  // Asking for sources on Wayland opens the portal's picker; it is shown once, when recording starts.
  if (systemPicker) return []
  const displays = screen.getAllDisplays()
  const query = () =>
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 225 },
      fetchWindowIcons: true
    })
  let sources = await query()
  // The capturer occasionally fails to start on X11; a second try usually works.
  if (!sources.some((s) => s.id.startsWith('screen:'))) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    sources = await query()
  }
  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const result: CaptureSource[] = []
  screens.forEach((source, index) => {
    const display =
      displays.find((d) => String(d.id) === source.display_id) ??
      (screens.length === displays.length ? displays[index] : null)
    const info = display ? displayInfo(display) : null
    const name =
      screens.length === 1
        ? 'Entire screen'
        : `Screen ${index + 1}${info?.primary ? ' (main)' : ''}${info ? `, ${info.width} × ${info.height}` : ''}`
    result.push({
      id: source.id,
      name,
      kind: 'screen',
      display: info,
      thumbnail: source.thumbnail.toDataURL(),
      icon: null
    })
  })
  for (const source of sources) {
    if (!source.id.startsWith('window:') || OWN_WINDOW_TITLES.has(source.name)) continue
    // Minimized windows have no picture and cannot be recorded.
    if (source.thumbnail.isEmpty()) continue
    result.push({
      id: source.id,
      name: source.name,
      kind: 'window',
      display: null,
      thumbnail: source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
    })
  }
  return result
}

/* Windows of the recorder */

function loadView(win: BrowserWindow, view: 'bar' | 'camera' | 'area'): void {
  if (isDev) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/recorder.html?view=${view}`)
  else void win.loadFile(join(__dirname, '../renderer/recorder.html'), { query: { view } })
}

function floatingWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    ...options,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Kept out of screen recordings on Windows; macOS ScreenCaptureKit and Linux ignore this.
  win.setContentProtection(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  return win
}

/* The recording in progress */

interface OpenFile {
  plan: FilePlan
  part: string
  final: string
  handle: FileHandle
  bytes: number
}

interface Active {
  options: RecordingOptions
  plans: FilePlan[]
  display: DisplayInfo | null
  files: Map<FileRole, OpenFile>
  window: BrowserWindow
  camera: BrowserWindow | null
  owner: BrowserWindow | null
  tray: Tray | null
  blocker: number | null
  diskTimer: NodeJS.Timeout | null
  status: RecorderStatus
  /** The editor window was minimized for the recording and is restored afterwards. */
  minimized: boolean
  ending: boolean
  note?: string
  /** Quit the app once the recording is saved. */
  quitAfter: boolean
}

let active: Active | null = null

function sendToEditors(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (active && (win === active.window || win === active.camera)) continue
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

function sendCommand(command: RecorderCommand): void {
  if (active && !active.window.isDestroyed()) active.window.webContents.send(IPC.recorderToWindow, command)
}

/** A red dot for the tray, drawn here so no image file has to ship. */
function trayIcon(paused: boolean): Electron.NativeImage {
  const size = 32
  const pixels = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const alpha = Math.max(0, Math.min(1, 12.5 - d))
      const i = (y * size + x) * 4
      // BGRA
      pixels[i] = paused ? 0x30 : 0x3b
      pixels[i + 1] = paused ? 0xa8 : 0x3b
      pixels[i + 2] = paused ? 0xf5 : 0xef
      pixels[i + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 })
}

function updateTray(): void {
  if (!active?.tray || active.tray.isDestroyed()) return
  const { phase, elapsed } = active.status
  const paused = phase === 'paused'
  active.tray.setImage(trayIcon(paused))
  const time = formatClock(elapsed)
  active.tray.setToolTip(
    phase === 'saving'
      ? 'Kificut is saving the recording'
      : `Kificut is ${paused ? 'paused' : 'recording'} (${time})`
  )
  if (isMac) active.tray.setTitle(phase === 'recording' || paused ? ` ${time}` : '')
  active.tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: paused ? `Paused at ${time}` : `Recording ${time}`, enabled: false },
      { type: 'separator' },
      {
        label: paused ? 'Resume Recording' : 'Pause Recording',
        ...(process.platform === 'linux'
          ? {}
          : { accelerator: RECORDING_SHORTCUTS.pause, registerAccelerator: false }),
        enabled: phase === 'recording' || paused,
        click: () => sendCommand('toggle-pause')
      },
      {
        label: 'Stop and Save',
        ...(process.platform === 'linux'
          ? {}
          : { accelerator: RECORDING_SHORTCUTS.stop, registerAccelerator: false }),
        enabled: phase !== 'saving',
        click: () => sendCommand('stop')
      },
      { type: 'separator' },
      { label: 'Discard Recording', enabled: phase !== 'saving', click: () => void confirmDiscard() }
    ])
  )
}

async function confirmDiscard(): Promise<void> {
  const choice = await dialog.showMessageBox({
    type: 'warning',
    message: 'Discard this recording?',
    detail: 'What has been recorded so far is deleted.',
    buttons: ['Discard', 'Keep Recording'],
    defaultId: 1,
    cancelId: 1
  })
  if (choice.response === 0) sendCommand('discard')
}

function cleanup(): void {
  if (!active) return
  const current = active
  active = null
  if (current.diskTimer) clearInterval(current.diskTimer)
  if (current.blocker !== null && powerSaveBlocker.isStarted(current.blocker))
    powerSaveBlocker.stop(current.blocker)
  globalShortcut.unregister(RECORDING_SHORTCUTS.stop)
  globalShortcut.unregister(RECORDING_SHORTCUTS.pause)
  current.tray?.destroy()
  for (const win of [current.window, current.camera]) if (win && !win.isDestroyed()) win.destroy()
  const owner = current.owner
  if (owner && !owner.isDestroyed()) {
    // Wayland cannot report the minimized state, so restore whenever Kificut minimized itself.
    if (current.minimized) owner.restore()
    owner.show()
    owner.focus()
  }
  sendToEditors(IPC.recorderStatus, null)
  if (current.quitAfter) app.quit()
}

async function closeFiles(current: Active): Promise<void> {
  await Promise.all([...current.files.values()].map((f) => f.handle.close().catch(() => undefined)))
}

/**
 * Turns a fragmented MP4 from the recorder into a regular one with AAC sound, which every player
 * and editor reads. The computer's clocks for sound and picture drift apart slightly over a long
 * recording; aresample stretches the sound to its timestamps so it stays in sync.
 */
async function finalizeFile(part: string, final: string, hasAudio: boolean): Promise<string> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', part, '-map', '0', '-c:v', 'copy']
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1000:first_pts=0')
  args.push('-movflags', '+faststart', final)
  const result = await run(ffmpegPath(), args)
  if (result.code === 0) {
    await rm(part, { force: true })
    return final
  }
  // The fragmented file plays as it is; keep it rather than lose the recording.
  console.error(`Could not finalize ${part}: ${result.stderr}`)
  await rename(part, final).catch(() => undefined)
  return final
}

async function finishRecording(summary: RecorderSummary): Promise<void> {
  if (!active || active.ending) return
  const current = active
  current.ending = true
  current.status = { ...current.status, phase: 'saving' }
  sendToEditors(IPC.recorderStatus, current.status)
  updateTray()
  for (const win of [current.window, current.camera]) if (win && !win.isDestroyed()) win.hide()
  await closeFiles(current)
  const files: RecordedFile[] = []
  for (const file of current.files.values()) {
    if (file.bytes < MIN_MEDIA_BYTES) {
      await rm(file.part, { force: true })
      continue
    }
    files.push({
      role: file.plan.role,
      path: await finalizeFile(file.part, file.final, file.plan.audio !== null)
    })
  }
  const result: RecordingResult = {
    files,
    duration: summary.duration,
    options: current.options,
    note: current.note
  }
  cleanup()
  if (files.length > 0) sendToEditors(IPC.recorderResult, result)
  else sendToEditors(IPC.recorderError, 'Nothing was recorded.')
}

async function failRecording(message: string): Promise<void> {
  if (!active || active.ending) return
  const current = active
  const recorded = [...current.files.values()].some((f) => f.bytes >= MIN_MEDIA_BYTES)
  if (recorded && current.status.phase !== 'preparing' && current.status.phase !== 'countdown') {
    // Keep what was recorded before the problem.
    current.note = `The recording stopped early: ${message}`
    await finishRecording({ duration: current.status.elapsed })
    return
  }
  current.ending = true
  await closeFiles(current)
  for (const file of current.files.values()) await rm(file.part, { force: true })
  cleanup()
  sendToEditors(IPC.recorderError, message)
}

async function discardRecording(): Promise<void> {
  if (!active || active.ending) return
  const current = active
  current.ending = true
  await closeFiles(current)
  for (const file of current.files.values()) await rm(file.part, { force: true })
  cleanup()
}

function assertOptions(options: RecordingOptions): void {
  const needsScreen = options.mode !== 'camera'
  const needsCamera = options.mode !== 'screen'
  if (needsScreen && !options.screen) throw new Error('Choose a screen or window to record.')
  if (needsCamera && !options.camera) throw new Error('Choose a camera.')
}

async function checkPermissions(options: RecordingOptions): Promise<void> {
  if (!isMac) return
  if (options.mode !== 'camera') {
    const access = systemPreferences.getMediaAccessStatus('screen')
    if (access === 'denied' || access === 'restricted') {
      throw new Error(
        'Kificut is not allowed to record the screen. Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording, then open Kificut again.'
      )
    }
  }
  if (options.mode !== 'screen' && !(await systemPreferences.askForMediaAccess('camera'))) {
    throw new Error(
      'Kificut is not allowed to use the camera. Turn it on in System Settings > Privacy & Security > Camera.'
    )
  }
  if (options.microphone && !(await systemPreferences.askForMediaAccess('microphone'))) {
    throw new Error(
      'Kificut is not allowed to use the microphone. Turn it on in System Settings > Privacy & Security > Microphone.'
    )
  }
}

function targetDisplay(options: RecordingOptions, owner: BrowserWindow | null): Display {
  const displays = screen.getAllDisplays()
  const chosen =
    options.screen?.displayId != null ? displays.find((d) => d.id === options.screen!.displayId) : null
  if (chosen) return chosen
  if (owner && !owner.isDestroyed()) return screen.getDisplayMatching(owner.getBounds())
  return screen.getPrimaryDisplay()
}

export async function startRecording(options: RecordingOptions, owner: BrowserWindow | null): Promise<void> {
  if (active) throw new Error('A recording is already running.')
  assertOptions(options)
  await checkPermissions(options)

  const folder = recordingsFolder()
  await mkdir(folder, { recursive: true })
  const free = await freeBytes(folder)
  if (free !== null && free < MIN_FREE_BYTES * 2) {
    throw new Error(
      `There is not enough free disk space to record (${(free / 1e9).toFixed(1)} GB left in ${folder}).`
    )
  }

  const plans = planFiles(options)
  const stamp = recordingStamp(new Date())
  const files = new Map<FileRole, OpenFile>()
  for (const plan of plans) {
    const final = join(folder, recordingFileName(stamp, plan.role))
    const part = final.replace(/\.(mp4|m4a)$/, '.part.$1')
    files.set(plan.role, { plan, part, final, handle: await open(part, 'w'), bytes: 0 })
  }

  const display = targetDisplay(options, owner)
  const hasScreen = options.mode !== 'camera'
  const hasCamera = options.mode !== 'screen'
  const recordsOwner =
    options.screen?.kind === 'window' &&
    options.screen.sourceId !== SYSTEM_PICKER_SOURCE &&
    options.screen.name === owner?.getTitle()

  const win = floatingWindow({ width: 240, height: 240, title: 'Kificut Recorder', focusable: true })
  win.on('closed', () => {
    if (active?.window === win && !active.ending) void failRecording('The recorder window closed.')
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    if (active?.window === win) void failRecording(`The recorder stopped (${details.reason}).`)
  })

  let camera: BrowserWindow | null = null
  if (hasCamera && options.cameraPreview) {
    const wide = options.mode === 'camera'
    const size = wide ? { width: 400, height: 225 } : { width: 200, height: 200 }
    const area = display.workArea
    camera = floatingWindow({
      ...size,
      x: Math.round(area.x + area.width - size.width - 32),
      y: Math.round(area.y + area.height - size.height - 104),
      title: 'Kificut Camera',
      movable: true,
      focusable: false
    })
    loadView(camera, 'camera')
    camera.once('ready-to-show', () => camera?.showInactive())
  }

  active = {
    options,
    plans,
    display: hasScreen && options.screen?.kind === 'screen' ? displayInfo(display) : null,
    files,
    window: win,
    camera,
    owner,
    tray: null,
    blocker: null,
    diskTimer: null,
    status: { phase: 'preparing', elapsed: 0, countdown: options.countdown, level: null },
    minimized: false,
    ending: false,
    quitAfter: false
  }
  loadView(win, 'bar')

  active.blocker = powerSaveBlocker.start('prevent-display-sleep')
  globalShortcut.register(RECORDING_SHORTCUTS.stop, () => sendCommand('stop'))
  globalShortcut.register(RECORDING_SHORTCUTS.pause, () => sendCommand('toggle-pause'))
  try {
    active.tray = new Tray(trayIcon(false))
    updateTray()
  } catch {
    // Some Linux desktops have no tray; the bar and shortcuts still work.
  }
  active.diskTimer = setInterval(() => {
    void freeBytes(folder).then((bytes) => {
      if (active && bytes !== null && bytes < MIN_FREE_BYTES && !active.note) {
        active.note = 'Kificut stopped recording because the disk is almost full.'
        sendCommand('stop')
      }
    })
  }, 10_000)

  if (hasScreen && options.hideKificut && owner && !recordsOwner) {
    active.minimized = true
    owner.minimize()
  }
  sendToEditors(IPC.recorderStatus, active.status)
}

/** Places the recorder window for the countdown (middle of the screen) or as a bar (bottom middle). */
function layoutRecorder(view: 'countdown' | 'bar' | 'hidden'): void {
  if (!active || active.window.isDestroyed()) return
  const win = active.window
  const area = targetDisplay(active.options, active.owner).workArea
  if (view === 'hidden') {
    win.hide()
    return
  }
  const size = view === 'countdown' ? { width: 240, height: 240 } : { width: 392, height: 60 }
  win.setBounds({
    ...size,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(
      view === 'countdown'
        ? area.y + (area.height - size.height) / 2
        : area.y + area.height - size.height - 28
    )
  })
  if (!win.isVisible()) win.showInactive()
}

/* Area picker */

let areaPick: {
  window: BrowserWindow
  display: DisplayInfo
  resolve: (area: AreaRect | null) => void
} | null = null

function pickArea(displayId: number): Promise<AreaRect | null> {
  areaPick?.window.destroy()
  const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
  const win = floatingWindow({ ...display.bounds, title: 'Kificut Area', focusable: true, movable: false })
  win.setBounds(display.bounds)
  return new Promise((resolve) => {
    areaPick = { window: win, display: displayInfo(display), resolve }
    win.on('closed', () => {
      if (areaPick?.window === win) {
        areaPick = null
        resolve(null)
      }
    })
    loadView(win, 'area')
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
  })
}

/* Recovery */

/** Saves recordings left behind by a crash or a forced quit. Returns the saved files. */
export async function recoverRecordings(): Promise<string[]> {
  const folder = recordingsFolder()
  const names = await readdir(folder).catch(() => [] as string[])
  const saved: string[] = []
  for (const name of names) {
    const match = /^(.*)\.part\.(mp4|m4a)$/.exec(name)
    if (!match) continue
    const part = join(folder, name)
    const info = await stat(part).catch(() => null)
    if (!info || info.size < MIN_MEDIA_BYTES) {
      await rm(part, { force: true })
      continue
    }
    saved.push(await finalizeFile(part, join(folder, `${match[1]}.${match[2]}`), true))
  }
  return saved
}

/* IPC */

function fromRecorder(event: IpcMainInvokeEvent): Active {
  if (!active || event.sender !== active.window.webContents) throw new Error('No recording is running.')
  return active
}

export function isRecording(): boolean {
  return active !== null
}

/** Stops and saves the recording before the app quits. Returns true when quitting must wait. */
export function stopBeforeQuit(): boolean {
  if (!active) return false
  active.quitAfter = true
  sendCommand('stop')
  return true
}

/** Asks whether to stop the recording when the editor window closes. Returns true to keep the window open. */
export function confirmCloseWhileRecording(win: BrowserWindow): boolean {
  if (!active) return false
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    message: 'Kificut is recording.',
    detail: 'Stop and save the recording first?',
    buttons: ['Stop and Save', 'Keep Recording'],
    defaultId: 0,
    cancelId: 1
  })
  if (choice === 0) sendCommand('stop')
  return true
}

export function registerRecorderIpc(): void {
  // Answers the recorder window's getDisplayMedia call with the source the user picked.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const wanted = active?.options.screen
    if (!active || !wanted) return callback(null)
    if (systemPicker) {
      // The portal shows its picker now and returns the one source the user chose.
      void desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : null))
        .catch(() => callback(null))
      return
    }
    void desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = sources.find((s) => s.id === wanted.sourceId)
        if (!source) return callback(null)
        callback({
          video: source,
          ...(active?.options.systemAudio && isWindows ? { audio: 'loopback' as const } : {})
        })
      })
      .catch(() => callback(null))
  })

  ipcMain.handle(IPC.recorderSupport, () => recorderSupport())
  ipcMain.handle(IPC.recorderSources, () => listSources())
  ipcMain.handle(IPC.recorderPickArea, (_event, displayId: number) => pickArea(displayId))
  ipcMain.handle(IPC.recorderAllowCamera, () =>
    isMac ? systemPreferences.askForMediaAccess('camera') : true
  )
  ipcMain.handle(IPC.recorderStart, (event, options: RecordingOptions) =>
    startRecording(options, BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IPC.recorderCommand, (_event, command: RecorderCommand) => {
    if (command === 'discard') void confirmDiscard()
    else sendCommand(command)
  })
  ipcMain.handle(IPC.recorderReveal, async (_event, path?: string) => {
    if (path) shell.showItemInFolder(path)
    else {
      await mkdir(recordingsFolder(), { recursive: true })
      await shell.openPath(recordingsFolder())
    }
  })

  ipcMain.handle(IPC.recorderSession, (event): RecorderSession => {
    const current = fromRecorder(event)
    return { options: current.options, plans: current.plans, display: current.display, systemPicker }
  })
  ipcMain.handle(IPC.recorderWrite, async (event, role: FileRole, position: number, data: Uint8Array) => {
    const file = fromRecorder(event).files.get(role)
    if (!file) throw new Error(`No ${role} file in this recording.`)
    await file.handle.write(data, 0, data.length, position)
    file.bytes = Math.max(file.bytes, position + data.length)
  })
  ipcMain.on(IPC.recorderReport, (event, status: RecorderStatus) => {
    if (!active || event.sender !== active.window.webContents || active.ending) return
    const changed =
      status.phase !== active.status.phase || Math.floor(status.elapsed) !== Math.floor(active.status.elapsed)
    active.status = status
    sendToEditors(IPC.recorderStatus, status)
    if (changed) updateTray()
  })
  ipcMain.handle(IPC.recorderLayout, (event, view: 'countdown' | 'bar' | 'hidden') => {
    fromRecorder(event)
    layoutRecorder(view)
  })
  ipcMain.handle(IPC.recorderFinish, (event, summary: RecorderSummary) => {
    fromRecorder(event)
    return finishRecording(summary)
  })
  ipcMain.handle(IPC.recorderFail, (event, message: string) => {
    fromRecorder(event)
    return failRecording(message)
  })
  ipcMain.handle(IPC.recorderDiscarded, (event) => {
    fromRecorder(event)
    return discardRecording()
  })
  ipcMain.handle(IPC.recorderCameraView, () => {
    if (!active?.options.camera) throw new Error('No camera in this recording.')
    return {
      deviceId: active.options.camera.deviceId,
      shape: active.options.mode === 'camera' ? 'wide' : 'circle'
    }
  })
  ipcMain.handle(IPC.recorderAreaDisplay, (event) => {
    if (!areaPick || event.sender !== areaPick.window.webContents) throw new Error('No area is being picked.')
    return areaPick.display
  })
  ipcMain.handle(IPC.recorderAreaDone, (event, area: AreaRect | null) => {
    if (!areaPick || event.sender !== areaPick.window.webContents) return
    const pick = areaPick
    areaPick = null
    pick.resolve(area)
    pick.window.destroy()
  })
}
