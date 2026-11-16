import { computeLayer, fitsToFrame, type LayerRect } from '@shared/geometry'
import type { Clip, MediaItem, Project } from '@shared/types'
import { rasterizeText } from './text'

export function clipSourceSize(project: Project, clip: Clip, media?: MediaItem): [number, number] {
  const { width, height } = project.settings
  if (clip.kind === 'text' && clip.text) {
    const raster = rasterizeText(clip.text)
    return [raster.width, raster.height]
  }
  if (clip.kind === 'solid') return [width, height]
  const item = media ?? project.media.find((m) => m.id === clip.mediaId)
  return [item?.width || width, item?.height || height]
}

export function clipLayer(project: Project, clip: Clip, media?: MediaItem): LayerRect {
  const [sw, sh] = clipSourceSize(project, clip, media)
  const { width, height } = project.settings
  return computeLayer(clip.transform, sw, sh, width, height, fitsToFrame(clip.kind))
}

/** Visual clips on screen at a time, from the bottom layer to the top. */
export function visibleClipsAt(project: Project, time: number): Clip[] {
  const result: Clip[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || clip.kind === 'audio') continue
      if (time >= clip.start && time < clip.start + clip.duration) result.push(clip)
    }
  }
  return result
}
