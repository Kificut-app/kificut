import { useEffect, useState } from 'react'

interface TipState {
  text: string
  x: number
  y: number
  below: boolean
}

const DELAY = 550

/**
 * One tooltip for the whole app. Any element with a data-tip attribute gets one, so components do
 * not need to wrap themselves.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null)

  useEffect(() => {
    let timer = 0
    let current: HTMLElement | null = null

    const hide = () => {
      window.clearTimeout(timer)
      current = null
      setTip(null)
    }

    const over = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
      if (target === current) return
      hide()
      if (!target || !target.dataset.tip) return
      current = target
      timer = window.setTimeout(() => {
        if (!current || !current.isConnected) return
        const rect = current.getBoundingClientRect()
        const below = rect.top < 60
        setTip({
          text: current.dataset.tip ?? '',
          x: rect.left + rect.width / 2,
          y: below ? rect.bottom + 8 : rect.top - 8,
          below
        })
      }, DELAY)
    }

    window.addEventListener('mouseover', over)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('mouseover', over)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('wheel', hide, true)
      window.removeEventListener('blur', hide)
      window.clearTimeout(timer)
    }
  }, [])

  if (!tip) return null
  const [label, shortcut] = tip.text.split('|')
  return (
    <div
      className={`tooltip ${tip.below ? 'tooltip--below' : ''}`}
      style={{ left: Math.max(8, Math.min(window.innerWidth - 8, tip.x)), top: tip.y }}
      role="tooltip"
    >
      {label}
      {shortcut && <span className="tooltip__key">{shortcut}</span>}
    </div>
  )
}
