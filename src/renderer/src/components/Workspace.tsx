import { useEffect, useRef, useState } from 'react'
import { MediaPanel } from './media/MediaPanel'
import { Viewer } from './viewer/Viewer'
import { Inspector } from './inspector/Inspector'
import { Timeline } from './timeline/Timeline'

interface Layout {
  left: number
  right: number
  top: number
}

const STORAGE_KEY = 'kificut.layout'
const DEFAULTS: Layout = { left: 300, right: 320, top: 0.56 }

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Layout>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

function Splitter({
  axis,
  onDrag,
  onReset
}: {
  axis: 'x' | 'y'
  onDrag: (delta: number, done: boolean) => void
  onReset: () => void
}) {
  const start = useRef<number | null>(null)
  return (
    <div
      className={`splitter splitter--${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = axis === 'x' ? e.clientX : e.clientY
        document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y')
      }}
      onPointerMove={(e) => {
        if (start.current === null) return
        onDrag((axis === 'x' ? e.clientX : e.clientY) - start.current, false)
      }}
      onPointerUp={(e) => {
        if (start.current === null) return
        onDrag((axis === 'x' ? e.clientX : e.clientY) - start.current, true)
        start.current = null
        document.body.classList.remove('is-resizing-x', 'is-resizing-y')
      }}
    />
  )
}

export function Workspace() {
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const base = useRef(layout)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
    } catch {
      // Layout persistence is a convenience only.
    }
  }, [layout])

  const drag = (key: keyof Layout, sign: 1 | -1) => (delta: number, done: boolean) => {
    const height = rootRef.current?.clientHeight ?? 800
    const width = rootRef.current?.clientWidth ?? 1400
    setLayout(() => {
      const from = base.current
      const next = { ...from }
      if (key === 'top') next.top = Math.min(0.78, Math.max(0.28, from.top + delta / height))
      else next[key] = Math.min(width * 0.36, Math.max(220, from[key] + sign * delta))
      if (done) base.current = next
      return next
    })
  }

  const reset = (key: keyof Layout) => () => {
    setLayout((l) => {
      const next = { ...l, [key]: DEFAULTS[key] }
      base.current = next
      return next
    })
  }

  return (
    <div
      ref={rootRef}
      className="workspace"
      style={
        {
          '--left-width': `${layout.left}px`,
          '--right-width': `${layout.right}px`,
          '--top-height': `${layout.top * 100}%`
        } as React.CSSProperties
      }
    >
      <div className="workspace__top">
        <MediaPanel />
        <Splitter axis="x" onDrag={drag('left', 1)} onReset={reset('left')} />
        <Viewer />
        <Splitter axis="x" onDrag={drag('right', -1)} onReset={reset('right')} />
        <Inspector />
      </div>
      <Splitter axis="y" onDrag={drag('top', 1)} onReset={reset('top')} />
      <Timeline />
    </div>
  )
}
