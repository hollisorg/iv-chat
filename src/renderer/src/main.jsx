import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-condensed/800.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles.css'
import App from './App'
import Crashed from './components/Crashed'

document.documentElement.dataset.platform = window.iv.platform

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Crashed>
      <App />
    </Crashed>
  </StrictMode>
)
