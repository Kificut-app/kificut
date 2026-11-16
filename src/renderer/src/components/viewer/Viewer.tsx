import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Grid3x3, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react'
import { formatTimecode, parseTimecode } from '@shared/time'
import { pointInLayer, type Point } from '@shared/geometry'
import type { Clip } from '@shared/types'
import {
  beginGesture,
  clearSelection,
  endGesture,
  seek,
  select,
  updateGesture,
  useEditor
} from '../../store/editor'
import { goToEnd, goToStart, stepFrames } from '../../store/actions'
import { player } from '../../engine/player'
import { clipLayer, visibleClipsAt } from '../../engine/layers'
import { projectDuration } from '../../lib/timeline'
import { IconButton, Select, cx } from '../ui/controls'

export function Viewer() {
  const width = useEditor((s) => s.project!.settings.width)
  const height = useEditor((s) => s.project!.settings.height)
  const fps = useEditor((s) => s.project!.settings.fps)
  const showGuides = useEditor((s) => s.showGuides)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    player.attach(canvasRef.current!)
    setError(player.error)
    return () => player.detach()
  }, [])

  useLayoutEffect(() => {
    const stage = stageRef.current!
    const fit = () => {
      const pad = 20
      const aw = Math.max(10, stage.clientWidth - pad * 2)
      const ah = Math.max(10, stage.clientHeight - pad * 2)
      const scale = Math.min(aw / width, ah / height)
      setBox({ w: Math.floor(width * scale), h: Math.floor(height * scale) })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [width, height])

  return (
    <section className="panel viewer">
      <div className="panel__header">
        <span className="panel__title">Program</span>
        <span className="viewer__format">
          {width} × {height} · {Math.round(fps * 1000) / 1000} fps
        </span>
      </div>
      <div className="viewer__stage" ref={stageRef}>
        <div className="viewer__frame" style={{ width: box.w, height: box.h }}>
          <canvas ref={canvasRef} className="viewer__canvas" />
          {showGuides && (
            <div className="viewer__guides">
              <span className="viewer__guide viewer__guide--action" />
              <span className="viewer__guide viewer__guide--title" />
            </div>
          )}
          {box.w > 0 && <ViewerOverlay scale={box.w / width} />}
        </div>
        {error && (
          <div className="viewer__error">
            <strong>Preview unavailable</strong>
            <span>{error}</span>
          </div>
        )}
      </div>
      <Transport />
    </section>
  )
}

type DragMode =
  | { kind: 'move'; start: Point; base: { x: number; y: number } }
  | { kind: 'scale'; center: Point; startDistance: number; base: number }

function ViewerOverlay({ scale }: { scale: number }) {
  const project = useEditor((s) => s.project!)
  const playhead = useEditor((s) => s.playhead)
  const selection = useEditor((s) => s.selection)
  const playing = useEditor((s) => s.playing)
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ clipId: string; mode: DragMode } | null>(null)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })

  const visible = visibleClipsAt(project, playhead)
  const selectedVisual = visible.filter((c) => selection.includes(c.id))
  const clip: Clip | null = selectedVisual.length === 1 ? selectedVisual[0] : null
  const locked = clip ? project.tracks.find((t) => t.id === clip.trackId)?.locked : false
  const layer = clip ? clipLayer(project, clip) : null

  const toFrame = (clientX: number, clientY: number): Point => {
    const rect = rootRef.current!.getBoundingClientRect()
    return [(clientX - rect.left) / scale, (clientY - rect.top) / scale]
  }

  const startMove = (target: Clip, e: React.PointerEvent) => {
    rootRef.current!.setPointerCapture(e.pointerId)
    beginGesture()
    drag.current = {
      clipId: target.id,
      mode: {
        kind: 'move',
        start: toFrame(e.clientX, e.clientY),
        base: { x: target.transform.x, y: target.transform.y }
      }
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || playing) return
    const point = toFrame(e.clientX, e.clientY)
    const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
    const hit = [...visible]
      .reverse()
      .find((c) => !lockedTracks.has(c.trackId) && pointInLayer(point, clipLayer(project, c)))
    if (!hit) {
      clearSelection()
      return
    }
    if (!selection.includes(hit.id)) select([hit.id])
    startMove(hit, e)
  }

  const onHandleDown = (e: React.PointerEvent) => {
    if (!clip || !layer || e.button !== 0) return
    e.stopPropagation()
    rootRef.current!.setPointerCapture(e.pointerId)
    const point = toFrame(e.clientX, e.clientY)
    const distance = Math.hypot(point[0] - layer.cx, point[1] - layer.cy)
    beginGesture()
    drag.current = {
      clipId: clip.id,
      mode: {
        kind: 'scale',
        center: [layer.cx, layer.cy],
        startDistance: Math.max(1, distance),
        base: clip.transform.scale
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const point = toFrame(e.clientX, e.clientY)
    const snap = 8 / scale
    if (d.mode.kind === 'move') {
      const { start, base } = d.mode
      let x = base.x + point[0] - start[0]
      let y = base.y + point[1] - start[1]
      if (e.shiftKey) {
        if (Math.abs(point[0] - start[0]) > Math.abs(point[1] - start[1])) y = base.y
        else x = base.x
      }
      const v = Math.abs(x) < snap
      const h = Math.abs(y) < snap
      if (v) x = 0
      if (h) y = 0
      setGuides({ v, h })
      updateGesture((draft) => {
        const c = draft.clips.find((item) => item.id === d.clipId)
        if (c) {
          c.transform.x = Math.round(x)
          c.transform.y = Math.round(y)
        }
      })
    } else {
      const { center, startDistance, base } = d.mode
      const distance = Math.hypot(point[0] - center[0], point[1] - center[1])
      let next = Math.max(0.01, Math.min(20, (base * distance) / startDistance))
      if (Math.abs(next - 1) < 0.02) next = 1
      updateGesture((draft) => {
        const c = draft.clips.find((item) => item.id === d.clipId)
        if (c) c.transform.scale = Math.round(next * 1000) / 1000
      })
    }
  }

  const onPointerUp = () => {
    if (!drag.current) return
    drag.current = null
    setGuides({ v: false, h: false })
    endGesture()
  }

  return (
    <div
      ref={rootRef}
      className="viewer-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {clip && layer && !playing && (
        <div
          className={cx('transform-box', locked && 'is-locked')}
          style={{
            left: (layer.cx - layer.width / 2) * scale,
            top: (layer.cy - layer.height / 2) * scale,
            width: layer.width * scale,
            height: layer.height * scale,
            transform: `rotate(${layer.rotation}deg)`
          }}
        >
          {!locked &&
            (['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
              <span
                key={corner}
                className={`transform-box__handle transform-box__handle--${corner}`}
                onPointerDown={onHandleDown}
              />
            ))}
        </div>
      )}
      {guides.v && <span className="snap-guide snap-guide--v" />}
      {guides.h && <span className="snap-guide snap-guide--h" />}
    </div>
  )
}

function TimecodeInput() {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project!.settings.fps)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  const apply = () => {
    const parsed = parseTimecode(value, fps)
    if (parsed !== null) seek(parsed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        className="timecode timecode--input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') apply()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="timecode"
      data-tip="Click to type a timecode"
      onClick={() => {
        player.pause()
        setValue(formatTimecode(playhead, fps))
        setEditing(true)
      }}
    >
      {formatTimecode(playhead, fps)}
    </button>
  )
}

function Transport() {
  const playing = useEditor((s) => s.playing)
  const loop = useEditor((s) => s.loop)
  const showGuides = useEditor((s) => s.showGuides)
  const previewScale = useEditor((s) => s.previewScale)
  const fps = useEditor((s) => s.project!.settings.fps)
  const duration = useEditor((s) => projectDuration(s.project!))

  return (
    <div className="transport">
      <div className="transport__side">
        <TimecodeInput />
      </div>
      <div className="transport__controls">
        <IconButton tip="Go to start|Home" onClick={goToStart}>
          <SkipBack size={16} />
        </IconButton>
        <IconButton tip="Previous frame|←" onClick={() => stepFrames(-1)}>
          <StepBack size={16} />
        </IconButton>
        <button
          type="button"
          className="transport__play"
          aria-label={playing ? 'Pause' : 'Play'}
          data-tip={`${playing ? 'Pause' : 'Play'}|Space`}
          onClick={() => player.toggle()}
        >
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <IconButton tip="Next frame|→" onClick={() => stepFrames(1)}>
          <StepForward size={16} />
        </IconButton>
        <IconButton tip="Go to end|End" onClick={goToEnd}>
          <SkipForward size={16} />
        </IconButton>
      </div>
      <div className="transport__side transport__side--end">
        <IconButton tip="Loop playback" active={loop} onClick={() => useEditor.setState({ loop: !loop })}>
          <Repeat size={15} />
        </IconButton>
        <IconButton
          tip="Safe area guides"
          active={showGuides}
          onClick={() => useEditor.setState({ showGuides: !showGuides })}
        >
          <Grid3x3 size={15} />
        </IconButton>
        <Select
          className="select--compact"
          value={previewScale}
          options={[
            { value: 1, label: 'Full' },
            { value: 0.5, label: 'Half' },
            { value: 0.25, label: 'Quarter' }
          ]}
          onChange={(value) => {
            useEditor.setState({ previewScale: value })
            void window.kificut.settings.set({ previewScale: value })
          }}
        />
        <span className="transport__duration" data-tip="Timeline duration">
          {formatTimecode(duration, fps)}
        </span>
      </div>
    </div>
  )
}
