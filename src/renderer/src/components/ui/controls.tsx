import {
  forwardRef,
  Fragment,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react'
import { clamp } from '@shared/time'

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}

export { cx }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  tip?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, tip, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      data-tip={tip}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, !children && 'btn--icon-only', className)}
      {...rest}
    >
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
})

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tip?: string
  active?: boolean
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tip, active, size = 'md', className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={tip}
      data-tip={tip}
      aria-pressed={active}
      className={cx('icon-btn', `icon-btn--${size}`, active && 'is-active', className)}
      {...rest}
    >
      {children}
    </button>
  )
})

interface NumberFieldProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  precision?: number
  /** Multiplier between the stored value and what is shown, e.g. 100 for percentages. */
  display?: number
  suffix?: string
  label?: string
  disabled?: boolean
  className?: string
}

/**
 * Numeric input that can be dragged horizontally to scrub, clicked to type, or nudged with the
 * arrow keys. Hold Shift for coarse steps and Alt for fine steps.
 */
export function NumberField({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  display = 1,
  suffix,
  label,
  disabled,
  className
}: NumberFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null)

  const shown = value * display
  const text = Number.isFinite(shown) ? shown.toFixed(precision) : '-inf'

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const emit = (next: number) => {
    const clamped = clamp(next, min, max)
    if (Number.isFinite(clamped)) onChange(clamped)
  }

  const commitDraft = () => {
    const parsed = parseFloat(draft.replace(',', '.'))
    if (Number.isFinite(parsed)) emit(parsed / display)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className={cx('num-field', 'is-editing', className)}>
        {label && <span className="num-field__label">{label}</span>}
        <input
          ref={inputRef}
          className="num-field__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDraft()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
        {suffix && <span className="num-field__suffix">{suffix}</span>}
      </div>
    )
  }

  return (
    <div
      className={cx('num-field', disabled && 'is-disabled', className)}
      tabIndex={disabled ? -1 : 0}
      role="spinbutton"
      aria-valuenow={shown}
      aria-label={label}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, start: value, moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x
        if (!d.moved && Math.abs(dx) < 3) return
        d.moved = true
        const factor = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
        emit(d.start + (Math.round(dx / 2) * step * factor) / display)
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d && !d.moved) {
          setDraft(text)
          setEditing(true)
        }
      }}
      onKeyDown={(e) => {
        if (disabled) return
        const factor = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') emit(value + (step * factor) / display)
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') emit(value - (step * factor) / display)
        else if (e.key === 'Enter') {
          setDraft(text)
          setEditing(true)
        } else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {label && <span className="num-field__label">{label}</span>}
      <span className="num-field__value">{text}</span>
      {suffix && <span className="num-field__suffix">{suffix}</span>}
    </div>
  )
}

interface SliderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  /** Value the slider snaps back to on double click. */
  reset?: number
  disabled?: boolean
}

export function Slider({ value, onChange, min, max, step = 0.01, reset, disabled }: SliderProps) {
  const fill = ((clamp(value, min, max) - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ '--fill': `${fill}%` } as React.CSSProperties}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onDoubleClick={() => reset !== undefined && onChange(reset)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}

interface ColorFieldProps {
  value: string
  onChange: (value: string) => void
}

export function ColorField({ value, onChange }: ColorFieldProps) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const apply = (raw: string) => {
    const hex = raw.startsWith('#') ? raw : `#${raw}`
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) onChange(hex.toLowerCase())
    else setText(value)
  }
  return (
    <div className="color-field">
      <label className="color-field__swatch" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <input
        className="color-field__hex"
        value={text.replace('#', '').toUpperCase()}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply((e.target as HTMLInputElement).value)
          e.stopPropagation()
        }}
      />
    </div>
  )
}

interface SelectOption<T> {
  value: T
  label: string
  /** Options with the same group are listed under that heading, in the order groups first appear. */
  group?: string
}

interface SelectProps<T extends string | number> {
  value: T
  options: Array<SelectOption<T>>
  onChange: (value: T) => void
  className?: string
  disabled?: boolean
}

function groupOptions<T>(options: Array<SelectOption<T>>): Array<[string, Array<SelectOption<T>>]> {
  const groups = new Map<string, Array<SelectOption<T>>>()
  for (const option of options) {
    const key = option.group ?? ''
    groups.set(key, [...(groups.get(key) ?? []), option])
  }
  return [...groups]
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
  disabled
}: SelectProps<T>) {
  return (
    <div className={cx('select', className)}>
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const match = options.find((o) => String(o.value) === e.target.value)
          if (match) onChange(match.value)
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {groupOptions(options).map(([group, items]) => {
          const rendered = items.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))
          return group ? (
            <optgroup key={group} label={group}>
              {rendered}
            </optgroup>
          ) : (
            <Fragment key="">{rendered}</Fragment>
          )
        })}
      </select>
    </div>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: Array<{ value: T; label?: string; icon?: ReactNode; tip?: string }>
  onChange: (value: T) => void
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.tip ?? o.label}
          data-tip={o.tip}
          className={cx('segmented__item', o.value === value && 'is-active')}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}
