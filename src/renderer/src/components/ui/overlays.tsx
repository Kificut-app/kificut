import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { closeMenu, dismissToast, useUi } from '../../store/ui'
import { Button, cx } from './controls'

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
  className
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={cx('modal', className)}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

export function ConfirmLayer() {
  const confirm = useUi((s) => s.confirm)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primaryRef.current?.focus()
  }, [confirm])

  if (!confirm) return null
  const cancel = confirm.buttons.find((b) => b.id === 'cancel') ?? confirm.buttons[0]
  return (
    <Modal
      title={confirm.title}
      onClose={() => confirm.resolve(cancel.id)}
      width={440}
      className="modal--confirm"
    >
      <p className="confirm__message">{confirm.message}</p>
      <div className="confirm__actions">
        {confirm.buttons.map((b) => (
          <Button
            key={b.id}
            ref={b.primary ? primaryRef : undefined}
            variant={b.danger ? 'danger' : b.primary ? 'primary' : 'default'}
            onClick={() => confirm.resolve(b.id)}
          >
            {b.label}
          </Button>
        ))}
      </div>
    </Modal>
  )
}

export function ContextMenuLayer() {
  const menu = useUi((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPosition(null)
      return
    }
    const rect = ref.current.getBoundingClientRect()
    setPosition({
      left: Math.min(menu.x, window.innerWidth - rect.width - 6),
      top: Math.min(menu.y, window.innerHeight - rect.height - 6)
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMenu()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
    }
  }, [menu])

  if (!menu) return null
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? 'visible' : 'hidden'
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu__separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cx('context-menu__item', item.danger && 'is-danger')}
            onClick={() => {
              closeMenu()
              item.run?.()
            }}
          >
            <span className="context-menu__check">{item.checked && <Check size={13} />}</span>
            <span className="context-menu__label">{item.label}</span>
            {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

export function ToastLayer() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast--${t.kind}`)}>
          <span className="toast__icon">
            {t.kind === 'error' ? (
              <CircleAlert size={16} />
            ) : t.kind === 'success' ? (
              <CircleCheck size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.message && <div className="toast__message">{t.message}</div>}
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.run()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function BusyLayer() {
  const busy = useUi((s) => s.busy)
  if (!busy) return null
  return (
    <div className="busy">
      <span className="spinner" />
      {busy}
    </div>
  )
}
