import './styles/fonts.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TAKO_APP_ICON } from './branding'
import { AppProviders } from './app/app-providers'
import { DashboardApp } from './app/dashboard-app'
import { migrateLegacyPreferences } from './lib/preferences/legacy-preferences'

migrateLegacyPreferences()
migrateLegacyPreferences(window.sessionStorage)

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = TAKO_APP_ICON
document.head.append(favicon)

const root = document.getElementById('root')
if (!root) throw new Error('React Dashboard root is missing')

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <DashboardApp />
    </AppProviders>
  </StrictMode>,
)
