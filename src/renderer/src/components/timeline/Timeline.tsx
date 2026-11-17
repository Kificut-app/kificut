import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react'
import { snapToFrame } from '@shared/time'
import type { Clip, MediaItem, Project, Track } from '@shared/types'
import {
  beginGesture,
  clearSelection,
  endGesture,
  select,
  updateGesture,
  useEditor
} from '../../store/editor'
import {
  addSolidClip,
  addTextClip,
  addTrack,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  importPaths,
  linkSelection,
  pasteClipboard,
  placeMedia,
  removeTrack,
  splitAt,
  splitAtPlayhead,
  unlinkSelection,
  updateClips,
  updateTrack,
  zoomBy
} from '../../store/actions'
import { openMenu, type MenuEntry } from '../../store/ui'
import { generateCaptions, reduceNoise, removeBackground } from '../../local-ai/commands'
import { uid, defaultTransform } from '../../lib/factory'
import {
  clipEnd,
  displayTracks,
  maxDuration,
  projectDuration,
  resolveOverlaps,
  snapOffset,
  snapPoints,
  snapValue,
  tracksOfKind,
  withLinked
} from '../../lib/timeline'
import {
  AUDIO_TRACK_HEIGHT,
  HEADER_WIDTH,
  RULER_HEIGHT,
  VIDEO_TRACK_HEIGHT,
  timelineView
} from '../../lib/timeline-view'
import { activeDrag, droppedPaths, endDrag, hasFiles } from '../../lib/drag'
import { deleteKey, isMac, modKey, shiftKey } from '../../lib/platform'
import { player } from '../../engine/player'
import { formatTimecode } from '@shared/time'
import { IconButton, cx } from '../ui/controls'
import { ClipView, type ClipPart } from './ClipView'
import { Ruler } from './Ruler'
import { TimelineToolbar } from './TimelineToolbar'
import { AudioMeter } from './AudioMeter'

const SNAP_PX = 9
const DRAG_THRESHOLD = 3

function trackHeight(track: Track): number {
  return track.kind === 'video' ? VIDEO_TRACK_HEIGHT : AUDIO_TRACK_HEIGHT
}

type DragMode = 'move' | Exclude<ClipPart, 'body'>

interface DragState {
  part: DragMode
  pointerId: number
  startX: number
  startY: number
  clipId: string
  ids: Set<string>
  base: Project
  started: boolean
  duplicate: boolean
  copyIds: Map<string, string>
  copyLinks: Map<string, string>
}

interface MarqueeState {
  x0: number
  y0: number
  x1: number
  y1: number
  additive: boolean
  base: string[]
}

interface DropPreview {
  trackId: string | null
  start: number
  duration: number
}

/** AI actions for a clip: captions, noise reduction and background removal. */
function aiMenuItems(clip: Clip, count: number): MenuEntry[] {
  const single = count === 1 && Boolean(clip.mediaId)
  const project = useEditor.getState().project
  const media = project?.media.find((m) => m.id === clip.mediaId)
  const speech = single && (clip.kind === 'video' || clip.kind === 'audio') && Boolean(media?.hasAudio)
  const linkedAudio =
    clip.kind === 'audio' ||
    Boolean(clip.linkId && project?.clips.some((c) => c.kind === 'audio' && c.linkId === clip.linkId))
  return [
    { label: 'Generate Captions', disabled: !speech, run: () => void generateCaptions(clip.id) },
    {
      label: 'Generate English Captions',
      disabled: !speech,
      run: () => void generateCaptions(clip.id, true)
    },
    { label: 'Reduce Noise', disabled: !single || !linkedAudio, run: () => void reduceNoise(clip.id) },
    {
      label: 'Remove Background',
      disabled: !single || (clip.kind !== 'video' && clip.kind !== 'image') || Boolean(media?.alpha),
      run: () => void removeBackground(clip.id, clip.kind === 'video')
    }
  ]
}

export function Timeline() {
  const project = useEditor((s) => s.project!)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const tool = useEditor((s) => s.tool)
  const offline = useEditor((s) => s.offline)
  const showThumbnails = useEditor((s) => s.settings?.showThumbnails ?? true)
  const showWaveforms = useEditor((s) => s.settings?.showWaveforms ?? true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 1000 })
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [drop, setDrop] = useState<DropPreview | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const drag = useRef<DragState | null>(null)

  const tracks = useMemo(() => displayTracks(project), [project])
  const mediaById = useMemo(
    () => new Map<string, MediaItem>(project.media.map((m) => [m.id, m])),
    [project.media]
  )
  const selected = useMemo(() => new Set(selection), [selection])
  const duration = projectDuration(project)
  const contentWidth = Math.max(view.width, (duration + Math.max(20, (view.width / zoom) * 0.6)) * zoom)
  const contentHeight = RULER_HEIGHT + tracks.reduce((sum, t) => sum + trackHeight(t), 0) + 72

  useLayoutEffect(() => {
    timelineView.element = scrollRef.current
    return () => {
      timelineView.element = null
    }
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current!
    if (timelineView.pendingScrollLeft !== null) {
      el.scrollLeft = timelineView.pendingScrollLeft
      timelineView.pendingScrollLeft = null
    }
    setView({ left: el.scrollLeft, width: el.clientWidth - HEADER_WIDTH })
  }, [zoom, contentWidth])

  useEffect(() => {
    const el = scrollRef.current!
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() =>
        setView({ left: el.scrollLeft, width: el.clientWidth - HEADER_WIDTH })
      )
    }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    el.addEventListener('scroll', update, { passive: true })

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const time = (e.clientX - rect.left - HEADER_WIDTH + el.scrollLeft) / useEditor.getState().zoom
      zoomBy(Math.exp(-e.deltaY * 0.0025), Math.max(0, time))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', update)
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Keep the playhead in view while playing or stepping through frames.
  useEffect(() => {
    return useEditor.subscribe((state, prev) => {
      if (state.playhead === prev.playhead || drag.current) return
      const el = scrollRef.current
      if (!el) return
      const x = state.playhead * state.zoom
      const width = el.clientWidth - HEADER_WIDTH
      if (x > el.scrollLeft + width - 24) el.scrollLeft = state.playing ? x - 24 : x - width * 0.5
      else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - (state.playing ? 24 : width * 0.5))
    })
  }, [])

  const timeAt = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current!
      const rect = el.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left - HEADER_WIDTH + el.scrollLeft) / zoom)
    },
    [zoom]
  )

  const trackAt = (clientY: number): Track | null => {
    const rows = scrollRef.current!.querySelectorAll<HTMLElement>('[data-track-id]')
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      if (clientY >= rect.top && clientY < rect.bottom) {
        return useEditor.getState().project!.tracks.find((t) => t.id === row.dataset.trackId) ?? null
      }
    }
    return null
  }

  /* Clip dragging */

  const applyDrag = (d: DragState, clientX: number, clientY: number, final: boolean, shift: boolean) => {
    const state = useEditor.getState()
    const base = d.base
    const fps = base.settings.fps
    const frame = 1 / fps
    const threshold = SNAP_PX / zoom
    const snapping = state.snapping !== shift
    const dx = (clientX - d.startX) / zoom
    const grabbed = base.clips.find((c) => c.id === d.clipId)!
    let line: number | null = null

    if (d.part === 'move') {
      const moving = base.clips.filter((c) => d.ids.has(c.id))
      const minStart = Math.min(...moving.map((c) => c.start))
      let delta = Math.max(-minStart, dx)
      if (snapping) {
        const edges = moving.flatMap((c) => [c.start, clipEnd(c)])
        const exclude = d.duplicate ? new Set<string>() : d.ids
        const snapped = snapOffset(edges, delta, snapPoints(base, exclude, state.playhead), threshold)
        delta = Math.max(-minStart, snapped.delta)
        line = snapped.point
      }

      const grabbedTrack = base.tracks.find((t) => t.id === grabbed.trackId)!
      const kindTracks = tracksOfKind(base, grabbedTrack.kind)
      const hovered = trackAt(clientY)
      let shiftIndex = 0
      if (hovered && hovered.kind === grabbedTrack.kind) {
        shiftIndex =
          kindTracks.findIndex((t) => t.id === hovered.id) -
          kindTracks.findIndex((t) => t.id === grabbedTrack.id)
        const indices = moving
          .filter((c) => kindTracks.some((t) => t.id === c.trackId))
          .map((c) => kindTracks.findIndex((t) => t.id === c.trackId))
        const lo = -Math.min(...indices)
        const hi = kindTracks.length - 1 - Math.max(...indices)
        shiftIndex = Math.max(lo, Math.min(hi, shiftIndex))
        if (indices.some((i) => kindTracks[i + shiftIndex]?.locked)) shiftIndex = 0
      }

      updateGesture((draft) => {
        const moved: string[] = []
        for (const original of moving) {
          const kindIndex = kindTracks.findIndex((t) => t.id === original.trackId)
          const trackId = kindIndex >= 0 ? kindTracks[kindIndex + shiftIndex].id : original.trackId
          const start = Math.max(0, snapToFrame(original.start + delta, fps))
          if (d.duplicate) {
            const copy: Clip = JSON.parse(JSON.stringify(original))
            copy.id = d.copyIds.get(original.id)!
            copy.linkId = original.linkId ? d.copyLinks.get(original.linkId)! : null
            copy.start = start
            copy.trackId = trackId
            draft.clips.push(copy)
            moved.push(copy.id)
          } else {
            const target = draft.clips.find((c) => c.id === original.id)!
            target.start = start
            target.trackId = trackId
            moved.push(target.id)
          }
        }
        if (final) resolveOverlaps(draft as Project, moved)
      })
      if (final && d.duplicate) select([...d.copyIds.values()])
    } else if (d.part === 'trim-start' || d.part === 'trim-end') {
      const group = base.clips.filter((c) => d.ids.has(c.id))
      let lo = -Infinity
      let hi = Infinity
      for (const c of group) {
        const neighbours = base.clips.filter((o) => o.trackId === c.trackId && !d.ids.has(o.id))
        const media = c.mediaId ? base.media.find((m) => m.id === c.mediaId) : undefined
        if (d.part === 'trim-start') {
          const prevEnd = Math.max(0, ...neighbours.filter((o) => clipEnd(o) <= c.start + 1e-6).map(clipEnd))
          const sourceLimit =
            c.kind === 'video' || c.kind === 'audio' ? c.start - c.inPoint / c.speed : -Infinity
          lo = Math.max(lo, Math.max(prevEnd, sourceLimit) - c.start)
          hi = Math.min(hi, c.duration - frame)
        } else {
          const nextStart = Math.min(
            Infinity,
            ...neighbours.filter((o) => o.start >= clipEnd(c) - 1e-6).map((o) => o.start)
          )
          const limit = c.start + maxDuration(c, media)
          lo = Math.max(lo, frame - c.duration)
          hi = Math.min(hi, Math.min(nextStart, limit) - clipEnd(c))
        }
      }
      const edge = d.part === 'trim-start' ? grabbed.start : clipEnd(grabbed)
      let delta = dx
      if (snapping) {
        const snapped = snapValue(edge + delta, snapPoints(base, d.ids, state.playhead), threshold)
        if (snapped.point !== null) {
          delta = snapped.value - edge
          line = snapped.point
        }
      }
      delta = snapToFrame(Math.max(lo, Math.min(hi, delta)), fps)
      if (delta < lo - 1e-9 || delta > hi + 1e-9) delta = Math.max(lo, Math.min(hi, delta))

      updateGesture((draft) => {
        for (const c of draft.clips) {
          if (!d.ids.has(c.id)) continue
          if (d.part === 'trim-start') {
            c.start += delta
            c.duration -= delta
            c.inPoint = Math.max(0, c.inPoint + delta * c.speed)
          } else {
            c.duration += delta
          }
          c.fadeIn = Math.min(c.fadeIn, c.duration)
          c.fadeOut = Math.min(c.fadeOut, c.duration - c.fadeIn)
        }
      })
    } else {
      updateGesture((draft) => {
        for (const c of draft.clips) {
          if (!d.ids.has(c.id)) continue
          const original = base.clips.find((o) => o.id === c.id)!
          if (d.part === 'fade-in') {
            c.fadeIn = Math.max(0, Math.min(c.duration - c.fadeOut, snapToFrame(original.fadeIn + dx, fps)))
          } else {
            c.fadeOut = Math.max(0, Math.min(c.duration - c.fadeIn, snapToFrame(original.fadeOut - dx, fps)))
          }
        }
      })
    }
    setSnapLine(final ? null : line)
  }

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip, part: ClipPart) => {
      if (e.button !== 0) return
      const state = useEditor.getState()
      const current = state.project!
      const track = current.tracks.find((t) => t.id === clip.trackId)
      if (track?.locked) return
      e.stopPropagation()

      if (state.tool === 'razor' && part === 'body') {
        let t = timeAt(e.clientX)
        if (state.snapping) t = snapValue(t, [state.playhead], SNAP_PX / zoom).value
        splitAt(clip.id, t)
        return
      }

      const additive = e.shiftKey || (isMac ? e.metaKey : e.ctrlKey)
      if (additive) {
        select([clip.id], 'toggle')
        return
      }
      if (!state.selection.includes(clip.id)) select([clip.id])

      const selectionNow = useEditor.getState().selection
      const ids =
        part === 'body'
          ? new Set(
              selectionNow.filter((id) => {
                const c = current.clips.find((x) => x.id === id)
                return c && !current.tracks.find((t) => t.id === c.trackId)?.locked
              })
            )
          : new Set(withLinked(current, [clip.id]))

      const copyIds = new Map<string, string>()
      const copyLinks = new Map<string, string>()
      if (e.altKey && part === 'body') {
        for (const id of ids) copyIds.set(id, uid('c'))
        for (const c of current.clips)
          if (ids.has(c.id) && c.linkId && !copyLinks.has(c.linkId)) copyLinks.set(c.linkId, uid('l'))
      }

      drag.current = {
        part: part === 'body' ? 'move' : part,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        clipId: clip.id,
        ids,
        base: current,
        started: false,
        duplicate: e.altKey && part === 'body',
        copyIds,
        copyLinks
      }

      const move = (ev: PointerEvent) => {
        const d = drag.current
        if (!d || ev.pointerId !== d.pointerId) return
        if (!d.started) {
          if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_THRESHOLD) return
          d.started = true
          player.pause()
          beginGesture()
          d.base = useEditor.getState().gestureBase!
        }
        applyDrag(d, ev.clientX, ev.clientY, false, ev.shiftKey)
      }
      const up = (ev: PointerEvent) => {
        const d = drag.current
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('keydown', key)
        drag.current = null
        if (!d || !d.started) return
        applyDrag(d, ev.clientX, ev.clientY, true, ev.shiftKey)
        endGesture()
        setSnapLine(null)
      }
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('keydown', key)
        const d = drag.current
        drag.current = null
        if (d?.started) endGesture(true)
        setSnapLine(null)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('keydown', key)
    },
    // applyDrag reads fresh state through the store, so only zoom-dependent helpers matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, timeAt]
  )

  const onClipContextMenu = useCallback((e: React.MouseEvent, clip: Clip) => {
    const state = useEditor.getState()
    if (!state.selection.includes(clip.id)) select([clip.id])
    const count = useEditor.getState().selection.length
    openMenu(e, [
      { label: 'Split at Playhead', shortcut: 'S', run: splitAtPlayhead },
      { separator: true },
      { label: 'Cut', shortcut: `${modKey}X`, run: cutSelection },
      { label: 'Copy', shortcut: `${modKey}C`, run: () => void copySelection() },
      { label: 'Paste', shortcut: `${modKey}V`, run: pasteClipboard },
      { label: 'Duplicate', shortcut: `${modKey}D`, run: duplicateSelection },
      { separator: true },
      clip.linkId
        ? { label: 'Unlink', run: unlinkSelection }
        : { label: 'Link', disabled: count < 2, run: linkSelection },
      {
        label: 'Reset Transform',
        disabled: clip.kind === 'audio',
        run: () =>
          updateClips(useEditor.getState().selection, (c) => {
            c.transform = defaultTransform()
          })
      },
      { separator: true },
      ...aiMenuItems(clip, count),
      { separator: true },
      { label: 'Delete', shortcut: deleteKey, danger: true, run: () => deleteSelection(false) },
      {
        label: 'Ripple Delete',
        shortcut: `${shiftKey}${deleteKey}`,
        danger: true,
        run: () => deleteSelection(true)
      }
    ])
  }, [])

  /* Empty area: marquee selection */

  const onLanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.clip')) return
    const el = scrollRef.current!
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left + el.scrollLeft
    const y = e.clientY - rect.top + el.scrollTop
    const additive = e.shiftKey || (isMac ? e.metaKey : e.ctrlKey)
    const start: MarqueeState = {
      x0: x,
      y0: y,
      x1: x,
      y1: y,
      additive,
      base: additive ? useEditor.getState().selection : []
    }
    let moved = false

    const move = (ev: PointerEvent) => {
      const nx = ev.clientX - rect.left + el.scrollLeft
      const ny = ev.clientY - rect.top + el.scrollTop
      if (!moved && Math.hypot(nx - x, ny - y) < DRAG_THRESHOLD) return
      moved = true
      const next = { ...start, x1: nx, y1: ny }
      setMarquee(next)
      const left = Math.min(next.x0, next.x1) - el.scrollLeft + rect.left
      const right = Math.max(next.x0, next.x1) - el.scrollLeft + rect.left
      const top = Math.min(next.y0, next.y1) - el.scrollTop + rect.top
      const bottom = Math.max(next.y0, next.y1) - el.scrollTop + rect.top
      const hits: string[] = []
      el.querySelectorAll<HTMLElement>('[data-clip-id]').forEach((node) => {
        const r = node.getBoundingClientRect()
        if (r.right > left && r.left < right && r.bottom > top && r.top < bottom)
          hits.push(node.dataset.clipId!)
      })
      const proj = useEditor.getState().project!
      const lockedTracks = new Set(proj.tracks.filter((t) => t.locked).map((t) => t.id))
      const allowed = hits.filter(
        (id) => !lockedTracks.has(proj.clips.find((c) => c.id === id)?.trackId ?? '')
      )
      useEditor.setState({ selection: [...new Set([...start.base, ...withLinked(proj, allowed)])] })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!moved && !additive) clearSelection()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /* Drag and drop from the media panel or the file system */

  const dropTarget = (e: React.DragEvent): DropPreview => {
    const state = useEditor.getState()
    let start = timeAt(e.clientX)
    if (state.snapping)
      start = snapValue(start, snapPoints(project, new Set(), state.playhead), SNAP_PX / zoom).value
    start = snapToFrame(start, project.settings.fps)
    const track = trackAt(e.clientY)
    let length = 5
    if (activeDrag?.type === 'media') {
      const item = mediaById.get(activeDrag.mediaId)
      if (item && item.kind !== 'image') length = item.duration
    }
    return { trackId: track?.id ?? null, start, duration: length }
  }

  const onDragOver = (e: React.DragEvent) => {
    if (!activeDrag && !hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const next = dropTarget(e)
    setDrop((prev) => (prev && prev.trackId === next.trackId && prev.start === next.start ? prev : next))
  }

  const onDrop = async (e: React.DragEvent) => {
    const target = dropTarget(e)
    setDrop(null)
    const payload = activeDrag
    endDrag()
    if (!payload && !hasFiles(e)) return
    e.preventDefault()
    const track = target.trackId ? project.tracks.find((t) => t.id === target.trackId) : undefined

    if (payload?.type === 'text' || payload?.type === 'solid') {
      const trackId = track?.kind === 'video' ? track.id : track ? undefined : addTrack('video')
      if (payload.type === 'text') addTextClip(payload.presetId, target.start, trackId)
      else addSolidClip(payload.color, target.start, trackId)
      return
    }

    const items: MediaItem[] = []
    if (payload?.type === 'media') {
      const item = mediaById.get(payload.mediaId)
      if (item) items.push(item)
    } else {
      items.push(...(await importPaths(droppedPaths(e))))
    }

    let time = target.start
    let trackId = track?.id ?? null
    for (const item of items) {
      if (!trackId) trackId = addTrack(item.kind === 'audio' ? 'audio' : 'video')
      placeMedia(item.id, time, trackId)
      time += item.kind === 'image' ? 5 : item.duration
    }
  }

  /* Rendering */

  const visibleLeft = view.left - 200
  const visibleRight = view.left + view.width + 200
  let y = RULER_HEIGHT
  const rows = tracks.map((track, index) => {
    const height = trackHeight(track)
    const top = y
    y += height
    const firstAudio = track.kind === 'audio' && tracks[index - 1]?.kind === 'video'
    return { track, height, top, firstAudio }
  })

  const marqueeRect = marquee && {
    left: Math.min(marquee.x0, marquee.x1),
    top: Math.min(marquee.y0, marquee.y1),
    width: Math.abs(marquee.x1 - marquee.x0),
    height: Math.abs(marquee.y1 - marquee.y0)
  }

  return (
    <section className="panel timeline">
      <TimelineToolbar />
      <div className="timeline__body">
        <div
          ref={scrollRef}
          className={cx('timeline__scroll', tool === 'razor' && 'is-razor')}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null)
          }}
          onDrop={(e) => void onDrop(e)}
          onPointerMove={(e) => tool === 'razor' && setHoverTime(timeAt(e.clientX))}
          onPointerLeave={() => setHoverTime(null)}
        >
          <div
            className="timeline__content"
            style={{ width: HEADER_WIDTH + contentWidth, height: contentHeight }}
          >
            <div className="ruler-row">
              <div className="ruler-row__corner">
                <CornerTimecode />
              </div>
              <Ruler left={view.left} width={view.width} zoom={zoom} />
              <PlayheadHead zoom={zoom} />
            </div>

            {rows.map(({ track, height, firstAudio }) => (
              <div
                key={track.id}
                className={cx(
                  'track-row',
                  `track-row--${track.kind}`,
                  firstAudio && 'is-first-audio',
                  track.locked && 'is-locked'
                )}
                style={{ height }}
                data-track-id={track.id}
              >
                <TrackHeader track={track} />
                <div className="track-lane" onPointerDown={onLanePointerDown}>
                  {drop && drop.trackId === track.id && (
                    <div
                      className="drop-ghost"
                      style={{ left: drop.start * zoom, width: Math.max(4, drop.duration * zoom) }}
                    />
                  )}
                  {project.clips.map((clip) => {
                    if (clip.trackId !== track.id) return null
                    const left = clip.start * zoom
                    const right = clipEnd(clip) * zoom
                    if (right < visibleLeft || left > visibleRight) return null
                    const media = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
                    return (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        media={media}
                        zoom={zoom}
                        height={height - 2}
                        selected={selected.has(clip.id)}
                        offline={!!(clip.mediaId && offline[clip.mediaId])}
                        dimmed={track.kind === 'audio' ? track.muted : track.hidden}
                        visibleLeft={Math.floor(view.left / 64) * 64 - 256}
                        visibleRight={Math.ceil((view.left + view.width) / 64) * 64 + 256}
                        showThumbnails={showThumbnails}
                        showWaveforms={showWaveforms}
                        onPointerDown={onClipPointerDown}
                        onContextMenu={onClipContextMenu}
                      />
                    )
                  })}
                </div>
              </div>
            ))}

            <div
              className={cx('track-drop-zone', drop && drop.trackId === null && 'is-active')}
              style={{ top: y }}
            >
              {drop && drop.trackId === null ? 'Release to add a new track' : ''}
            </div>

            <PlayheadLine zoom={zoom} />
            {hoverTime !== null && tool === 'razor' && (
              <div className="razor-line" style={{ left: HEADER_WIDTH + hoverTime * zoom }} />
            )}
            {snapLine !== null && (
              <div className="snap-line" style={{ left: HEADER_WIDTH + snapLine * zoom }} />
            )}
            {marqueeRect && <div className="marquee" style={marqueeRect} />}
          </div>
        </div>
        <AudioMeter />
      </div>
    </section>
  )
}

function CornerTimecode() {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project!.settings.fps)
  return <span className="corner-timecode">{formatTimecode(playhead, fps)}</span>
}

function PlayheadLine({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead)
  return (
    <div className="playhead-line" style={{ transform: `translateX(${HEADER_WIDTH + playhead * zoom}px)` }} />
  )
}

function PlayheadHead({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead)
  return (
    <div className="playhead-head" style={{ transform: `translateX(${HEADER_WIDTH + playhead * zoom}px)` }}>
      <svg width="13" height="16" viewBox="0 0 13 16" aria-hidden="true">
        <path d="M1 1h11v9l-5.5 5L1 10z" />
      </svg>
    </div>
  )
}

function TrackHeader({ track }: { track: Track }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.name)

  const finish = () => {
    setEditing(false)
    if (name.trim() && name !== track.name) updateTrack(track.id, { name: name.trim() })
    else setName(track.name)
  }

  return (
    <div
      className={cx('track-header', `track-header--${track.kind}`)}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Rename Track', run: () => setEditing(true) },
          { separator: true },
          { label: 'Add Video Track', run: () => addTrack('video') },
          { label: 'Add Audio Track', run: () => addTrack('audio') },
          { separator: true },
          { label: 'Delete Track', danger: true, run: () => void removeTrack(track.id) }
        ])
      }
    >
      <span className={`track-header__tag track-header__tag--${track.kind}`} />
      {editing ? (
        <input
          className="track-header__input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') finish()
            if (e.key === 'Escape') {
              setName(track.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="track-header__name"
          onDoubleClick={() => setEditing(true)}
          title="Double click to rename"
        >
          {track.name}
        </span>
      )}
      <div className="track-header__buttons">
        {track.kind === 'video' ? (
          <IconButton
            size="sm"
            tip={track.hidden ? 'Show track' : 'Hide track'}
            active={track.hidden}
            onClick={() => updateTrack(track.id, { hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        ) : (
          <IconButton
            size="sm"
            tip={track.muted ? 'Unmute track' : 'Mute track'}
            active={track.muted}
            onClick={() => updateTrack(track.id, { muted: !track.muted })}
          >
            {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </IconButton>
        )}
        <IconButton
          size="sm"
          tip={track.locked ? 'Unlock track' : 'Lock track'}
          active={track.locked}
          onClick={() => updateTrack(track.id, { locked: !track.locked })}
        >
          {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </IconButton>
      </div>
    </div>
  )
}
