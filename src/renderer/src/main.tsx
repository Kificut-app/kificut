import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles/tokens.css'
import './styles/base.css'
import './styles/controls.css'
import './styles/layout.css'
import './styles/media.css'
import './styles/viewer.css'
import './styles/inspector.css'
import './styles/timeline.css'
import './styles/dialogs.css'
import './styles/welcome.css'
import './styles/ai.css'
import { App } from './App'

document.documentElement.dataset.platform = window.kificut.platform

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
