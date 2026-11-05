import { MarketplaceView } from '@/features/marketplace/marketplace-view'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { queryKeys } from '@/lib/query/keys'
import { persistDashboardView, readDashboardView } from '@/lib/preferences/dashboard-preferences'
import { TeamsView } from '@/features/teams/teams-view'
import { ScheduledView } from '@/features/scheduled/scheduled-view'
import { SessionsView } from '@/features/sessions/sessions-view'
import { AppShell } from './app-shell'
import { useDashboardApi, useDashboardConnection } from './app-providers'

export function DashboardApp() {
  const api = useDashboardApi()
  const connectionState = useDashboardConnection()
  const [view, setView] = useState(readDashboardView)
  const schedules = useQuery({ queryKey: queryKeys.schedules, queryFn: () => api.schedules(), enabled: view === 'actions' })
  useEffect(() => persistDashboardView(view), [view])

  return (
    <AppShell connectionState={connectionState} countLabel={view === 'sessions' ? '本机会话' : view === 'teams' ? 'Teams' : `${schedules.data?.jobs.length ?? '—'} 个 Action`} onViewChange={setView} view={view}>
      <div className="sessions-host" hidden={view !== 'sessions'}><SessionsView api={api} /></div>
      {view === 'teams' ? <TeamsView api={api} agentManagement={<MarketplaceView api={api}/>} /> : null}
      {view === 'actions' ? <ScheduledView api={api} data={schedules.data ?? null} isPending={schedules.isPending} error={schedules.error} /> : null}
    </AppShell>
  )
}
