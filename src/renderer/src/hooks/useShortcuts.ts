import { useEffect } from 'react'
import { checkForUpdates } from '../store/updates'
import { clearSelection, redo, setDialog, undo, useEditor } from '../store/editor'
import {
  addMarker,
  addTextClip,
  clearInOut,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  goToEnd,
  goToStart,
  importDialog,
  jumpToEdit,
  nudgeSelection,
  openProjectDialog,
  pasteClipboard,
  requestCloseProject,
  saveProject,
  selectAll,
  setInPoint,
  setOutPoint,
  splitAtPlayhead,
  stepFrames,
  zoomBy,
  zoomToFit
} from '../store/actions'
import { useUi } from '../store/ui'
import { player } from '../engine/player'
import { hasMod, isEditableTarget, isMac } from '../lib/platform'
import type { MenuCommand } from '@shared/ipc'

function blocked(): boolean {
  const ui = useUi.getState()
  return !useEditor.getState().project || !!useEditor.getState().dialog || !!ui.confirm || !!ui.menu
}

/** Single key and editing shortcuts. They never fire while the user is typing in a field. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (blocked() || isEditableTarget(e.target) || e.isComposing) return
      const mod = hasMod(e)
      const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase()
      const fps = useEditor.getState().project!.settings.fps
      let handled = true

      if (mod) {
        if (letter === 'z') {
          if (e.shiftKey) redo()
          else undo()
        } else if (letter === 'y' && !isMac) redo()
        else if (letter === 'd') duplicateSelection()
        else if (letter === 'a') selectAll()
        else if (letter === 'k') splitAtPlayhead()
        else handled = false
      } else {
        switch (e.key) {
          case ' ':
            player.toggle()
            break
          case 'ArrowLeft':
            if (e.altKey) nudgeSelection(e.shiftKey ? -10 : -1)
            else stepFrames(e.shiftKey ? -Math.round(fps) : -1)
            break
          case 'ArrowRight':
            if (e.altKey) nudgeSelection(e.shiftKey ? 10 : 1)
            else stepFrames(e.shiftKey ? Math.round(fps) : 1)
            break
          case 'ArrowUp':
            jumpToEdit(-1)
            break
          case 'ArrowDown':
            jumpToEdit(1)
            break
          case 'Home':
            goToStart()
            break
          case 'End':
            goToEnd()
            break
          case 'Delete':
          case 'Backspace':
            deleteSelection(e.shiftKey)
            break
          case 'Escape':
            clearSelection()
            useEditor.setState({ tool: 'select' })
            break
          case '=':
          case '+':
            zoomBy(1.5)
            break
          case '-':
          case '_':
            zoomBy(1 / 1.5)
            break
          default:
            switch (letter) {
              case 'j':
                player.shuttle(-1)
                break
              case 'k':
                player.pause()
                break
              case 'l':
                player.shuttle(1)
                break
              case 'v':
                useEditor.setState({ tool: 'select' })
                break
              case 'c':
              case 'b':
                useEditor.setState({ tool: 'razor' })
                break
              case 's':
                splitAtPlayhead()
                break
              case 'n':
                useEditor.setState((s) => ({ snapping: !s.snapping }))
                break
              case 'm':
                addMarker()
                break
              case 't':
                addTextClip()
                break
              case 'i':
                setInPoint()
                break
              case 'o':
                setOutPoint()
                break
              case 'x':
                if (e.altKey) clearInOut()
                else handled = false
                break
              case 'z':
                if (e.shiftKey) zoomToFit()
                else handled = false
                break
              default:
                handled = false
            }
        }
      }

      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const clipboard = (kind: 'copy' | 'cut' | 'paste') => (e: ClipboardEvent) => {
      if (blocked() || isEditableTarget(document.activeElement)) return
      e.preventDefault()
      if (kind === 'copy') copySelection()
      else if (kind === 'cut') cutSelection()
      else pasteClipboard()
    }
    const onCopy = clipboard('copy')
    const onCut = clipboard('cut')
    const onPaste = clipboard('paste')

    window.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste)
    }
  }, [])
}

/** Commands sent from the native application menu. */
export function useMenuCommands(): void {
  useEffect(() => {
    return window.kificut.app.onMenuCommand((command: MenuCommand) => {
      const hasProject = !!useEditor.getState().project
      const editing = isEditableTarget(document.activeElement)
      switch (command) {
        case 'new-project':
        case 'close-project':
          void requestCloseProject()
          return
        case 'open-project':
          void openProjectDialog()
          return
        case 'preferences':
          setDialog('preferences')
          return
        case 'shortcuts':
          setDialog('shortcuts')
          return
        case 'about':
          setDialog('about')
          return
        case 'check-updates':
          void checkForUpdates()
          return
      }
      if (!hasProject) return
      switch (command) {
        case 'save':
          void saveProject()
          break
        case 'save-as':
          void saveProject(true)
          break
        case 'import-media':
          void importDialog()
          break
        case 'export':
          setDialog('export')
          break
        case 'undo':
          if (editing) document.execCommand('undo')
          else undo()
          break
        case 'redo':
          if (editing) document.execCommand('redo')
          else redo()
          break
        case 'select-all':
          if (editing) document.execCommand('selectAll')
          else selectAll()
          break
        case 'duplicate':
          duplicateSelection()
          break
        case 'delete':
          deleteSelection(false)
          break
        case 'ripple-delete':
          deleteSelection(true)
          break
        case 'cut':
          cutSelection()
          break
        case 'copy':
          copySelection()
          break
        case 'paste':
          pasteClipboard()
          break
        case 'split':
          splitAtPlayhead()
          break
        case 'add-marker':
          addMarker()
          break
        case 'add-text':
          addTextClip()
          break
        case 'zoom-in':
          zoomBy(1.5)
          break
        case 'zoom-out':
          zoomBy(1 / 1.5)
          break
        case 'zoom-fit':
          zoomToFit()
          break
        case 'toggle-snapping':
          useEditor.setState((s) => ({ snapping: !s.snapping }))
          break
        case 'play-pause':
          player.toggle()
          break
        case 'go-start':
          goToStart()
          break
        case 'go-end':
          goToEnd()
          break
      }
    })
  }, [])
}
