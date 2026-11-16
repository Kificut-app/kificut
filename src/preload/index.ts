import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type KificutApi, type MenuCommand } from '@shared/ipc'
import type { ExportProgress } from '@shared/export-formats'
import type { ProxyStatus } from '@shared/types'

function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const appVersion = process.argv.find((arg) => arg.startsWith('--app-version='))?.split('=')[1] ?? ''

const api: KificutApi = {
  platform: process.platform,
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
      subscribe<[string, ProxyStatus]>(IPC.mediaProxyProgress, (path, status) => callback(path, status))
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
