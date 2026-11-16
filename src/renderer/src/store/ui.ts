import { create } from 'zustand'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  title: string
  message?: string
  action?: ToastAction
}

export interface MenuEntry {
  label?: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  separator?: boolean
  run?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: MenuEntry[]
}

export interface ConfirmButton<T extends string> {
  id: T
  label: string
  primary?: boolean
  danger?: boolean
}

export interface ConfirmState {
  title: string
  message: string
  buttons: ConfirmButton<string>[]
  resolve: (id: string) => void
}

interface UiState {
  toasts: Toast[]
  menu: ContextMenuState | null
  confirm: ConfirmState | null
  busy: string | null
}

export const useUi = create<UiState>(() => ({ toasts: [], menu: null, confirm: null, busy: null }))

let nextToast = 1

export function toast(t: Omit<Toast, 'id'>): void {
  const id = nextToast++
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }))
  const timeout = t.kind === 'error' ? 9000 : t.action ? 8000 : 4500
  window.setTimeout(() => dismissToast(id), timeout)
}

export function dismissToast(id: number): void {
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function openMenu(
  event: { clientX: number; clientY: number; preventDefault(): void },
  items: MenuEntry[]
): void {
  event.preventDefault()
  useUi.setState({ menu: { x: event.clientX, y: event.clientY, items } })
}

export function closeMenu(): void {
  if (useUi.getState().menu) useUi.setState({ menu: null })
}

export function confirmDialog<T extends string>(options: {
  title: string
  message: string
  buttons: ConfirmButton<T>[]
}): Promise<T> {
  return new Promise<T>((resolve) => {
    useUi.setState({
      confirm: {
        ...options,
        resolve: (id) => {
          useUi.setState({ confirm: null })
          resolve(id as T)
        }
      }
    })
  })
}

export function setBusy(message: string | null): void {
  useUi.setState({ busy: message })
}
