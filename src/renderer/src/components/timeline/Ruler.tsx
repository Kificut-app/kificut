import { useEffect, useRef } from 'react'
import { formatTimecode } from '@shared/time'
import type { Marker } from '@shared/types'
import { seek, useEditor } from '../../store/editor'
import { MARKER_COLORS, removeMarker, updateMarker } from '../../store/actions'
import { openMenu } from '../../store/ui'
import { player } from '../../engine/player'
import { HEADER_WIDTH, RULER_HEIGHT } from '../../lib/timeline-view'
import { snapValue, snapPoints } from '../../lib/timeline'

const STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
const STEPS_FRAMES = [1, 2, 5, 10]

function chooseStep(zoom: number, fps: number): { major: number; minor: number; frames: boolean } {
  const minPx = 96
  for (const f of STEPS_FRAMES) {
    const step = f / fps
    if (step * zoom >= minPx && f < fps / 2)
      return { major: step, minor: step / Math.min(f, 5), frames: true }
  }
  for (const s of STEPS_SECONDS) {
    if (s * zoom >= minPx) {
      const minor = s * zoom >= 300 ? s / 10 : s * zoom >= 120 ? s / 5 : s / 2
      return { major: s, minor, frames: false }
    }
  }
  return { major: 14400, minor: 3600, frames: false }
}

function label(time: number, fps: number, frames: boolean, long: boolean): string {
  if (frames) return formatTimecode(time, fps)
  const total = Math.round(time)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return long || h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

interface RulerProps {
  left: number
  width: number
  zoom: number
}

export function Ruler({ left, width, zoom }: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fps = useEditor((s) => s.project!.settings.fps)
  const markers = useEditor((s) => s.project!.markers)
  const inPoint = useEditor((s) => s.project!.inPoint)
  const outPoint = useEditor((s) => s.project!.outPoint)
  const scrub = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.round(RULER_HEIGHT * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, RULER_HEIGHT)

    const style = getComputedStyle(canvas)
    const tick = style.getPropertyValue('--ruler-tick').trim() || '#3a3a44'
    const text = style.getPropertyValue('--ruler-text').trim() || '#8a8a96'

    const { major, minor, frames } = chooseStep(zoom, fps)
    const startTime = left / zoom
    const endTime = (left + width) / zoom
    const long = endTime >= 3600

    ctx.fillStyle = tick
    const firstMinor = Math.floor(startTime / minor) * minor
    for (let t = firstMinor; t <= endTime; t += minor) {
      const x = Math.round(t * zoom - left) + 0.5
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
      const h = isMajor ? 10 : 5
      ctx.fillRect(x - 0.5, RULER_HEIGHT - h, 1, h)
    }

    ctx.fillStyle = text
    ctx.font = '500 10px "Inter Variable", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    const firstMajor = Math.floor(startTime / major) * major
    for (let t = firstMajor; t <= endTime; t += major) {
      const x = Math.round(t * zoom - left)
      ctx.fillText(label(t, fps, frames, long), x + 4, 6)
    }
  }, [left, width, zoom, fps])

  const timeAt = (clientX: number, target: HTMLElement): number => {
    const rect = target.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + left) / zoom)
  }

  const scrubTo = (clientX: number, target: HTMLElement, shift: boolean) => {
    let t = timeAt(clientX, target)
    const state = useEditor.getState()
    if (shift && state.project) t = snapValue(t, snapPoints(state.project, new Set(), -1), 10 / zoom).value
    seek(Math.round(t * fps) / fps)
  }

  return (
    <div className="ruler" style={{ left: HEADER_WIDTH }}>
      <div
        className="ruler__surface"
        style={{ left, width }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub.current = true
          player.pause()
          scrubTo(e.clientX, e.currentTarget, e.shiftKey)
        }}
        onPointerMove={(e) => scrub.current && scrubTo(e.clientX, e.currentTarget, e.shiftKey)}
        onPointerUp={() => (scrub.current = false)}
      >
        <canvas ref={canvasRef} className="ruler__canvas" style={{ width, height: RULER_HEIGHT }} />
      </div>
      {(inPoint !== null || outPoint !== null) && (
        <div
          className="ruler__range"
          style={{
            left: (inPoint ?? 0) * zoom,
            width: Math.max(
              1,
              ((outPoint ?? Math.max(inPoint ?? 0, left / zoom + width / zoom)) - (inPoint ?? 0)) * zoom
            )
          }}
        />
      )}
      {markers.map((m) => (
        <MarkerFlag key={m.id} marker={m} zoom={zoom} />
      ))}
    </div>
  )
}

function MarkerFlag({ marker, zoom }: { marker: Marker; zoom: number }) {
  return (
    <button
      type="button"
      className="marker"
      style={{ left: marker.time * zoom, color: marker.color }}
      data-tip={marker.label}
      aria-label={marker.label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => seek(marker.time)}
      onContextMenu={(e) =>
        openMenu(e, [
          ...MARKER_COLORS.map((color, i) => ({
            label: ['Yellow', 'Blue', 'Red', 'Green', 'Purple'][i],
            checked: marker.color === color,
            run: () => updateMarker(marker.id, { color })
          })),
          { separator: true },
          { label: 'Delete Marker', danger: true, run: () => removeMarker(marker.id) }
        ])
      }
    />
  )
}
