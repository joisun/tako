import {useQuery,useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogBody,DialogFooter} from '@/components/ui/dialog'
import {AgentDefinitionDeleteDialog} from './definition-delete-dialog'
import type {DashboardApi} from '@/lib/api/dashboard-api'
import type {AgentDefinition} from '@/lib/api/loop-types'
import {DefinitionPreview} from './definition-preview'
export function LocalAgents({api,onManaged}:{api:DashboardApi;onManaged:()=>void}){
  const client=useQueryClient(),[query,setQuery]=useState(''),[deleting,setDeleting]=useState<AgentDefinition|null>(null),[inspecting,setInspecting]=useState<AgentDefinition|null>(null)
  const catalog=useQuery({queryKey:['agent-catalog','local'],queryFn:()=>api.agentCatalog('local'),staleTime:0})
  const detail=useQuery({queryKey:['agent-definition',inspecting?.id,'codex'],queryFn:()=>api.agentDefinition(inspecting!.id,'codex'),enabled:!!inspecting})
  const rows=catalog.data?.definitions.filter(item=>[item.name,item.description].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()))??[]
  return <><div className="market-filters market-local-filters"><Input aria-label="搜索本地定义" placeholder="搜索本地 Agent…" value={query} onChange={event=>setQuery(event.target.value)}/><Button onClick={()=>{void catalog.refetch()}}>刷新本地</Button></div>{catalog.isPending?<p role="status">正在读取本地定义…</p>:catalog.error?<p role="alert" className="market-error">{catalog.error.message}</p>:!rows.length?<div className="market-empty"><h2>没有匹配的本地 Agent</h2><p>可从发现页安装角色，或使用客户端已有的全局定义。</p></div>:null}<div className="market-source-list market-local-agents">{rows.map(profile=><article key={profile.id}><div><h3>{profile.name}<span>{profile.id.startsWith('managed:')?'UnderControl 托管':'本地全局定义'}</span></h3><p>{profile.description}</p><small>{profile.runtimes?.join(' / ')}</small></div><div><Button size="sm" onClick={()=>setInspecting(profile)}>查看定义</Button>{profile.id.startsWith('managed:')?<Button size="sm" onClick={onManaged}>管理安装</Button>:<Button size="sm" variant="danger" aria-label={'删除定义 '+profile.name} onClick={()=>setDeleting(profile)}>删除定义</Button>}</div></article>)}</div>{catalog.data?.errors.map(item=><p className="market-error" role="alert" key={item.source}>{item.message}</p>)}
    {deleting?<AgentDefinitionDeleteDialog api={api} definition={deleting} onClose={()=>setDeleting(null)} onDeleted={async()=>{await client.invalidateQueries({queryKey:['agent-catalog','local']});client.removeQueries({queryKey:['agent-definition',deleting.id]});setDeleting(null)}}/>:null}
    {inspecting?<Dialog open onOpenChange={value=>{if(!value)setInspecting(null)}}><DialogContent className="market-dialog market-dialog--wide" showCloseButton><DialogHeader><DialogTitle>{inspecting.name} · 本地定义</DialogTitle><DialogDescription>{detail.data?.definition.source?.path??'正在读取实际定义'}</DialogDescription></DialogHeader><DialogBody>{detail.isPending?<p role="status">正在读取定义…</p>:detail.error?<p role="alert" className="market-error">{detail.error.message}</p>:<DefinitionPreview content={detail.data?.definition.instructions??''}/>}</DialogBody><DialogFooter><Button onClick={()=>setInspecting(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>:null}
  </>
}
