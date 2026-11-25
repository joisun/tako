import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { BrowserSession } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'

const labels = { goal: '需求', completed: '已完成', current: '当前进展', blockers: '卡点', todo: '待办' } as const

export function SessionSummary({ api, session, compact = false }: {
  api: DashboardApi; session: BrowserSession; compact?: boolean
}) {
  const client = useQueryClient()
  const key = queryKeys.sessionSummary(session)
  const summary = useQuery({
    queryKey: key, queryFn: () => api.sessionSummary(session), retry: false,
    initialData: session.summary === undefined ? undefined : { summary: session.summary },
    initialDataUpdatedAt: 0,
    refetchInterval: query => query.state.data?.summary?.status === 'running' ? 1500 : false,
  })
  const generate = useMutation({
    mutationFn: () => api.generateSessionSummary(session),
    onSuccess: data => client.setQueryData(key, data),
  })
  const record = summary.data?.summary
  const running = generate.isPending || record?.status === 'running'
  const error = generate.error?.message || summary.error?.message || record?.error
  return <section className="session-summary" aria-label="会话摘要">
    <div className="session-summary__heading">
      <strong>会话摘要</strong>
      {record?.generated_at && <time dateTime={record.generated_at}>{new Date(record.generated_at).toLocaleDateString()}</time>}
      <Button size="xs" variant="quiet" disabled={running || session.state === 'unavailable'} onClick={() => generate.mutate()}>
        {running ? '生成中…' : record?.note ? '重新生成' : '生成摘要'}
      </Button>
    </div>
    {record?.note && (compact ? <p>{record.note.goal}</p> : <dl>{(Object.keys(labels) as (keyof typeof labels)[]).map(key =>
      <div key={key}><dt>{labels[key]}</dt><dd>{record.note![key]}</dd></div>)}</dl>)}
    {error && <p role="alert" className="session-error">{error}</p>}
  </section>
}
