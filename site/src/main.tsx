import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAnalytics } from './analytics.ts'
import './index.css'
import App from './App.tsx'

initAnalytics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
