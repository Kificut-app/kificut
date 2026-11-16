export const isMac = typeof window !== 'undefined' && window.kificut?.platform === 'darwin'

/** Modifier glyph or label used in tooltips and the shortcut sheet. */
export const modKey = isMac ? '⌘' : 'Ctrl+'
export const shiftKey = isMac ? '⇧' : 'Shift+'
export const altKey = isMac ? '⌥' : 'Alt+'
export const deleteKey = isMac ? '⌫' : 'Del'

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(type)
  }
  return false
}

/** True when Cmd (macOS) or Ctrl (elsewhere) is held. */
export function hasMod(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}
