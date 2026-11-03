import {useQuery} from '@tanstack/react-query'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogBody,DialogFooter} from '@/components/ui/dialog'
import type {DashboardApi} from '@/lib/api/dashboard-api'
import type {AgentDefinition} from '@/lib/api/loop-types'
export function AgentDefinitionDeleteDialog({api,definition,onClose,onDeleted}:{api:DashboardApi;definition:AgentDefinition;onClose:()=>void;onDeleted:()=>Promise<void>}){
  const plan=useQuery({queryKey:['agent-definition-delete',definition.id],queryFn:()=>api.agentDeletion(definition.id)}),[pending,setPending]=useState(false),[error,setError]=useState('')
  async function remove(){if(!plan.data||pending)return;setPending(true);setError('');try{await api.deleteAgentDefinition(definition.id,{confirm:true,files:plan.data.files});await onDeleted()}catch(cause){setError(cause instanceof Error?cause.message:'删除失败');setPending(false);void plan.refetch()}}
  return <Dialog open onOpenChange={value=>{if(!value&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>删除本地定义 · {definition.name}</DialogTitle><DialogDescription>删除以下全局定义文件，不移出已有团队成员。</DialogDescription></DialogHeader><DialogBody>{plan.data?<><ul className="room-delete-files">{plan.data.files.map(file=><li key={file.path}><code>{file.path}</code></li>)}</ul><p className="room-field-note">{plan.data.teams} 个团队已使用此定义，继续使用各自保存的快照。其他客户端将无法从这些文件加载此角色。</p></>:plan.isPending?<p role="status">正在检查定义文件…</p>:null}{plan.error||error?<p className="room-error" role="alert">{error||plan.error?.message}</p>:null}</DialogBody><DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="danger" disabled={!plan.data||plan.isFetching||!!plan.error} isPending={pending} onClick={()=>{void remove()}}>确认删除</Button></DialogFooter></DialogContent></Dialog>
}
