import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type AiCall, type KificutApi, type MenuCommand } from '@shared/ipc'
import type { ExportProgress } from '@shared/export-formats'
import type { AiStatus, ProxyStatus } from '@shared/types'
import type { ModelStatus } from '@shared/models'
import type { AssistantEvent } from '@shared/assistant'

function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

function argument(name: string): string {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? ''
}

const appVersion = argument('app-version')

const api: KificutApi = {
  platform: process.platform,
  homeDir: argument('home-dir'),
  versions: {
    app: appVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),

  media: {
    pick: () => ipcRenderer.invoke(IPC.mediaPick),
    probe: (paths) => ipcRenderer.invoke(IPC.mediaProbe, paths),
    poster: (path, duration) => ipcRenderer.invoke(IPC.mediaPoster, path, duration),
    filmstrip: (path, duration) => ipcRenderer.invoke(IPC.mediaFilmstrip, path, duration),
    waveform: (path) => ipcRenderer.invoke(IPC.mediaWaveform, path),
    exists: (paths) => ipcRenderer.invoke(IPC.mediaExists, paths),
    locate: (name) => ipcRenderer.invoke(IPC.mediaLocate, name),
    proxy: (path) => ipcRenderer.invoke(IPC.mediaProxy, path),
    onProxyProgress: (callback) =>
      subscribe<[string, ProxyStatus]>(IPC.mediaProxyProgress, (path, status) => callback(path, status)),
    listFiles: (folder, recursive) => ipcRenderer.invoke(IPC.mediaListFiles, folder, recursive),
    sampleFrames: (path, duration, count, start, end) =>
      ipcRenderer.invoke(IPC.mediaSampleFrames, path, duration, count, start, end),
    analyze: (path, duration, hasVideo, hasAudio) =>
      ipcRenderer.invoke(IPC.mediaAnalyze, path, duration, hasVideo, hasAudio),
    decodeAudio: (path, sampleRate) => ipcRenderer.invoke(IPC.mediaDecodeAudio, path, sampleRate),
    saveGenerated: (name, data) => ipcRenderer.invoke(IPC.mediaSaveGenerated, name, data)
  },

  models: {
    list: () => ipcRenderer.invoke(IPC.modelsList),
    install: (id) => ipcRenderer.invoke(IPC.modelsInstall, id),
    cancel: (id) => ipcRenderer.invoke(IPC.modelsCancel, id),
    remove: (id) => ipcRenderer.invoke(IPC.modelsRemove, id),
    onStatus: (callback) => subscribe<[ModelStatus]>(IPC.modelsStatus, callback)
  },

  assistant: {
    settings: () => ipcRenderer.invoke(IPC.assistantSettings),
    updateProvider: (update) => ipcRenderer.invoke(IPC.assistantUpdateProvider, update),
    setActive: (id) => ipcRenderer.invoke(IPC.assistantSetActive, id),
    listModels: (id) => ipcRenderer.invoke(IPC.assistantListModels, id),
    send: (text) => ipcRenderer.invoke(IPC.assistantSend, text),
    stop: () => ipcRenderer.invoke(IPC.assistantStop),
    reset: () => ipcRenderer.invoke(IPC.assistantReset),
    onEvent: (callback) => subscribe<[AssistantEvent]>(IPC.assistantEvent, callback)
  },

  ai: {
    onCall: (callback) => subscribe<[AiCall]>(IPC.aiCall, callback),
    respond: (callId, result) => ipcRenderer.send(IPC.aiResult, callId, result),
    ready: () => ipcRenderer.send(IPC.aiReady),
    status: () => ipcRenderer.invoke(IPC.aiStatus),
    onStatus: (callback) => subscribe<[AiStatus]>(IPC.aiStatusChanged, callback),
    installClaude: () => ipcRenderer.invoke(IPC.aiInstallClaude)
  },

  project: {
    open: () => ipcRenderer.invoke(IPC.projectOpen),
    openPath: (path) => ipcRenderer.invoke(IPC.projectOpenPath, path),
    save: (path, data, suggestedName) => ipcRenderer.invoke(IPC.projectSave, path, data, suggestedName),
    recent: () => ipcRenderer.invoke(IPC.projectRecent),
    removeRecent: (path) => ipcRenderer.invoke(IPC.projectRemoveRecent, path),
    setState: (state) => ipcRenderer.send(IPC.projectState, state)
  },

  exporter: {
    chooseOutput: (defaultName, extension, label) =>
      ipcRenderer.invoke(IPC.exportChoose, defaultName, extension, label),
    start: (request) => ipcRenderer.invoke(IPC.exportStart, request),
    cancel: () => ipcRenderer.invoke(IPC.exportCancel),
    onProgress: (callback) => subscribe<[ExportProgress]>(IPC.exportProgress, callback)
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    tools: () => ipcRenderer.invoke(IPC.settingsTools),
    pickBinary: () => ipcRenderer.invoke(IPC.settingsPickBinary)
  },

  shell: {
    showItemInFolder: (path) => ipcRenderer.send(IPC.shellShow, path),
    openExternal: (url) => ipcRenderer.send(IPC.shellOpen, url)
  },

  app: {
    closeWindow: (force) => ipcRenderer.send(IPC.appClose, force),
    onMenuCommand: (callback) => subscribe<[MenuCommand]>(IPC.appMenu, callback),
    onCloseRequest: (callback) => subscribe<[]>(IPC.appCloseRequest, callback),
    onOpenProject: (callback) => subscribe<[string]>(IPC.appOpenProject, callback)
  }
}

contextBridge.exposeInMainWorld('kificut', api)
