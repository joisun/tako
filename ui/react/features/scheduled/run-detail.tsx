import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { Pill } from '@/components/kibo-ui/pill'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clipboard, FileText, GitFork, RefreshCw, Square, Terminal } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader } from '@/components/ui/code-block'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import {
  fullDateTime,
  runDuration,
  runStatusLabel,
  triggerLabel,
} from './schedule-format'
import { LiveSession, SessionConversation } from './live-session'

const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running'])

export function RunDetail({ api, run, onFollowUp }: { api: DashboardApi; run: RunRecord; onFollowUp?: (run: RunRecord) => void }) {
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState('')
  const active = ACTIVE_STATUSES.has(run.status)
  const input = JSON.stringify(run.data ?? null, null, 2)
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: () => api.settings(), staleTime: 60_000 })
  const localActions = Boolean(settings.data && settings.data.local_actions_supported !== false)
  const checkSession = localActions && run.runtime_id === 'codex' && Boolean(run.thread_id)
  const sessionOpening = useQuery({
    queryKey: queryKeys.runSessionOpening(run.id),
    queryFn: () => api.scheduledRunSessionOpening(run.id),
    enabled: checkSession,
    refetchInterval: 5_000,
    retry: false,
  })
  const session = sessionOpening.data?.session
  const checkedSession = !sessionOpening.isPending && !sessionOpening.isError
  const canResume = !active && (!checkSession || (checkedSession && session?.state === 'idle' && session.can_resume))
  const canFork = checkSession && checkedSession && session?.can_fork === true
  const openingLock = useRef(false)
  let resumeTitle = '恢复此 Session'
  if (active) resumeTitle = '运行结束后恢复 Session'
  else if (checkSession && !canResume) resumeTitle = session?.reason ?? '检查会话状态后恢复 Session'
  const sessionReason = session?.reason ?? (session?.state === 'active' ? '原会话正在执行，暂不能恢复。' : session?.state === 'unknown' ? '暂时无法确认原会话是否空闲。' : null)

  const [draft, setDraft] = useState('')
  const pendingMessage = useRef<{ text: string; id: string } | null>(null)
  const followup = useMutation({
    mutationFn: () => {
      const text = draft.trim()
      if (pendingMessage.current?.text !== text) {
        const id = globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`
        pendingMessage.current = { text, id }
      }
      return api.followUpRun(run.id, text, pendingMessage.current.id)
    },
  })
  function sendFollowUp() {
    if (!draft.trim() || followup.isPending) return
    followup.mutate(undefined, { onSuccess: ({ run: next }) => {
      setDraft('')
      pendingMessage.current = null
      onFollowUp?.(next)
    } })
  }

  const reviewed = useMutation({
    mutationFn: () => api.markScheduledRunReviewed(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : '标记失败'),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKeys.run(run.id), response)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
      ])
    },
  })
  const opening = useMutation({
    mutationFn: (mode: 'resume' | 'fork') => mode === 'fork' ? api.forkScheduledRun(run.id) : api.resumeScheduledRun(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : 'Terminal 打开失败'),
    onSettled: () => {
      openingLock.current = false
      if (checkSession) void queryClient.invalidateQueries({ queryKey: queryKeys.runSessionOpening(run.id) })
    },
  })
  function openSession(mode: 'resume' | 'fork') {
    if (openingLock.current || !localActions || !run.thread_id || !(mode === 'fork' ? canFork : canResume)) return
    openingLock.current = true
    opening.mutate(mode)
  }
  const fileOpen = useMutation({
    mutationFn: (path: string) => api.openRunFile(run.id, path),
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : '停止失败'),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKeys.run(run.id), response)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
      ])
    },
  })
  const conversation = useQuery({
    queryKey: queryKeys.runConversation(run.id),
    queryFn: () => api.scheduledRunConversation(run.id),
    enabled: !active && Boolean(run.thread_id),
  })
  const historicalEntries = useMemo(() => {
    const entries = (conversation.data?.messages ?? []).map((message) => ({
      kind: 'message' as const,
      itemId: message.id,
      role: message.role,
      text: message.text,
    }))
    if (entries.length || !run.final_message) return entries
    return [{
      kind: 'message' as const,
      itemId: 'final-message',
      role: 'assistant' as const,
      text: run.final_message,
    }]
  }, [conversation.data?.messages, run.final_message])

  async function copySession() {
    if (!run.thread_id) return
    try {
      await navigator.clipboard.writeText(run.thread_id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setActionError('无法复制 Session ID')
    }
  }

  return (
    <article className="run-detail">
      <div className="run-detail__summary">
        <div>
          <Pill className="run-detail__status" data-status={run.status}>
            <i aria-hidden="true" />{runStatusLabel(run.status)}
          </Pill>
          <strong>{triggerLabel(run.trigger)}</strong>
          <div className="run-detail__actions">
          {active && !run.interactive ? (
            <Button
              isPending={cancel.isPending}
              size="xs"
              variant="quiet"
              onClick={() => cancel.mutate()}
            >
              <Square aria-hidden="true" />停止
            </Button>
          ) : null}
          {run.thread_id ? (
            <>
              {localActions ? <>
                <Button aria-label="恢复此 Session" title={resumeTitle} isIconOnly isPending={opening.isPending && opening.variables === 'resume'} disabled={!canResume || opening.isPending} size="xs" variant="quiet" onClick={() => openSession('resume')}>
                  <Terminal aria-hidden="true" />
                </Button>
                {checkSession ? <Button aria-label="Fork 此 Session" title="Fork 为独立对话，保留 Action 绑定，共用原工作目录" isIconOnly isPending={opening.isPending && opening.variables === 'fork'} disabled={!canFork || opening.isPending} size="xs" variant="quiet" onClick={() => openSession('fork')}>
                  <GitFork aria-hidden="true" />
                </Button> : null}
              </> : null}
              <Button aria-label="复制 Session ID" title="复制 Session ID" isIconOnly size="xs" variant="quiet" onClick={() => void copySession()}>
                {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
              </Button>
            </>
          ) : null}
          </div>
        </div>
        <dl>
          <div><dt>开始</dt><dd>{fullDateTime(run.started_at ?? run.created_at)}</dd></div>
          <div><dt>耗时</dt><dd>{runDuration(run.started_at, run.finished_at)}</dd></div>
          <div><dt>Exit code</dt><dd>{run.exit_code ?? '—'}</dd></div>
          <div><dt>Runtime</dt><dd>{run.runtime_id}</dd></div>
        </dl>
        {checkSession ? <>
          {sessionOpening.isPending ? <p className="run-detail__action-status" role="status">正在检查 Session 状态…</p> : null}
          {sessionOpening.isError ? <p className="run-detail__action-error" role="alert">无法检查 Session 状态：{sessionOpening.error.message} <Button size="xs" variant="quiet" isPending={sessionOpening.isFetching} aria-label="重试检查 Session 状态" onClick={() => void sessionOpening.refetch()}><RefreshCw aria-hidden="true"/>重试</Button></p> : sessionReason ? <p className="run-detail__action-status" role="status">{sessionReason}</p> : null}
        </> : null}
        {opening.isSuccess ? <p className="run-detail__action-status" role="status">{opening.variables === 'fork' ? '已请求在 Terminal 打开 Fork 副本' : 'Terminal 已打开'}</p> : null}
        {actionError ? <p className="run-detail__action-error" role="alert">{actionError}</p> : null}
      </div>

      <Tabs defaultValue="conversation" className="run-detail__tabs">
        <TabsList aria-label="运行详情">
          <TabsTrigger value="conversation">会话</TabsTrigger>
          <TabsTrigger value="input">本轮输入</TabsTrigger>
          <TabsTrigger value="files">产出文件</TabsTrigger>
          {run.error_code ? <TabsTrigger value="details">详情</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="conversation" keepMounted className="run-detail__panel run-detail__panel--conversation">
      <LiveSession
        api={api}
        run={run}
        onTerminal={() => {
          void Promise.all([
            queryClient.refetchQueries({ queryKey: queryKeys.run(run.id), exact: true }),
            queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
          ])
        }}
      />

      {active && !run.interactive ? (
        <section className="live-session" aria-label="Session 对话">
          <SessionConversation entries={[]} emptyText={run.thread_id ? '此运行尚未提供实时对话，结束后可查看会话记录。' : '等待创建 Session…'} />
        </section>
      ) : null}

      {!active ? (
        <section className="live-session" aria-label="Session 对话">
          <header className="live-session__header">
            <h3>Session 对话</h3>
            <div className="live-session__header-actions">
              <span>{conversation.data?.truncated ? '仅展示最近消息' : `${run.runtime_id === 'opencode' ? 'OpenCode' : 'Codex'} 本地 Session`}</span>
              {conversation.isError && <Button size="xs" variant="quiet" isPending={conversation.isFetching} onClick={() => void conversation.refetch()}><RefreshCw aria-hidden="true" />重新读取</Button>}
              {!run.reviewed_at ? (
                <Button size="xs" variant="quiet" isPending={reviewed.isPending} onClick={() => reviewed.mutate()}>
                  <Check aria-hidden="true" />标记已读
                </Button>
              ) : <span>已读</span>}
            </div>
          </header>
          <SessionConversation
            entries={historicalEntries}
            emptyText={!run.thread_id
              ? '此 Run 没有可恢复的 Session'
              : conversation.isPending
                ? '正在读取对话…'
                : conversation.isError
                  ? 'Codex 本地 Session 暂不可用'
                  : 'Session 中没有可展示的对话'}
          />
          {run.thread_id && onFollowUp ? (
            <PromptInput className="live-session__composer" onSubmit={event => { event.preventDefault(); sendFollowUp() }}>
              <PromptInputBody>
                <InputGroupTextarea aria-label="继续会话" placeholder="继续这个会话…" value={draft} disabled={followup.isPending}
                  onChange={event => setDraft(event.currentTarget.value)}
                  onKeyDown={event => {
                    if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      sendFollowUp()
                    }
                  }} />
              </PromptInputBody>
              {followup.isError && <p className="live-session__error" role="alert">{followup.error.message}</p>}
              <PromptInputFooter><PromptInputSubmit status={followup.isPending ? 'submitted' : 'ready'} disabled={!draft.trim()} /></PromptInputFooter>
            </PromptInput>
          ) : null}
          {conversation.isError && run.final_message ? (
            <p className="live-session__notice">本地 Session 不可用，当前显示 Run final message。</p>
          ) : null}
        </section>
      ) : null}

        </TabsContent>

        <TabsContent value="input" keepMounted className="run-detail__panel run-detail__panel--input">
          <CodeBlock className="run-detail__input-code">
            <CodeBlockHeader><span>data · JSON</span><CodeBlockCopyButton code={input} /></CodeBlockHeader>
            <CodeBlockContent aria-label="本轮输入 JSON">{input}</CodeBlockContent>
          </CodeBlock>
        </TabsContent>

        {run.error_code ? (
        <TabsContent value="details" keepMounted className="run-detail__panel">
        <section className="run-detail__section">
          <div className="run-detail__section-heading"><h3>错误</h3></div>
          <code className="run-detail__error">{run.error_code === 'RUNTIME_SESSION_IN_USE' ? '该会话正被其他 Codex 客户端占用，无法继承。请先在占用它的终端或客户端中退出该会话，再重新运行任务。' : run.error_code === 'RUNTIME_PROTOCOL_CLOSED' ? `${run.runtime_id === 'opencode' ? 'OpenCode' : 'Codex'} 执行连接已关闭，本次任务已结束。可查看退出码后重新运行。` : run.error_code === 'RUNTIME_PROTOCOL_FRAME_TOO_LARGE' ? '执行器单条消息超过接收上限，本次运行已中断。Session 已保留时可在 Terminal 恢复。' : run.error_code === 'RUNTIME_TIMEOUT' ? '执行超过任务设置的时间上限。请检查超时配置，或从已保存的 Session 继续。' : run.error_code === 'RUNTIME_PERMISSION_REQUIRED' ? 'OpenCode 正在等待工具权限，本次任务已停止。请调整本机 OpenCode 权限后重新运行，或在 Terminal 恢复。' : run.error_code === 'RUNTIME_INPUT_REQUIRED' ? 'OpenCode 需要交互回答，本次任务已停止。可在 Terminal 恢复后继续。' : run.error_code === 'RUNTIME_MODEL_UNAVAILABLE' ? '所选模型在当前地区不可用，请换用可访问的模型。' : run.error_code}</code>
          {run.runtime_id === 'opencode' && run.final_message ? <p className="run-detail__error-detail">{run.final_message}</p> : null}
        </section>
        </TabsContent>
        ) : null}

        <TabsContent value="files" keepMounted className="run-detail__panel">
      <section className="run-detail__section">
        <div className="run-detail__section-heading"><h3>产出文件</h3><span>{run.file_changes.length}</span></div>
        {run.file_changes.length ? (
          <ul className="run-detail__files">
            {run.file_changes.map((file) => (
              <li key={`${file.kind}-${file.path}`}
                title={['delete', 'deleted', 'removed'].includes(file.kind) ? '文件已删除，无法打开' : file.path}>
                <FileText aria-hidden="true" />
                {['delete', 'deleted', 'removed'].includes(file.kind) ? <code className="run-detail__file-deleted">{file.path}</code> : (
                  <a className="run-detail__file-open" href={api.previewRunFileUrl(run.id, file.path)}
                    aria-label={`访问文件 ${file.path}`} target="_blank" rel="noopener noreferrer"><code>{file.path}</code></a>
                )}
                <div className="run-detail__file-actions" title={localActions ? '系统打开会使用服务所在机器的默认应用' : undefined}>
                  {localActions && !['delete', 'deleted', 'removed'].includes(file.kind) ? (
                    <Button aria-label={`系统打开文件 ${file.path}`}
                      disabled={fileOpen.isPending} size="xs" variant="quiet" onClick={() => fileOpen.mutate(file.path)}>系统打开</Button>
                  ) : null}
                  <span>{file.kind}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="run-detail__empty">没有记录文件变更</p>}
        {fileOpen.isPending || fileOpen.isSuccess ? (
          <p className="run-detail__action-status" role="status">
            {fileOpen.isPending ? '正在请求系统打开…' : `已请求系统打开：${fileOpen.data?.path}`}
          </p>
        ) : null}
        {fileOpen.isError ? (
          <p className="run-detail__action-error" role="alert">
            {fileOpen.error instanceof Error ? fileOpen.error.message : '无法打开文件'}
          </p>
        ) : null}
      </section>

        </TabsContent>
      </Tabs>
    </article>
  )
}
