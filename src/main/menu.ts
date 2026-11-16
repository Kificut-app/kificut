import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommand } from '@shared/ipc'

const REPO_URL = 'https://github.com/Kificut-app/kificut'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.appMenu, command)
}

/**
 * Shortcuts that would interfere with typing in text fields are shown in the menu but handled by the
 * renderer, which knows when an input has focus.
 */
function item(
  label: string,
  command: MenuCommand,
  accelerator?: string,
  global = false
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    registerAccelerator: global,
    click: () => send(command)
  }
}

export function buildMenu(isDev: boolean): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        item(`About ${app.name}`, 'about'),
        { type: 'separator' },
        item('Settings…', 'preferences', 'Cmd+,', true),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      item('New Project', 'new-project', 'CmdOrCtrl+N', true),
      item('Open Project…', 'open-project', 'CmdOrCtrl+O', true),
      ...(isMac
        ? [{ role: 'recentDocuments' as const, submenu: [{ role: 'clearRecentDocuments' as const }] }]
        : []),
      { type: 'separator' },
      item('Save', 'save', 'CmdOrCtrl+S', true),
      item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S', true),
      { type: 'separator' },
      item('Import Media…', 'import-media', 'CmdOrCtrl+I', true),
      item('Export…', 'export', 'CmdOrCtrl+E', true),
      { type: 'separator' },
      item('Close Project', 'close-project', 'CmdOrCtrl+Shift+W', true),
      ...(isMac
        ? []
        : [
            { type: 'separator' as const },
            item('Settings…', 'preferences', 'Ctrl+,', true),
            { type: 'separator' as const },
            { role: 'quit' as const, label: 'Exit' }
          ])
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      item('Undo', 'undo', 'CmdOrCtrl+Z'),
      item('Redo', 'redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      item('Duplicate', 'duplicate', 'CmdOrCtrl+D'),
      item('Delete', 'delete', isMac ? 'Backspace' : 'Delete'),
      item('Ripple Delete', 'ripple-delete', isMac ? 'Shift+Backspace' : 'Shift+Delete'),
      { type: 'separator' },
      item('Select All', 'select-all', 'CmdOrCtrl+A')
    ]
  })

  template.push({
    label: 'Timeline',
    submenu: [
      item('Split at Playhead', 'split', 'S'),
      item('Add Marker', 'add-marker', 'M'),
      item('Add Text', 'add-text', 'T'),
      { type: 'separator' },
      item('Play / Pause', 'play-pause', 'Space'),
      item('Go to Start', 'go-start', 'Home'),
      item('Go to End', 'go-end', 'End'),
      { type: 'separator' },
      item('Zoom In', 'zoom-in', '='),
      item('Zoom Out', 'zoom-out', '-'),
      item('Zoom to Fit', 'zoom-fit', 'Shift+Z'),
      { type: 'separator' },
      item('Toggle Snapping', 'toggle-snapping', 'N')
    ]
  })

  const viewMenu: MenuItemConstructorOptions[] = [
    { role: 'resetZoom', label: 'Actual Size' },
    { role: 'zoomIn', label: 'Larger Interface' },
    { role: 'zoomOut', label: 'Smaller Interface' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (isDev) {
    viewMenu.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  }
  template.push({ label: 'View', submenu: viewMenu })

  if (isMac) {
    template.push({ role: 'windowMenu' })
  }

  template.push({
    role: 'help',
    submenu: [
      item('Keyboard Shortcuts', 'shortcuts', 'CmdOrCtrl+/', true),
      { type: 'separator' },
      { label: 'Documentation', click: () => shell.openExternal(`${REPO_URL}#readme`) },
      { label: 'Report an Issue', click: () => shell.openExternal(`${REPO_URL}/issues/new`) },
      ...(isMac ? [] : [{ type: 'separator' as const }, item(`About ${app.name}`, 'about')])
    ]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
