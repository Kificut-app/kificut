import { useEffect, useRef } from 'react'
import { player } from '../../engine/player'

const FLOOR_DB = -60
const MARKS = [0, -6, -12, -24, -48]

function toUnit(level: number): number {
  if (level <= 0) return 0
  const db = 20 * Math.log10(level)
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB))
}

/** Stereo peak meter for the program output, with a short peak hold. */
export function AudioMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const shown = [0, 0]
    const hold = [0, 0]
    const holdTime = [0, 0]
    let raf = 0

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const levels = player.levels()
      const top = 8
      const bottom = h - 8
      const span = bottom - top
      const barW = 5
      const gap = 3
      const x0 = 4

      for (let ch = 0; ch < 2; ch++) {
        const target = toUnit(levels[ch])
        shown[ch] = target > shown[ch] ? target : Math.max(target, shown[ch] - 0.018)
        if (target >= hold[ch]) {
          hold[ch] = target
          holdTime[ch] = now
        } else if (now - holdTime[ch] > 900) {
          hold[ch] = Math.max(0, hold[ch] - 0.01)
        }

        const x = x0 + ch * (barW + gap)
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(x, top, barW, span)

        const fillH = shown[ch] * span
        const gradient = ctx.createLinearGradient(0, bottom, 0, top)
        gradient.addColorStop(0, '#3ecf8e')
        gradient.addColorStop(0.7, '#3ecf8e')
        gradient.addColorStop(0.8, '#f5c451')
        gradient.addColorStop(0.95, '#ff5f57')
        ctx.fillStyle = gradient
        ctx.fillRect(x, bottom - fillH, barW, fillH)

        if (hold[ch] > 0.01) {
          ctx.fillStyle = hold[ch] > 0.95 ? '#ff5f57' : 'rgba(255,255,255,0.7)'
          ctx.fillRect(x, bottom - hold[ch] * span, barW, 1.5)
        }
      }

      ctx.fillStyle = 'rgba(160,160,175,0.7)'
      ctx.font = '9px "Inter Variable", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      for (const mark of MARKS) {
        const y = bottom - ((mark - FLOOR_DB) / -FLOOR_DB) * span
        ctx.fillText(String(mark), x0 + 2 * (barW + gap) + 2, y)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="audio-meter" data-tip="Output level (dBFS)">
      <canvas ref={canvasRef} />
    </div>
  )
}
