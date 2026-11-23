import type { ExportResult, ExportSettings } from '@shared/export-formats'
import type { ExportRequest } from '@shared/ipc'
import { activeEffects, fxImageKey } from '@shared/effects'
import { exportLayerSize, exportScale } from '@shared/ffmpeg-graph'
import { useEditor } from '../store/editor'
import { textToPng } from './text'
import { clipLayer } from './layers'
import { borderImage, canvasToPng, maskImage, vignetteImage } from './decor'

/**
 * Rasterizes text layers and the mask, border and vignette images of clips in the export range,
 * at the size the export scales each layer to, and hands the job to the main process.
 */
export async function runExport(settings: ExportSettings): Promise<ExportResult> {
  const project = useEditor.getState().project
  if (!project) return { ok: false, error: 'No project is open.' }

  const visibleTracks = new Set(
    project.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
  )
  const k = exportScale(project, settings)
  const overlays: ExportRequest['overlays'] = {}
  for (const clip of project.clips) {
    if (clip.kind === 'audio' || !visibleTracks.has(clip.trackId)) continue
    if (clip.start + clip.duration <= settings.start || clip.start >= settings.end) continue
    if (clip.kind === 'text') {
      if (!clip.text) continue
      overlays[clip.id] = await textToPng(clip.text)
    }

    const [width, height] = exportLayerSize(clipLayer(project, clip), k)
    const add = async (key: string, canvas: HTMLCanvasElement) => {
      overlays[key] = { png: await canvasToPng(canvas), width, height }
    }
    if (clip.mask) await add(fxImageKey.mask(clip.id), maskImage(clip.mask, width, height, k))
    if (clip.border) {
      await add(fxImageKey.border(clip.id), borderImage(clip.mask ?? null, clip.border, width, height, k))
    }
    for (const effect of activeEffects(clip)) {
      if (effect.type === 'vignette') {
        await add(fxImageKey.vignette(clip.id, effect.id), vignetteImage(effect, width, height))
      }
    }
  }

  return window.kificut.exporter.start({ project, settings, overlays })
}
