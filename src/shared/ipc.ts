import type { ExportProgress, ExportResult, ExportSettings } from './export-formats'
import type { OverlayImage } from './ffmpeg-graph'
import type { ToolResult } from './ai-tools'
import type { ModelStatus } from './models'
import type { RecoverySnapshot, UpdateStatus } from './updates'
import type { AssistantEvent, AssistantSettings, ProviderId, ProviderUpdate } from './assistant'
import type {
  AiStatus,
  AppSettings,
  Filmstrip,
  MediaAnalysis,
  MediaFileList,
  ProbeResult,
  Project,
  ProxyStatus,
  RecentProject,
  SampledFrame,
  ToolInfo,
  Waveform
} from './types'

export type MenuCommand =
  | 'new-project'
  | 'open-project'
  | 'save'
  | 'save-as'
  | 'import-media'
  | 'export'
  | 'close-project'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'ripple-delete'
  | 'select-all'
  | 'split'
  | 'add-marker'
  | 'add-text'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'toggle-snapping'
  | 'play-pause'
  | 'go-start'
  | 'go-end'
  | 'preferences'
  | 'shortcuts'
  | 'about'
  | 'check-updates'

export type ClaudeCodeResult =
  | { ok: true }
  /** The command to run by hand, when the claude command was not found or failed. */
  | { ok: false; reason: 'not-found' | 'failed'; command: string; error?: string }

export interface OpenedProject {
  path: string
  data: unknown
}

export interface ExportRequest {
  project: Project
  settings: ExportSettings
  /** PNG bytes for text clips, keyed by clip id. */
  overlays: Record<string, { png: Uint8Array; width: number; height: number }>
}

export type { OverlayImage }

export interface AiCall {
  callId: number
  name: string
  args: Record<string, unknown>
}

export interface KificutApi {
  platform: string
  homeDir: string
  versions: { app: string; electron: string; chrome: string; node: string }
  getPathForFile(file: File): string

  media: {
    pick(): Promise<string[]>
    probe(paths: string[]): Promise<ProbeResult[]>
    poster(path: string, duration: number): Promise<string | null>
    filmstrip(path: string, duration: number): Promise<Filmstrip | null>
    waveform(path: string): Promise<Waveform | null>
    exists(paths: string[]): Promise<boolean[]>
    locate(name: string): Promise<string | null>
    proxy(path: string): Promise<ProxyStatus>
    onProxyProgress(callback: (path: string, status: ProxyStatus) => void): () => void
    listFiles(folder: string, recursive: boolean): Promise<MediaFileList>
    sampleFrames(
      path: string,
      duration: number,
      count: number,
      start?: number,
      end?: number
    ): Promise<SampledFrame[]>
    analyze(path: string, duration: number, hasVideo: boolean, hasAudio: boolean): Promise<MediaAnalysis>
    /** Mono PCM samples of the file's audio, for speech recognition. */
    decodeAudio(path: string, sampleRate: number): Promise<Float32Array>
    /** Saves generated audio (WAV bytes) to Documents/Kificut/Generated and returns the path. */
    saveGenerated(name: string, data: Uint8Array): Promise<string>
  }

  models: {
    list(): Promise<ModelStatus[]>
    install(id: string): Promise<ModelStatus>
    cancel(id: string): Promise<void>
    remove(id: string): Promise<ModelStatus>
    onStatus(callback: (status: ModelStatus) => void): () => void
  }

  /** FFmpeg work for the local AI features. */
  localAi: {
    /** Small square RGB frames through the file, for footage search. */
    searchFrames(
      path: string,
      duration: number
    ): Promise<{ times: number[]; width: number; height: number; data: Uint8Array }>
    readSearchIndex(path: string, model: string): Promise<string | null>
    writeSearchIndex(path: string, model: string, data: string): Promise<void>
    /** Writes a denoised copy of the file's sound and returns its path. */
    reduceNoise(path: string, strength: number, duration: number): Promise<string>
    onNoiseProgress(callback: (path: string, fraction: number) => void): () => void
    startMatte(
      path: string,
      start: number,
      duration: number,
      fps: number,
      width: number,
      height: number
    ): Promise<{ id: number; width: number; height: number; frames: number }>
    readMatteFrames(id: number, max: number): Promise<Uint8Array>
    writeMatteMasks(id: number, masks: Uint8Array): Promise<void>
    finishMatte(id: number): Promise<string>
    cancelMatte(id: number): Promise<void>
  }

  updates: {
    status(): Promise<UpdateStatus>
    /** Checks now and reports the result even when there is nothing new. */
    check(): Promise<UpdateStatus>
    /** Closes Kificut and installs the downloaded update. Save a recovery copy first. */
    install(): Promise<void>
    onStatus(callback: (status: UpdateStatus) => void): () => void
  }

  recovery: {
    save(snapshot: RecoverySnapshot): Promise<void>
    read(): Promise<RecoverySnapshot | null>
    clear(): Promise<void>
  }

  assistant: {
    settings(): Promise<AssistantSettings>
    updateProvider(update: ProviderUpdate): Promise<AssistantSettings>
    setActive(id: ProviderId | null): Promise<AssistantSettings>
    /** Models the provider offers. Also checks that the key and address work. */
    listModels(id: ProviderId): Promise<Array<{ id: string; name: string }>>
    /** Starts a reply; progress arrives through onEvent. Returns the turn id. */
    send(text: string): Promise<number>
    stop(): Promise<void>
    /** Forgets the conversation. */
    reset(): Promise<void>
    onEvent(callback: (event: AssistantEvent) => void): () => void
  }

  ai: {
    /** Tool calls arriving from a connected assistant. Answer each with respond(). */
    onCall(callback: (call: AiCall) => void): () => void
    respond(callId: number, result: ToolResult): void
    /** Tells Kificut the renderer can take tool calls. */
    ready(): void
    status(): Promise<AiStatus>
    onStatus(callback: (status: AiStatus) => void): () => void
    /** Opens the bundled Claude Desktop connector so Claude Desktop installs it. */
    installClaude(): Promise<{ ok: boolean; error?: string }>
    /** Registers Kificut with Claude Code through its `claude mcp add` command. */
    connectClaudeCode(): Promise<ClaudeCodeResult>
  }

  project: {
    open(): Promise<OpenedProject | null>
    openPath(path: string): Promise<OpenedProject>
    save(path: string | null, data: unknown, suggestedName: string): Promise<string | null>
    recent(): Promise<RecentProject[]>
    removeRecent(path: string): Promise<RecentProject[]>
    setState(state: { dirty: boolean; title: string; hasProject: boolean }): void
  }

  exporter: {
    chooseOutput(defaultName: string, extension: string, formatLabel: string): Promise<string | null>
    start(request: ExportRequest): Promise<ExportResult>
    cancel(): Promise<void>
    onProgress(callback: (progress: ExportProgress) => void): () => void
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    tools(): Promise<ToolInfo>
    pickBinary(): Promise<string | null>
  }

  shell: {
    showItemInFolder(path: string): void
    openExternal(url: string): void
  }

  app: {
    closeWindow(force: boolean): void
    onMenuCommand(callback: (command: MenuCommand) => void): () => void
    onCloseRequest(callback: () => void): () => void
    onOpenProject(callback: (path: string) => void): () => void
  }
}

export const IPC = {
  mediaPick: 'media:pick',
  mediaProbe: 'media:probe',
  mediaPoster: 'media:poster',
  mediaFilmstrip: 'media:filmstrip',
  mediaWaveform: 'media:waveform',
  mediaExists: 'media:exists',
  mediaLocate: 'media:locate',
  mediaProxy: 'media:proxy',
  mediaProxyProgress: 'media:proxy-progress',
  projectOpen: 'project:open',
  projectOpenPath: 'project:open-path',
  projectSave: 'project:save',
  projectRecent: 'project:recent',
  projectRemoveRecent: 'project:remove-recent',
  projectState: 'project:state',
  exportChoose: 'export:choose',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsTools: 'settings:tools',
  settingsPickBinary: 'settings:pick-binary',
  shellShow: 'shell:show',
  shellOpen: 'shell:open',
  appClose: 'app:close',
  appMenu: 'app:menu',
  appCloseRequest: 'app:close-request',
  appOpenProject: 'app:open-project',
  mediaListFiles: 'media:list-files',
  mediaSampleFrames: 'media:sample-frames',
  mediaAnalyze: 'media:analyze',
  aiCall: 'ai:call',
  aiResult: 'ai:result',
  aiReady: 'ai:ready',
  aiStatus: 'ai:status',
  aiStatusChanged: 'ai:status-changed',
  aiInstallClaude: 'ai:install-claude',
  mediaDecodeAudio: 'media:decode-audio',
  mediaSaveGenerated: 'media:save-generated',
  modelsList: 'models:list',
  modelsInstall: 'models:install',
  modelsCancel: 'models:cancel',
  modelsRemove: 'models:remove',
  modelsStatus: 'models:status',
  updatesStatus: 'updates:status',
  localAiSearchFrames: 'local-ai:search-frames',
  localAiReadIndex: 'local-ai:read-index',
  localAiWriteIndex: 'local-ai:write-index',
  localAiReduceNoise: 'local-ai:reduce-noise',
  localAiNoiseProgress: 'local-ai:noise-progress',
  localAiStartMatte: 'local-ai:start-matte',
  localAiReadFrames: 'local-ai:read-frames',
  localAiWriteMasks: 'local-ai:write-masks',
  localAiFinishMatte: 'local-ai:finish-matte',
  localAiCancelMatte: 'local-ai:cancel-matte',
  updatesGet: 'updates:get',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  recoverySave: 'recovery:save',
  recoveryRead: 'recovery:read',
  recoveryClear: 'recovery:clear',
  aiConnectClaudeCode: 'ai:connect-claude-code',
  assistantSettings: 'assistant:settings',
  assistantUpdateProvider: 'assistant:update-provider',
  assistantSetActive: 'assistant:set-active',
  assistantListModels: 'assistant:list-models',
  assistantSend: 'assistant:send',
  assistantStop: 'assistant:stop',
  assistantReset: 'assistant:reset',
  assistantEvent: 'assistant:event'
} as const
