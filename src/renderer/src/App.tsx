import { useEditor } from './store/editor'
import { useBoot } from './hooks/useBoot'
import { useMenuCommands, useShortcuts } from './hooks/useShortcuts'
import { useAiBridge } from './ai/useAiBridge'
import { TopBar } from './components/TopBar'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { ExportDialog } from './components/dialogs/ExportDialog'
import { AiDialog } from './components/dialogs/AiDialog'
import { AboutDialog, PreferencesDialog, ShortcutsDialog } from './components/dialogs/OtherDialogs'
import { BusyLayer, ConfirmLayer, ContextMenuLayer, ToastLayer } from './components/ui/overlays'
import { TooltipLayer } from './components/ui/Tooltip'

export function App() {
  const hasProject = useEditor((s) => s.project !== null)
  const dialog = useEditor((s) => s.dialog)

  useBoot()
  useShortcuts()
  useMenuCommands()
  useAiBridge()

  return (
    <div className="app">
      <TopBar />
      <main className="app__main">{hasProject ? <Workspace /> : <Welcome />}</main>

      {dialog === 'export' && hasProject && <ExportDialog />}
      {dialog === 'preferences' && <PreferencesDialog />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dialog === 'about' && <AboutDialog />}
      {dialog === 'ai' && <AiDialog />}

      <ContextMenuLayer />
      <ConfirmLayer />
      <ToastLayer />
      <BusyLayer />
      <TooltipLayer />
    </div>
  )
}
