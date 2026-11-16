export type DragPayload =
  { type: 'media'; mediaId: string } | { type: 'text'; presetId: string } | { type: 'solid'; color: string }

export const DRAG_MIME = 'application/x-kificut'

/** The payload being dragged inside the app. DataTransfer contents are unreadable during dragover. */
export let activeDrag: DragPayload | null = null

export function startDrag(event: React.DragEvent, payload: DragPayload): void {
  activeDrag = payload
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copy'
}

export function endDrag(): void {
  activeDrag = null
}

export function hasFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function droppedPaths(event: React.DragEvent): string[] {
  return Array.from(event.dataTransfer.files)
    .map((file) => window.kificut.getPathForFile(file))
    .filter(Boolean)
}
