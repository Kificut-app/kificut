import type { ExportProgress, ExportResult, ExportSettings } from './export-formats'
import type { OverlayImage } from './ffmpeg-graph'
import type {
  AppSettings,
  Filmstrip,
  ProbeResult,
  Project,
  ProxyStatus,
  RecentProject,
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

export interface KificutApi {
  platform: string
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
  appOpenProject: 'app:open-project'
} as const
