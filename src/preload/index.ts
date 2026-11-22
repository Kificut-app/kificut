import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type AiCall, type KificutApi, type MenuCommand } from '@shared/ipc'
import type { ExportProgress } from '@shared/export-formats'
import type { AiStatus, ProxyStatus } from '@shared/types'
import type { ModelStatus } from '@shared/models'
import type { CustomVoice } from '@shared/voices'
import type { RecorderCommand, RecorderStatus, RecordingResult } from '@shared/recording'
import type { AssistantEvent } from '@shared/assistant'
import type { UpdateStatus } from '@shared/updates'
import type { GenerationJob } from '@shared/generation'

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

  voices: {
    support: () => ipcRenderer.invoke(IPC.voicesSupport),
    list: () => ipcRenderer.invoke(IPC.voicesList),
    create: (request) => ipcRenderer.invoke(IPC.voicesCreate, request),
    rename: (id, name) => ipcRenderer.invoke(IPC.voicesRename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.voicesRemove, id),
    speak: (id, text, speed) => ipcRenderer.invoke(IPC.voicesSpeak, id, text, speed),
    cancel: () => ipcRenderer.invoke(IPC.voicesCancel),
    allowMicrophone: () => ipcRenderer.invoke(IPC.voicesMicrophone),
    pickFile: () => ipcRenderer.invoke(IPC.voicesPickFile),
    onStatus: (callback) => subscribe<[string]>(IPC.voicesStatus, callback),
    onChange: (callback) => subscribe<[CustomVoice[]]>(IPC.voicesChanged, callback)
  },

  recorder: {
    support: () => ipcRenderer.invoke(IPC.recorderSupport),
    sources: () => ipcRenderer.invoke(IPC.recorderSources),
    pickArea: (displayId) => ipcRenderer.invoke(IPC.recorderPickArea, displayId),
    allowCamera: () => ipcRenderer.invoke(IPC.recorderAllowCamera),
    start: (options) => ipcRenderer.invoke(IPC.recorderStart, options),
    command: (command) => ipcRenderer.invoke(IPC.recorderCommand, command),
    reveal: (path) => ipcRenderer.invoke(IPC.recorderReveal, path),
    onStatus: (callback) => subscribe<[RecorderStatus | null]>(IPC.recorderStatus, callback),
    onResult: (callback) => subscribe<[RecordingResult]>(IPC.recorderResult, callback),
    onError: (callback) => subscribe<[string]>(IPC.recorderError, callback),
    onRecovered: (callback) => subscribe<[string[]]>(IPC.recorderRecovered, callback),
    session: () => ipcRenderer.invoke(IPC.recorderSession),
    write: (role, position, data) => ipcRenderer.invoke(IPC.recorderWrite, role, position, data),
    report: (status) => ipcRenderer.send(IPC.recorderReport, status),
    layout: (view) => ipcRenderer.invoke(IPC.recorderLayout, view),
    finish: (summary) => ipcRenderer.invoke(IPC.recorderFinish, summary),
    fail: (message) => ipcRenderer.invoke(IPC.recorderFail, message),
    discarded: () => ipcRenderer.invoke(IPC.recorderDiscarded),
    onCommand: (callback) => subscribe<[RecorderCommand]>(IPC.recorderToWindow, callback),
    areaDisplay: () => ipcRenderer.invoke(IPC.recorderAreaDisplay),
    areaDone: (area) => ipcRenderer.invoke(IPC.recorderAreaDone, area),
    cameraView: () => ipcRenderer.invoke(IPC.recorderCameraView)
  },

  generation: {
    settings: () => ipcRenderer.invoke(IPC.generationSettings),
    update: (update) => ipcRenderer.invoke(IPC.generationUpdate, update),
    capabilities: (service, model) => ipcRenderer.invoke(IPC.generationCapabilities, service, model),
    estimate: (request) => ipcRenderer.invoke(IPC.generationEstimate, request),
    start: (request) => ipcRenderer.invoke(IPC.generationStart, request),
    cancel: (id) => ipcRenderer.invoke(IPC.generationCancel, id),
    jobs: () => ipcRenderer.invoke(IPC.generationJobs),
    test: (service) => ipcRenderer.invoke(IPC.generationTest, service),
    pickWorkflow: () => ipcRenderer.invoke(IPC.generationPickWorkflow),
    onJob: (callback) => subscribe<[GenerationJob]>(IPC.generationEvent, callback)
  },

  localAi: {
    searchFrames: (path, duration) => ipcRenderer.invoke(IPC.localAiSearchFrames, path, duration),
    readSearchIndex: (path, model) => ipcRenderer.invoke(IPC.localAiReadIndex, path, model),
    writeSearchIndex: (path, model, data) => ipcRenderer.invoke(IPC.localAiWriteIndex, path, model, data),
    reduceNoise: (path, strength, duration) =>
      ipcRenderer.invoke(IPC.localAiReduceNoise, path, strength, duration),
    onNoiseProgress: (callback) =>
      subscribe<[string, number]>(IPC.localAiNoiseProgress, (path, fraction) => callback(path, fraction)),
    startMatte: (path, start, duration, fps, width, height) =>
      ipcRenderer.invoke(IPC.localAiStartMatte, path, start, duration, fps, width, height),
    readMatteFrames: (id, max) => ipcRenderer.invoke(IPC.localAiReadFrames, id, max),
    writeMatteMasks: (id, masks) => ipcRenderer.invoke(IPC.localAiWriteMasks, id, masks),
    finishMatte: (id) => ipcRenderer.invoke(IPC.localAiFinishMatte, id),
    cancelMatte: (id) => ipcRenderer.invoke(IPC.localAiCancelMatte, id)
  },

  updates: {
    status: () => ipcRenderer.invoke(IPC.updatesGet),
    check: () => ipcRenderer.invoke(IPC.updatesCheck),
    install: () => ipcRenderer.invoke(IPC.updatesInstall),
    onStatus: (callback) => subscribe<[UpdateStatus]>(IPC.updatesStatus, callback)
  },

  recovery: {
    save: (snapshot) => ipcRenderer.invoke(IPC.recoverySave, snapshot),
    read: () => ipcRenderer.invoke(IPC.recoveryRead),
    clear: () => ipcRenderer.invoke(IPC.recoveryClear)
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
    installClaude: () => ipcRenderer.invoke(IPC.aiInstallClaude),
    connectClaudeCode: () => ipcRenderer.invoke(IPC.aiConnectClaudeCode)
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
