import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC, type ExportRequest } from '@shared/ipc'
import { PROJECT_EXTENSION, type AppSettings, type ProjectFile } from '@shared/types'
import { getExportFormat } from '@shared/export-formats'
import { MEDIA_EXTENSIONS } from '@shared/media-formats'
import { buildMenu } from './menu'
import { prepareForSave, readProject } from './project-file'
import { handleMediaProtocol, handleModelsProtocol, registerMediaScheme } from './protocol'
import {
  analyzeMedia,
  decodeAudio,
  filmstrip,
  listMediaFiles,
  poster,
  probe,
  requestProxy,
  sampleFrames,
  saveGenerated,
  waveform
} from './media'
import { cancelModelInstall, installModel, listModelStatus, modelsDir, removeModel } from './models'
import { registerAssistantIpc } from './assistant'
import { registerVoiceIpc } from './voices'
import { integrateAppImage } from './linux-desktop'
import {
  confirmCloseWhileRecording,
  isRecording,
  recoverRecordings,
  registerRecorderIpc,
  stopBeforeQuit
} from './recorder'
import { stopVoiceEngine } from './voice-engine'
import { VOICE_CLONE_MODEL } from '@shared/voices'
import { registerGenerationIpc } from './generation'
import { checkForUpdates, installUpdate, startUpdater, updateStatus } from './updater'
import { clearRecovery, readRecovery, saveRecovery } from './recovery'
import { connectClaudeCode, refreshClaudeCodeRegistration } from './claude-code'
import { isMcpServerMode, runMcpServer } from './mcp-mode'
import {
  cancelMatte,
  finishMatte,
  readMatteFrames,
  readSearchIndex,
  reduceNoise,
  searchFrames,
  startMatte,
  writeMatteMasks,
  writeSearchIndex
} from './ai-media'
import type { RecoverySnapshot } from '@shared/updates'
import {
  announceConnectorDisabled,
  connectorStatus,
  findClaudeBundle,
  isConnectorRunning,
  registerConnectorIpc,
  startConnector,
  stopConnector
} from './connector'
import { cancelExport, isExporting, startExport } from './export'
import { resetVersionCache, toolInfo } from './ffmpeg'
import {
  addRecentProject,
  getRecentProjects,
  getSettings,
  removeRecentProject,
  updateSettings
} from './settings'

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

registerMediaScheme()
// Lets the local AI models run on several CPU threads. Kificut only ever shows its own pages, so the
// shared memory this turns on is not exposed to outside sites.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

const MEDIA_FILTERS = [
  { name: 'Media', extensions: MEDIA_EXTENSIONS },
  { name: 'All Files', extensions: ['*'] }
]

const PROJECT_FILTERS = [{ name: 'Kificut Project', extensions: [PROJECT_EXTENSION] }]

interface WindowState {
  dirty: boolean
  hasProject: boolean
  forceClose: boolean
}

const windowState = new WeakMap<BrowserWindow, WindowState>()
let pendingOpenPath: string | null = null

function projectPathFromArgs(argv: string[]): string | null {
  const match = argv.find((arg) => arg.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) && existsSync(arg))
  return match ?? null
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#0f0f12',
    title: 'Kificut',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#141418', symbolColor: '#b9b9c4', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
      // Keep rendering while Kificut sits behind another app, such as Claude Desktop driving it.
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${app.getVersion()}`, `--home-dir=${app.getPath('home')}`]
    }
  })

  windowState.set(win, { dirty: false, hasProject: false, forceClose: false })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!)) return
    event.preventDefault()
  })

  win.on('close', (event) => {
    const state = windowState.get(win)
    if (!state || state.forceClose) return
    if (isRecording() && confirmCloseWhileRecording(win)) {
      event.preventDefault()
      return
    }
    if (isExporting()) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Keep Exporting', 'Stop and Close'],
        defaultId: 0,
        cancelId: 0,
        message: 'An export is still running.',
        detail: 'Closing the window will stop the export.'
      })
      if (choice === 0) {
        event.preventDefault()
        return
      }
      cancelExport()
    }
    if (state.dirty) {
      event.preventDefault()
      win.webContents.send(IPC.appCloseRequest)
    }
  })

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      win.webContents.send(IPC.appOpenProject, pendingOpenPath)
      pendingOpenPath = null
    }
    // Recordings cut short by a crash or a forced quit are saved and reported once.
    if (!recoveryChecked && !isRecording()) {
      recoveryChecked = true
      void recoverRecordings().then((paths) => {
        if (paths.length > 0 && !win.isDestroyed()) win.webContents.send(IPC.recorderRecovered, paths)
      })
    }
  })

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

let recoveryChecked = false

function senderWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function registerIpc(): void {
  ipcMain.handle(IPC.mediaPick, async (event) => {
    const win = senderWindow(event)
    const options: Electron.OpenDialogOptions = {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.mediaProbe, async (_event, paths: string[]) => Promise.all(paths.map((p) => probe(p))))
  ipcMain.handle(IPC.mediaPoster, (_event, path: string, duration: number) => poster(path, duration))
  ipcMain.handle(IPC.mediaFilmstrip, (_event, path: string, duration: number) => filmstrip(path, duration))
  ipcMain.handle(IPC.mediaWaveform, (_event, path: string) => waveform(path))
  ipcMain.handle(IPC.mediaExists, (_event, paths: string[]) => paths.map((p) => existsSync(p)))
  ipcMain.handle(IPC.mediaProxy, (_event, path: string) => requestProxy(path))
  ipcMain.handle(IPC.mediaListFiles, (_event, folder: string, recursive: boolean) =>
    listMediaFiles(folder, recursive)
  )
  ipcMain.handle(
    IPC.mediaSampleFrames,
    (_event, path: string, duration: number, count: number, start?: number, end?: number) =>
      sampleFrames(path, duration, Math.max(1, Math.min(12, count)), start, end)
  )
  ipcMain.handle(
    IPC.mediaAnalyze,
    (_event, path: string, duration: number, hasVideo: boolean, hasAudio: boolean) =>
      analyzeMedia(path, duration, hasVideo, hasAudio)
  )

  ipcMain.handle(IPC.mediaDecodeAudio, (_event, path: string, sampleRate: number) =>
    decodeAudio(path, sampleRate)
  )
  ipcMain.handle(IPC.mediaSaveGenerated, (_event, name: string, data: Uint8Array) =>
    saveGenerated(name, data)
  )

  ipcMain.handle(IPC.modelsList, () => listModelStatus())
  ipcMain.handle(IPC.modelsInstall, (_event, id: string) => installModel(id))
  ipcMain.handle(IPC.modelsCancel, (_event, id: string) => cancelModelInstall(id))
  ipcMain.handle(IPC.modelsRemove, (_event, id: string) => {
    // The voice engine keeps the model's files open, which Windows will not delete.
    if (id === VOICE_CLONE_MODEL) stopVoiceEngine()
    return removeModel(id)
  })

  registerAssistantIpc()
  registerVoiceIpc()
  registerRecorderIpc()
  registerGenerationIpc()

  ipcMain.handle(IPC.updatesGet, () => updateStatus())
  ipcMain.handle(IPC.updatesCheck, () => checkForUpdates(true))
  ipcMain.handle(IPC.updatesInstall, async () => {
    // The renderer has stored any unsaved work, so the windows may close without asking.
    const allowClose = (force: boolean) => {
      for (const win of BrowserWindow.getAllWindows()) {
        const state = windowState.get(win)
        if (state) state.forceClose = force
      }
    }
    allowClose(true)
    try {
      await installUpdate()
    } catch (error) {
      allowClose(false)
      throw error
    }
  })
  ipcMain.handle(IPC.recoverySave, (_event, snapshot: RecoverySnapshot) => saveRecovery(snapshot))
  ipcMain.handle(IPC.recoveryRead, () => readRecovery())
  ipcMain.handle(IPC.recoveryClear, () => clearRecovery())
  ipcMain.handle(IPC.aiConnectClaudeCode, () => connectClaudeCode())

  ipcMain.handle(IPC.localAiSearchFrames, (_event, path: string, duration: number) =>
    searchFrames(path, duration)
  )
  ipcMain.handle(IPC.localAiReadIndex, (_event, path: string, model: string) => readSearchIndex(path, model))
  ipcMain.handle(IPC.localAiWriteIndex, (_event, path: string, model: string, data: string) =>
    writeSearchIndex(path, model, data)
  )
  ipcMain.handle(IPC.localAiReduceNoise, (event, path: string, strength: number, duration: number) =>
    reduceNoise(path, strength, duration, (fraction) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.localAiNoiseProgress, path, fraction)
    })
  )
  ipcMain.handle(
    IPC.localAiStartMatte,
    (_event, path: string, start: number, duration: number, fps: number, width: number, height: number) =>
      startMatte(path, start, duration, fps, width, height)
  )
  ipcMain.handle(IPC.localAiReadFrames, (_event, id: number, max: number) => readMatteFrames(id, max))
  ipcMain.handle(IPC.localAiWriteMasks, (_event, id: number, masks: Uint8Array) => writeMatteMasks(id, masks))
  ipcMain.handle(IPC.localAiFinishMatte, (_event, id: number) => finishMatte(id))
  ipcMain.handle(IPC.localAiCancelMatte, (_event, id: number) => cancelMatte(id))

  ipcMain.handle(IPC.aiStatus, () => connectorStatus(isConnectorRunning()))
  ipcMain.handle(IPC.aiInstallClaude, async () => {
    const bundle = findClaudeBundle()
    if (!bundle) return { ok: false, error: 'This build does not include the Claude connector.' }
    const error = await shell.openPath(bundle)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle(IPC.mediaLocate, async (event, name: string) => {
    const win = senderWindow(event)
    const options: Electron.OpenDialogOptions = {
      title: `Locate ${name}`,
      properties: ['openFile'],
      filters: MEDIA_FILTERS
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.projectOpen, async (event) => {
    const win = senderWindow(event)
    const options: Electron.OpenDialogOptions = {
      title: 'Open Project',
      properties: ['openFile'],
      filters: PROJECT_FILTERS
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const data = await readProject(path)
    addRecentProject(path, (data as ProjectFile).project.name)
    return { path, data }
  })

  ipcMain.handle(IPC.projectOpenPath, async (_event, path: string) => {
    const data = await readProject(path)
    addRecentProject(path, (data as ProjectFile).project.name)
    return { path, data }
  })

  ipcMain.handle(
    IPC.projectSave,
    async (event, path: string | null, data: unknown, suggestedName: string) => {
      let target = path
      if (!target) {
        const win = senderWindow(event)
        const options: Electron.SaveDialogOptions = {
          title: 'Save Project',
          defaultPath: join(app.getPath('documents'), `${suggestedName || 'Untitled'}.${PROJECT_EXTENSION}`),
          filters: PROJECT_FILTERS
        }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        target = result.filePath
      }
      const temp = `${target}.saving`
      await writeFile(temp, JSON.stringify(prepareForSave(data, target), null, 2), 'utf8')
      await rename(temp, target)
      const name = (data as { project?: { name?: string } })?.project?.name
      addRecentProject(target, name)
      return target
    }
  )

  ipcMain.handle(IPC.projectRecent, () => getRecentProjects())
  ipcMain.handle(IPC.projectRemoveRecent, (_event, path: string) => removeRecentProject(path))

  ipcMain.on(IPC.projectState, (event, state: { dirty: boolean; title: string; hasProject: boolean }) => {
    const win = senderWindow(event)
    if (!win) return
    const current = windowState.get(win)
    if (current) {
      current.dirty = state.dirty
      current.hasProject = state.hasProject
    }
    win.setTitle(state.title)
    win.setDocumentEdited(state.dirty)
  })

  ipcMain.handle(IPC.exportChoose, async (event, defaultName: string, extension: string, label: string) => {
    const win = senderWindow(event)
    const options: Electron.SaveDialogOptions = {
      title: 'Export',
      defaultPath: join(app.getPath('videos'), `${defaultName}.${extension}`),
      filters: [{ name: label, extensions: [extension] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled ? null : (result.filePath ?? null)
  })

  ipcMain.handle(IPC.exportStart, async (event, request: ExportRequest) => {
    const format = getExportFormat(request.settings.format)
    if (!request.settings.outputPath.toLowerCase().endsWith(`.${format.extension}`)) {
      request.settings.outputPath += `.${format.extension}`
    }
    return startExport(request, senderWindow(event))
  })
  ipcMain.handle(IPC.exportCancel, () => cancelExport())

  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSet, (_event, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    if ('ffmpegPath' in patch) resetVersionCache()
    if ('connectorEnabled' in patch) {
      if (next.connectorEnabled) void startConnector().catch(() => undefined)
      else stopConnector()
    }
    return next
  })
  ipcMain.handle(IPC.settingsTools, () => toolInfo())
  ipcMain.handle(IPC.settingsPickBinary, async (event) => {
    const win = senderWindow(event)
    const options: Electron.OpenDialogOptions = { title: 'Choose Executable', properties: ['openFile'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.on(IPC.shellShow, (_event, path: string) => shell.showItemInFolder(path))
  ipcMain.on(IPC.shellOpen, (_event, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  ipcMain.on(IPC.appClose, (event, force: boolean) => {
    const win = senderWindow(event)
    if (!win) return
    const state = windowState.get(win)
    if (state && force) state.forceClose = true
    win.close()
  })
}

if (isMcpServerMode()) {
  runMcpServer()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  pendingOpenPath = projectPathFromArgs(process.argv)

  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const path = projectPathFromArgs(argv)
    if (path) win.webContents.send(IPC.appOpenProject, path)
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading()) win.webContents.send(IPC.appOpenProject, path)
    else pendingOpenPath = path
  })

  app.whenReady().then(() => {
    app.setName('Kificut')
    if (process.platform === 'win32') app.setAppUserModelId('org.kificut.app')
    // Linux AppImage: menu entry, icon, file type and a portal identity for Wayland.
    integrateAppImage().catch((error: unknown) => console.error('Desktop integration failed:', error))
    handleMediaProtocol()
    handleModelsProtocol(modelsDir())
    registerIpc()
    registerConnectorIpc(() => BrowserWindow.getAllWindows()[0] ?? createWindow())
    buildMenu(isDev)
    createWindow()
    startUpdater(() => getSettings().autoUpdate)
    // An AppImage moved or renamed by an update gets its Claude Code entry pointed at the new path.
    setTimeout(() => void refreshClaudeCodeRegistration(), 10_000)
    if (getSettings().connectorEnabled) {
      startConnector().catch((error: unknown) => console.error('Could not start the AI connector:', error))
    } else {
      announceConnectorDisabled()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', (event) => {
    // Save a recording in progress first; the app quits once it is saved.
    if (stopBeforeQuit()) event.preventDefault()
  })
  app.on('will-quit', () => stopConnector(true))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
