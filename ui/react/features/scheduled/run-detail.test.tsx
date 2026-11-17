import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createDashboardApi, type DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { RunDetail } from './run-detail'

const run: RunRecord = {
  id: 'run-one', job_id: 'action-one', definition_etag: 'etag', runtime_id: 'codex',
  interactive: false, turn_revision: null, trigger: 'manual', status: 'succeeded', thread_id: 'original-session',
  scheduled_for: null, claimed_at: null, started_at: null, heartbeat_at: null, finished_at: '2026-11-10T00:01:00Z',
  exit_code: 0, error_code: null, final_message: null, file_changes: [], has_stdout_log: false, has_stderr_log: false,
  reviewed_at: null, created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:01:00Z',
}
const idle = { session: { state: 'idle' as const, can_resume: true, can_fork: true, reason: null } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup({ record = run, opening = vi.fn().mockResolvedValue(idle), resume = vi.fn().mockResolvedValue({ ok: true }), fork = vi.fn().mockResolvedValue({ ok: true }), local = true } = {}) {
  const api = {
    ...createDashboardApi({ fetchImpl: async () => { throw new Error('Unexpected network call') } }),
    settings: vi.fn().mockResolvedValue({ local_actions_supported: local }),
    scheduledRunConversation: vi.fn().mockResolvedValue({ messages: [] }),
    scheduledRunSessionOpening: opening,
    resumeScheduledRun: resume,
    forkScheduledRun: fork,
  } as DashboardApi
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><RunDetail api={api} run={record}/></QueryClientProvider>)
  return { ...view, api, opening, resume, fork, client }
}
afterEach(() => vi.useRealTimers())
const resumeButton = () => screen.getByRole('button', { name: '恢复此 Session' })
const forkButton = () => screen.getByRole('button', { name: 'Fork 此 Session' })

test.each(['active', 'unknown'] as const)('%s native session blocks resume while allowing an independent Fork', async state => {
  const { resume, fork } = setup({ opening: vi.fn().mockResolvedValue({ session: { state, can_resume: false, can_fork: true, reason: '原会话暂不能恢复' } }) })
  await waitFor(() => expect(forkButton()).toBeEnabled())
  expect(resumeButton()).toBeDisabled()
  expect(screen.getByText('原会话暂不能恢复')).toBeInTheDocument()
  expect(forkButton()).toHaveAttribute('title', 'Fork 为独立对话，保留 Action 绑定，共用原工作目录')
  fireEvent.click(resumeButton())
  fireEvent.click(forkButton())
  await waitFor(() => expect(fork).toHaveBeenCalledWith(run.id))
  expect(resume).not.toHaveBeenCalled()
})

test('idle permissions enable resume and keep clipboard copying available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const { resume } = setup()
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }))
  expect(writeText).toHaveBeenCalledWith(run.thread_id)
  fireEvent.click(resumeButton())
  await waitFor(() => expect(resume).toHaveBeenCalledWith(run.id))
  expect(await screen.findByText('Terminal 已打开')).toBeInTheDocument()
})

test('server can_resume and can_fork permissions remain authoritative when idle', async () => {
  setup({ opening: vi.fn().mockResolvedValue({ session: { state: 'idle', can_resume: false, can_fork: false, reason: '会话记录暂不可用' } }) })
  await screen.findByText('会话记录暂不可用')
  expect(resumeButton()).toBeDisabled()
  expect(forkButton()).toBeDisabled()
})

test('pending and failed status checks never assume idle and offer a working retry', async () => {
  const first = deferred<typeof idle>()
  const opening = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(idle)
  const { client } = setup({ opening })
  await waitFor(() => expect(opening).toHaveBeenCalledTimes(1))
  expect(resumeButton()).toBeDisabled()
  expect(forkButton()).toBeDisabled()
  await act(async () => { first.resolve(idle) })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  opening.mockRejectedValue(new Error('状态服务不可用'))
  await act(async () => { await client.refetchQueries({ type: 'active' }) })
  // Exercise an actual query refetch while retaining the earlier idle response.
  const retry = await screen.findByRole('button', { name: '重试检查 Session 状态' })
  expect(screen.getByRole('alert')).toHaveTextContent('状态服务不可用')
  expect(resumeButton()).toBeDisabled()
  opening.mockResolvedValue(idle)
  fireEvent.click(retry)
  await waitFor(() => expect(resumeButton()).toBeEnabled())
})

test('polls every five seconds and disables resume when the native session becomes active', async () => {
  vi.useFakeTimers()
  const opening = vi.fn().mockResolvedValueOnce(idle).mockResolvedValue({ session: { state: 'active', can_resume: false, can_fork: true, reason: '其他客户端正在执行' } })
  setup({ opening })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(resumeButton()).toBeEnabled()
  await act(async () => { await vi.advanceTimersByTimeAsync(4998) })
  expect(opening).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(2) })
  expect(opening).toHaveBeenCalledTimes(2)
  expect(resumeButton()).toBeDisabled()
  expect(forkButton()).toBeEnabled()
})

test('background refresh retains verified permissions without flashing a checking indicator', async () => {
  const next = deferred<typeof idle>()
  const opening = vi.fn().mockResolvedValueOnce(idle).mockImplementation(() => next.promise)
  const { client } = setup({ opening })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  let refreshing!: Promise<void>
  act(() => { refreshing = client.refetchQueries({ queryKey: queryKeys.runSessionOpening(run.id) }) })
  await waitFor(() => expect(opening).toHaveBeenCalledTimes(2))
  expect(resumeButton()).toBeEnabled()
  expect(forkButton()).toBeEnabled()
  expect(screen.queryByText('正在检查 Session 状态…')).not.toBeInTheDocument()
  await act(async () => { next.resolve(idle); await refreshing })
})

test('Fork success reports a terminal launch request without promising a created session', async () => {
  setup()
  await waitFor(() => expect(forkButton()).toBeEnabled())
  fireEvent.click(forkButton())
  expect(await screen.findByText('已请求在 Terminal 打开 Fork 副本')).toBeInTheDocument()
})

test('running source Run still permits Fork while original resume stays disabled', async () => {
  setup({ record: { ...run, status: 'running', finished_at: null } })
  await waitFor(() => expect(forkButton()).toBeEnabled())
  expect(resumeButton()).toBeDisabled()
})

test.each(['resume', 'fork'] as const)('%s in flight prevents either opening action from running concurrently', async mode => {
  const pending = deferred<{ ok: boolean }>()
  const resume = vi.fn().mockImplementation(() => pending.promise)
  const fork = vi.fn().mockImplementation(() => pending.promise)
  setup({ resume, fork })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  fireEvent.click(mode === 'resume' ? resumeButton() : forkButton())
  await waitFor(() => expect(mode === 'resume' ? resume : fork).toHaveBeenCalledTimes(1))
  expect(resumeButton()).toBeDisabled()
  expect(forkButton()).toBeDisabled()
  fireEvent.click(mode === 'resume' ? forkButton() : resumeButton())
  expect(mode === 'resume' ? fork : resume).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ ok: true }) })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
})

test.each(['resume', 'fork'] as const)('a %s refusal after the check stays visible and refreshes permissions', async mode => {
  const opening = vi.fn().mockResolvedValue(idle)
  const rejected = vi.fn().mockRejectedValue(new Error('点击时会话状态已改变，请重试'))
  setup({ opening, ...(mode === 'resume' ? { resume: rejected } : { fork: rejected }) })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  opening.mockResolvedValue({ session: { state: 'unknown', can_resume: false, can_fork: true, reason: null } })
  fireEvent.click(mode === 'resume' ? resumeButton() : forkButton())
  expect(await screen.findByRole('alert')).toHaveTextContent('点击时会话状态已改变，请重试')
  await waitFor(() => expect(opening).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(resumeButton()).toBeDisabled())
})

test('OpenCode preserves resume without requesting Codex state or showing Fork', async () => {
  const { opening, resume } = setup({ record: { ...run, runtime_id: 'opencode' } })
  await waitFor(() => expect(resumeButton()).toBeEnabled())
  expect(screen.queryByRole('button', { name: 'Fork 此 Session' })).not.toBeInTheDocument()
  fireEvent.click(resumeButton())
  await waitFor(() => expect(resume).toHaveBeenCalledWith(run.id))
  expect(opening).not.toHaveBeenCalled()
})

test('Linux hides local opening actions while retaining Session ID copy', async () => {
  const { opening } = setup({ local: false })
  await screen.findByRole('button', { name: '复制 Session ID' })
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复此 Session' })).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Fork 此 Session' })).not.toBeInTheDocument()
  expect(opening).not.toHaveBeenCalled()
})

test('a Run without a Session ID offers neither opening action and does not query state', async () => {
  const { opening, api } = setup({ record: { ...run, thread_id: null } })
  await waitFor(() => expect(api.settings).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: '恢复此 Session' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Fork 此 Session' })).not.toBeInTheDocument()
  expect(opening).not.toHaveBeenCalled()
})
