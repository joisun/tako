import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogTrigger,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import { queryKeys } from '@/lib/query/keys'
import { useDashboardApi } from './app-providers'

export function SettingsDialog() {
  const api = useDashboardApi()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings(),
    enabled: open,
    staleTime: 0,
  })
  const save = useMutation({
    mutationFn: (patch: Parameters<DashboardApi['updateSettings']>[0]) => api.updateSettings(patch),
    onSuccess: (response) => queryClient.setQueryData(queryKeys.settings, response),
  })
  const catalog = useQuery({
    queryKey: ['dashboard', 'runtime-models', 'codex'],
    queryFn: () => api.runtimeModels('codex'), enabled: open, retry: false, staleTime: 60_000,
  })
  const models = catalog.data?.models ?? []
  const modelId = settings.data?.settings.summary_model
  const model = models.find(row => (row.id ?? row.slug) === modelId)
  const efforts = model?.reasoningLevels ?? model?.supported_reasoning_levels ?? []
  const options = settings.data?.terminal_options ?? []

  return (
    <Dialog open={open} onOpenChange={(nextOpen, details) => {
      if (save.isPending) { details.cancel(); return }
      setOpen(nextOpen)
      save.reset()
    }}>
      <DialogTrigger render={<Button aria-label="打开设置" isIconOnly size="xs" variant="quiet" />}><Settings aria-hidden="true" /></DialogTrigger>
          <DialogContent className="settings-modal" aria-label="设置" showCloseButton={!save.isPending}>
            <DialogHeader>
              <DialogTitle>设置</DialogTitle>
              <DialogDescription>{settings.data?.local_actions_supported === false ? '复制 Session ID 后，在服务器终端恢复会话。' : '选择恢复 Codex 会话时使用的终端。'}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              {settings.isPending ? <p role="status">正在读取设置…</p> : null}
              {settings.isError ? (
                <div role="alert">
                  <p>{settings.error.message}</p>
                  <Button size="sm" variant="secondary" onClick={() => void settings.refetch()}>重新读取</Button>
                </div>
              ) : null}
              {settings.data && settings.data.local_actions_supported !== false ? (
                <>
                  <Select
                    aria-label="恢复会话使用的终端"
                    value={settings.data.settings.resume_terminal}
                    disabled={save.isPending || settings.isFetching || settings.isError}
                    onValueChange={(key) => {
                      if (key !== null && key !== settings.data.settings.resume_terminal) save.mutate({ resume_terminal: String(key) })
                    }}
                  >
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem value={option.id} disabled={!option.available} key={option.id}>
                          {option.label}{option.available ? '' : ' · 未安装'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-fg-muted">选择后自动保存，下次恢复会话时生效。</p>
                </>
              ) : null}
              {settings.data && <fieldset className="session-summary-settings">
                <legend>会话摘要</legend>
                <label>模型
                  <select aria-label="摘要模型" value={modelId ?? ''} disabled={!models.length || save.isPending} onChange={event => {
                    const id = event.currentTarget.value
                    const selected = models.find(row => (row.id ?? row.slug) === id)
                    save.mutate({ summary_model: id, summary_effort: selected?.defaultReasoningLevel ?? selected?.default_reasoning_level ?? null })
                  }}>
                    <option value="" disabled>选择 Codex 模型</option>
                    {modelId && !model && <option value={modelId}>{modelId}</option>}
                    {models.map(row => <option key={row.id ?? row.slug} value={row.id ?? row.slug}>{row.displayName ?? row.display_name ?? row.id ?? row.slug}</option>)}
                  </select>
                </label>
                <label>推理强度
                  <select aria-label="摘要推理强度" value={settings.data.settings.summary_effort ?? ''} disabled={!efforts.length || save.isPending} onChange={event => {
                    if (modelId) save.mutate({ summary_model: modelId, summary_effort: event.currentTarget.value || null })
                  }}>
                    <option value="">模型默认</option>
                    {efforts.map(effort => <option key={effort}>{effort}</option>)}
                  </select>
                </label>
                {catalog.isError || (!catalog.isPending && !models.length) ? <p role="status">无法读取模型列表。<Button size="xs" variant="quiet" onClick={() => void catalog.refetch()}>重试</Button></p> : null}
              </fieldset>}
              {save.isPending ? <p role="status">正在保存…</p> : null}
              {save.isSuccess ? <p role="status">设置已保存</p> : null}
              {save.isError ? <p role="alert">{save.error.message}</p> : null}
            </DialogBody>
          </DialogContent>

    </Dialog>
  )
}
