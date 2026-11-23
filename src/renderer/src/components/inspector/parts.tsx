import { useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { IconButton, NumberField, Slider, cx } from '../ui/controls'

export function Section({
  title,
  children,
  onReset,
  defaultOpen = true
}: {
  title: string
  children: ReactNode
  onReset?: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Open when the section gains content, such as a shape an assistant just added.
  const [hadContent, setHadContent] = useState(defaultOpen)
  if (defaultOpen !== hadContent) {
    setHadContent(defaultOpen)
    if (defaultOpen) setOpen(true)
  }
  return (
    <div className={cx('section', open && 'is-open')}>
      <div className="section__header">
        <button type="button" className="section__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={13} className="section__chevron" />
          {title}
        </button>
        {onReset && (
          <IconButton size="sm" tip="Reset" onClick={onReset}>
            <RotateCcw size={12} />
          </IconButton>
        )}
      </div>
      {open && <div className="section__body">{children}</div>}
    </div>
  )
}

export function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('row', wide && 'row--wide')}>
      <span className="row__label">{label}</span>
      <div className="row__control">{children}</div>
    </div>
  )
}

export function SliderRow(props: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  display?: number
  precision?: number
  suffix?: string
  reset: number
}) {
  const { label, value, onChange, min, max, step = 0.01, display = 1, precision = 0, suffix, reset } = props
  return (
    <Row label={label}>
      <Slider value={value} min={min} max={max} step={step} reset={reset} onChange={onChange} />
      <NumberField
        className="num-field--compact"
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step * display >= 1 ? 1 : step * display}
        display={display}
        precision={precision}
        suffix={suffix}
      />
    </Row>
  )
}
