import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../styles/tokens.css'
import './recorder.css'
import { RecorderBar } from './RecorderBar'
import { CameraBubble } from './CameraBubble'
import { AreaPicker } from './AreaPicker'

/* The small windows of the recorder: the floating bar, the camera preview and the area picker. */

const view = new URLSearchParams(location.search).get('view')
document.documentElement.dataset.platform = window.kificut.platform
document.title = view === 'camera' ? 'Kificut Camera' : view === 'area' ? 'Kificut Area' : 'Kificut Recorder'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'camera' ? <CameraBubble /> : view === 'area' ? <AreaPicker /> : <RecorderBar />}
  </StrictMode>
)
