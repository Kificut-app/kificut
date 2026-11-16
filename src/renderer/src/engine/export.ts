import type { ExportResult, ExportSettings } from '@shared/export-formats'
import type { ExportRequest } from '@shared/ipc'
import { useEditor } from '../store/editor'
import { textToPng } from './text'

/** Rasterizes text layers in the export range and hands the job to the main process. */
export async function runExport(settings: ExportSettings): Promise<ExportResult> {
  const project = useEditor.getState().project
  if (!project) return { ok: false, error: 'No project is open.' }

  const visibleTracks = new Set(
    project.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
  )
  const overlays: ExportRequest['overlays'] = {}
  for (const clip of project.clips) {
    if (clip.kind !== 'text' || !clip.text || !visibleTracks.has(clip.trackId)) continue
    if (clip.start + clip.duration <= settings.start || clip.start >= settings.end) continue
    overlays[clip.id] = await textToPng(clip.text)
  }

  return window.kificut.exporter.start({ project, settings, overlays })
}
