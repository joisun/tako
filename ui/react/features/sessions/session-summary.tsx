import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TextArea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { BrowserSession, SessionNote } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'

const labels = { goal: '需求', completed: '已完成', current: '当前进展', blockers: '卡点', todo: '待办' } as const

const fields = Object.keys(labels) as (keyof SessionNote)[]
const emptyNote: SessionNote = { goal: '', completed: '', current: '', blockers: '', todo: '' }

export function SessionSummary({ api, session, compact = false, editable = false }: {
  api: DashboardApi; session: BrowserSession; compact?: boolean; editable?: boolean
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
  const [edit, setEdit] = useState<{ original: SessionNote | null; draft: SessionNote } | null>(null)
  const save = useMutation({
    mutationFn: (value: NonNullable<typeof edit>) => api.saveSessionSummary(session, value.draft, value.original),
    onMutate: () => client.cancelQueries({ queryKey: key }),
    onSuccess: data => { client.setQueryData(key, data); setEdit(null) },
    onError: () => { void summary.refetch() },
  })
  const record = summary.data?.summary
  const running = generate.isPending || record?.status === 'running'
  const error = save.error?.message || generate.error?.message || summary.error?.message || record?.error
  const unavailable = session.state === 'unavailable'
  return <section className="session-summary" aria-label="会话摘要">
    <div className="session-summary__heading">
      <strong>会话摘要</strong>
      {record?.generated_at && <time title="最近生成日期" dateTime={record.generated_at}>{new Date(record.generated_at).toLocaleDateString()}</time>}
      {!edit && <div className="session-summary__actions">
        {editable && <Button size="xs" variant="secondary" disabled={running || (unavailable && !record?.note) || !summary.data}
          onClick={() => { save.reset(); generate.reset(); setEdit({ original: record?.note ?? null, draft: record?.note ?? emptyNote }) }}>
          {record?.note ? '编辑摘要' : '手写摘要'}
        </Button>}
        <Button size="xs" variant="quiet" disabled={running || unavailable} onClick={() => { save.reset(); generate.mutate() }}>
          {running ? '生成中…' : record?.note ? '重新生成' : '生成摘要'}
        </Button>
      </div>}
    </div>
    {edit ? <form className="session-summary__editor" onSubmit={event => { event.preventDefault(); save.mutate(edit) }}>
      {fields.map(field => <label key={field}>{labels[field]}{field === 'goal' && <small>最多 100 字</small>}
        <TextArea rows={2} maxLength={field === 'goal' ? 100 : 1200} value={edit.draft[field]} disabled={save.isPending}
          onChange={event => setEdit({ ...edit, draft: { ...edit.draft, [field]: event.target.value } })} />
      </label>)}
      <div className="session-summary__actions">
        <Button size="sm" variant="quiet" disabled={save.isPending} onClick={() => { setEdit(null); save.reset() }}>取消</Button>
        <Button type="submit" variant="primary" size="sm" disabled={running || save.isPending || !Object.values(edit.draft).some(text => text.trim())}>{save.isPending ? '保存中…' : '保存摘要'}</Button>
      </div>
    </form> : record?.note ? (compact ? <p>{record.note.goal}</p> : <dl>{fields.map(key =>
      <div key={key}><dt>{labels[key]}</dt><dd>{record.note![key] || '—'}</dd></div>)}</dl>) :
      editable && !error && <p>{running ? '正在生成摘要…' : summary.isPending ? '正在读取摘要…' : '还没有摘要。'}</p>}
    {error && <p role="alert" className="session-error">{error}</p>}
  </section>
}
