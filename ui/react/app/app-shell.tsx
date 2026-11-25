import { Moon, Sun } from 'lucide-react'
import { useEffect, useState, type PropsWithChildren, type ReactNode } from 'react'

import { TAKO_BRAND_NAME, TAKO_BRAND_MARK } from '@/branding'
import { Button } from '@/components/ui/button'
import type { DashboardConnectionState } from '@/lib/events/dashboard-event-source'
import type { DashboardView } from '@/lib/preferences/dashboard-preferences'
import { ConnectionStatus } from './connection-status'
import { Navigation } from './navigation'
import { SettingsDialog } from './settings-dialog'

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.dataset.mode === 'light')
  function applyTheme(useLight: boolean) {
    document.documentElement.dataset.mode = useLight ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', !useLight)
    setLight(useLight)
  }

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.storageArea === localStorage && (event.key === 'tako.theme' || event.key === null)) {
        applyTheme(event.newValue === 'light')
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const label = light ? '切换到深色模式' : '切换到浅色模式'
  return <Button size="xs" isIconOnly variant="quiet" title={label} aria-label={label} onClick={() => {
    applyTheme(!light)
    try { localStorage.setItem('tako.theme', light ? 'dark' : 'light') }
    catch { /* Keep the theme for this tab when storage is unavailable. */ }
  }}>{light ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}</Button>
}

export function AppShell({
  children,
  connectionState,
  countLabel,
  navigationAddon,
  onViewChange,
  view,
}: PropsWithChildren<{
  connectionState: DashboardConnectionState
  countLabel: string
  navigationAddon?: ReactNode
  onViewChange: (view: DashboardView) => void
  view: DashboardView
}>) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <img src={TAKO_BRAND_MARK} width={24} height={24} alt="" aria-hidden="true" />
          <h1>{TAKO_BRAND_NAME}</h1>
        </div>
        <div className="app-shell__navigation-zone">
          <Navigation view={view} onViewChange={onViewChange} />
          {navigationAddon}
        </div>
        <div
          className="app-shell__actions"
          data-testid="global-actions"
          data-safe-area="global-actions"
        >
          <span className="app-shell__task-count" aria-live="polite">
            {countLabel}
          </span>
          <ConnectionStatus state={connectionState} />
          <ThemeToggle />
          <SettingsDialog />
        </div>
      </header>
      <main className="app-shell__main">{children}</main>
    </div>
  )
}
