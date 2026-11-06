import { CircleCheck, CircleX, RefreshCw, Square } from 'lucide-react'
import type { KeyboardEvent } from 'react'

import { MessageResponse } from '@/components/ai-elements/message'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTools } from '@/components/ai-elements/prompt-input'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { MarkdownCodeBlock } from '@/components/ui/code-block'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { Loader } from '@/components/ui/loader'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from '@/components/ui/message-scroller'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord, RunStatus } from '@/lib/api/types'
import { type LiveEntry, useLiveRun } from './live-run'

const CONNECTION_LABELS = {
  idle: '等待连接',
  connecting: '连接中',
  connected: '实时',
  disconnected: '正在重连',
  unavailable: '浏览器不支持实时连接',
  closed: '已结束',
} as const

function activityIcon(state: string) {
  if (state === 'running') return <Loader aria-label="运行中" />
  if (['failed', 'error', 'canceled'].includes(state)) return <CircleX aria-hidden="true" />
  return <CircleCheck aria-hidden="true" />
}

export function SessionConversation({
  entries,
  emptyText,
  isAnimating = false,
}: {
  entries: LiveEntry[]
  emptyText: string
  isAnimating?: boolean
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="live-session__conversation" role="log" aria-label="会话消息">
        <MessageScrollerViewport>
          <MessageScrollerContent className="live-session__content">
        {entries.length ? entries.map((entry) => entry.kind === 'message' ? (
          <MessageScrollerItem key={`message-${entry.itemId}`} messageId={`message-${entry.itemId}`} scrollAnchor={entry.role === 'user'}>
          <Message align={entry.role === 'user' ? 'end' : 'start'} className="live-session__entry" data-role={entry.role}>
            <MessageContent>
              <MessageHeader>{entry.role === 'user' ? '你' : 'Agent'}</MessageHeader>
              <Bubble variant={entry.role === 'user' ? 'muted' : 'ghost'}><BubbleContent>
              {entry.role === 'user' && entry.text.length > 1200 ? (
                <details>
                  <summary className="live-session__prompt-summary">展开完整指令（{entry.text.length.toLocaleString()} 字符）</summary>
                  <MessageResponse mode="static" className="live-session__message" components={{ pre: MarkdownCodeBlock }}>{entry.text}</MessageResponse>
                </details>
              ) : (
                <MessageResponse mode={isAnimating ? 'streaming' : 'static'} className="live-session__message" isAnimating={isAnimating} components={{ pre: MarkdownCodeBlock }}>
                  {entry.text}
                </MessageResponse>
              )}
              </BubbleContent></Bubble>
            </MessageContent>
          </Message>
          </MessageScrollerItem>
        ) : (
          <MessageScrollerItem key={`activity-${entry.itemId}`} messageId={`activity-${entry.itemId}`}>
          <div className="live-session__activity" data-state={entry.state} key={`activity-${entry.itemId}`}>
            {activityIcon(entry.state)}
            <span>{entry.label}</span>
          </div>
          </MessageScrollerItem>
        )) : (
          <div className="live-session__empty">{emptyText}</div>
        )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="滚动到最新消息" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

export function LiveSession({
  api,
  run,
  onTerminal,
}: {
  api: DashboardApi
  run: RunRecord
  onTerminal: (status: RunStatus) => void
}) {
  const live = useLiveRun({ api, run, onTerminal })

  if (!live.active) return null

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    if (live.canSteer) void live.steer()
  }

  return (
    <section className="live-session" aria-label="Live Session">
      <header className="live-session__header">
        <h3>Live Session</h3>
        <span data-connection={live.connection}>
          <i aria-hidden="true" />{CONNECTION_LABELS[live.connection]}
        </span>
        <Button size="xs" variant="quiet" onClick={live.reconnect} disabled={live.connection === 'closed'} aria-label="重新连接 Live Session">
          <RefreshCw aria-hidden="true" />重新连接
        </Button>
      </header>

      <SessionConversation
        entries={live.entries}
        emptyText="等待 Agent 消息…"
        isAnimating={live.connection === 'connected'}
      />

      {live.resetNotice ? <p className="live-session__notice">{live.resetNotice}</p> : null}
      <PromptInput className="live-session__composer" onSubmit={(event) => { event.preventDefault(); if (live.canSteer) void live.steer() }}>
        <PromptInputBody>
        <InputGroupTextarea
          aria-label="追加指令"
          placeholder="补充约束或修正当前方向…"
          value={live.draft}
          onChange={(event) => live.setDraft(event.currentTarget.value)}
          onKeyDown={onComposerKeyDown}
        />
        </PromptInputBody>
        {live.controlError ? <p className="live-session__error" role="alert">{live.controlError}</p> : null}
        <PromptInputFooter className="live-session__composer-actions">
          <span>⌘/Ctrl + Enter</span>
          <PromptInputTools>
          <Button
            disabled={!live.canStop}
            isPending={live.stopping}
            size="sm"
            variant="quiet"
            onClick={() => void live.stop()}
          >
            <Square aria-hidden="true" />停止
          </Button>
          <PromptInputSubmit
            disabled={!live.canSteer}
            status={live.submitting ? 'submitted' : 'ready'}
            size="sm"
          />
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
    </section>
  )
}
