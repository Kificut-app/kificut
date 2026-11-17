import { create } from 'zustand'
import { produce, type Draft } from 'immer'
import type { AppSettings, Project, ProxyStatus } from '@shared/types'
import { withLinked } from '../lib/timeline'

export type Tool = 'select' | 'razor'
export type DialogId = 'export' | 'preferences' | 'shortcuts' | 'about' | 'ai' | null

const MAX_HISTORY = 200
const COALESCE_MS = 900

export interface EditorState {
  project: Project | null
  /** Snapshot as last saved; the project is dirty whenever it differs by reference. */
  savedProject: Project | null
  filePath: string | null

  past: Project[]
  future: Project[]
  gestureBase: Project | null
  lastCoalesce: { key: string; time: number } | null

  selection: string[]
  selectedMediaId: string | null
  playhead: number
  playing: boolean
  loop: boolean
  zoom: number
  tool: Tool
  snapping: boolean
  previewScale: number
  showGuides: boolean

  proxies: Record<string, ProxyStatus>
  offline: Record<string, boolean>
  settings: AppSettings | null
  dialog: DialogId
}

export const useEditor = create<EditorState>(() => ({
  project: null,
  savedProject: null,
  filePath: null,
  past: [],
  future: [],
  gestureBase: null,
  lastCoalesce: null,
  selection: [],
  selectedMediaId: null,
  playhead: 0,
  playing: false,
  loop: false,
  zoom: 60,
  tool: 'select',
  snapping: true,
  previewScale: 1,
  showGuides: false,
  proxies: {},
  offline: {},
  settings: null,
  dialog: null
}))

const get = useEditor.getState
const set = useEditor.setState

export function isDirty(state: EditorState = get()): boolean {
  return state.project !== null && state.project !== state.savedProject
}

function stamp(project: Project): Project {
  return { ...project, updatedAt: new Date().toISOString() }
}

/**
 * Applies a change and records an undo step. Changes sharing a coalesce key within a short window
 * become one step, so dragging a slider does not flood the history.
 */
export function commit(recipe: (draft: Draft<Project>) => void, coalesceKey?: string): void {
  const state = get()
  if (!state.project) return
  if (state.gestureBase) {
    // Folded into the running gesture, which records a single undo step when it ends.
    set({ project: produce(state.project, recipe) })
    return
  }
  const next = produce(state.project, recipe)
  if (next === state.project) return

  const now = performance.now()
  const coalesce =
    !!coalesceKey &&
    state.lastCoalesce?.key === coalesceKey &&
    now - state.lastCoalesce.time < COALESCE_MS &&
    state.past.length > 0

  set({
    project: stamp(next),
    past: coalesce ? state.past : [...state.past.slice(-(MAX_HISTORY - 1)), state.project],
    future: [],
    lastCoalesce: coalesceKey ? { key: coalesceKey, time: now } : null,
    selection: pruneSelection(next, state.selection)
  })
}

/** Starts an interactive edit. Each update is applied to the state at the start of the gesture. */
export function beginGesture(): void {
  const state = get()
  if (!state.project || state.gestureBase) return
  set({ gestureBase: state.project })
}

export function updateGesture(recipe: (draft: Draft<Project>) => void): void {
  const base = get().gestureBase
  if (!base) return
  set({ project: produce(base, recipe) })
}

export function endGesture(cancel = false): void {
  const state = get()
  const base = state.gestureBase
  if (!base) return
  if (cancel || state.project === base) {
    set({ project: base, gestureBase: null })
    return
  }
  set({
    project: stamp(state.project!),
    gestureBase: null,
    past: [...state.past.slice(-(MAX_HISTORY - 1)), base],
    future: [],
    lastCoalesce: null,
    selection: pruneSelection(state.project!, state.selection)
  })
}

export function undo(): void {
  const state = get()
  if (!state.project || state.past.length === 0 || state.gestureBase) return
  const previous = state.past[state.past.length - 1]
  set({
    project: previous,
    past: state.past.slice(0, -1),
    future: [state.project, ...state.future],
    lastCoalesce: null,
    selection: pruneSelection(previous, state.selection)
  })
}

export function redo(): void {
  const state = get()
  if (!state.project || state.future.length === 0 || state.gestureBase) return
  const next = state.future[0]
  set({
    project: next,
    past: [...state.past, state.project],
    future: state.future.slice(1),
    lastCoalesce: null,
    selection: pruneSelection(next, state.selection)
  })
}

function pruneSelection(project: Project, selection: string[]): string[] {
  if (selection.length === 0) return selection
  const ids = new Set(project.clips.map((c) => c.id))
  const next = selection.filter((id) => ids.has(id))
  return next.length === selection.length ? selection : next
}

/** Loads a project. `unsaved` marks it as having changes, as when restoring recovered work. */
export function loadProject(project: Project, filePath: string | null, unsaved = false): void {
  set({
    project,
    savedProject: filePath && !unsaved ? project : null,
    filePath,
    past: [],
    future: [],
    gestureBase: null,
    lastCoalesce: null,
    selection: [],
    selectedMediaId: null,
    playhead: 0,
    playing: false,
    offline: {}
  })
}

export function markSaved(filePath: string): void {
  const project = get().project
  set({ savedProject: project, filePath })
}

export function closeProject(): void {
  set({
    project: null,
    savedProject: null,
    filePath: null,
    past: [],
    future: [],
    gestureBase: null,
    selection: [],
    selectedMediaId: null,
    playhead: 0,
    playing: false,
    dialog: null
  })
}

export type SelectMode = 'replace' | 'toggle' | 'add'

export function select(ids: string[], mode: SelectMode = 'replace'): void {
  const project = get().project
  if (!project) return
  const expanded = withLinked(project, ids)
  const current = new Set(get().selection)
  let next: string[]
  if (mode === 'replace') {
    next = expanded
  } else if (mode === 'add') {
    expanded.forEach((id) => current.add(id))
    next = [...current]
  } else {
    const allSelected = expanded.every((id) => current.has(id))
    expanded.forEach((id) => (allSelected ? current.delete(id) : current.add(id)))
    next = [...current]
  }
  set({ selection: next, selectedMediaId: null })
}

export function clearSelection(): void {
  if (get().selection.length) set({ selection: [] })
}

export function seek(time: number): void {
  set({ playhead: Math.max(0, time) })
}

export function setDialog(dialog: DialogId): void {
  set({ dialog })
}
