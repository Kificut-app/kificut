import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { DisplayInfo } from '@shared/recording'

/*
 * Covers one screen so the user can drag out the area to record. The area can be moved by dragging
 * inside it. Enter or the button confirms, Esc cancels.
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const MIN_SIZE = 32

export function AreaPicker() {
  const [display, setDisplay] = useState<DisplayInfo | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ mode: 'draw' | 'move'; x: number; y: number; start: Rect | null } | null>(null)

  useEffect(() => {
    void window.kificut.recorder.areaDisplay().then(setDisplay)
  }, [])

  const confirm = () => {
    if (!rect) return
    const w = window.innerWidth
    const h = window.innerHeight
    void window.kificut.recorder.areaDone({
      x: rect.x / w,
      y: rect.y / h,
      width: rect.width / w,
      height: rect.height / h
    })
  }
  const cancel = () => void window.kificut.recorder.areaDone(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter') confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const inside = (x: number, y: number) =>
    !!rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.rec-area__toolbar')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = inside(e.clientX, e.clientY)
      ? { mode: 'move', x: e.clientX, y: e.clientY, start: rect }
      : { mode: 'draw', x: e.clientX, y: e.clientY, start: null }
    if (drag.current.mode === 'draw') setRect(null)
    setDragging(true)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const W = window.innerWidth
    const H = window.innerHeight
    if (d.mode === 'draw') {
      const x = Math.max(0, Math.min(d.x, e.clientX))
      const y = Math.max(0, Math.min(d.y, e.clientY))
      setRect({
        x,
        y,
        width: Math.min(W, Math.max(d.x, e.clientX)) - x,
        height: Math.min(H, Math.max(d.y, e.clientY)) - y
      })
    } else if (d.start) {
      const x = Math.max(0, Math.min(W - d.start.width, d.start.x + e.clientX - d.x))
      const y = Math.max(0, Math.min(H - d.start.height, d.start.y + e.clientY - d.y))
      setRect({ ...d.start, x, y })
    }
  }

  const onUp = () => {
    drag.current = null
    setDragging(false)
    if (rect && (rect.width < MIN_SIZE || rect.height < MIN_SIZE)) setRect(null)
  }

  const scale = display?.scaleFactor ?? 1
  const toolbarBelow = rect ? rect.y + rect.height + 56 < window.innerHeight : true

  return (
    <div className="rec-area" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {rect ? (
        <div
          className="rec-area__rect"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <span className="rec-area__size">
            {Math.round(rect.width * scale)} × {Math.round(rect.height * scale)}
          </span>
          {!dragging && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && (
            <div className={`rec-area__toolbar${toolbarBelow ? '' : ' is-inside'}`}>
              <button type="button" onClick={cancel}>
                Cancel
              </button>
              <button type="button" className="is-primary" onClick={confirm}>
                Record This Area
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="rec-area__hint">
          <strong>Drag to choose the area to record</strong>
          <span>Esc to cancel</span>
        </div>
      )}
    </div>
  )
}
