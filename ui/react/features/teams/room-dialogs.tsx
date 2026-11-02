import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { BookOpen, Folder, Globe, RefreshCw, Search } from 'lucide-react'
import { Agent,AgentHeader,AgentContent,AgentInstructions,AgentTools,AgentTool } from '@/components/ai-elements/agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogBody, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import { MemberRuntimeFields } from './member-runtime-fields'
import { AvatarEditor } from './member-identity'
import type { LoopAvatar,LoopRoom,LoopRoomDetail, LoopMember } from '@/lib/api/loop-types'

export function RoomSetupDialog({ api, room, copyFrom, onClose, onSaved }: { api:DashboardApi; room?:LoopRoomDetail; copyFrom?:LoopRoom; onClose:()=>void; onSaved:(id?:string)=>void }) {
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[mode,setMode]=useState('new'),[requestKey]=useState(()=>crypto.randomUUID())
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(pending)return
    const data=new FormData(event.currentTarget),memory_directory=String(data.get('memory_directory')??'').trim()
    setPending(true);setError('')
    try {
      const storage=memory_directory?{memory_directory}:{}
      let result
      if(room){
        const changed=memory_directory!==(room.config?.memory_directory??'')
        result=await api.configureRoom(room.id,{...(changed?{memory_directory:memory_directory||null}:{})})
      }else if(copyFrom)result=await api.copyRoom(copyFrom.id,{title:String(data.get('title')),request_key:requestKey})
      else if(mode==='restore')result=await api.restoreRoom({source_directory:String(data.get('source_directory')).trim(),...storage})
      else result=await api.createRoom(String(data.get('title')),undefined,{request_key:requestKey})
      onSaved(result.room.id);onClose()
    }catch(cause){setError(cause instanceof Error?cause.message:'保存失败');setPending(false)}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><form onSubmit={submit}>
    <DialogHeader><DialogTitle>{room?'团队设置':copyFrom?'复制房间':mode==='restore'?'恢复团队':'新建团队'}</DialogTitle><DialogDescription>{copyFrom?'沿用成员及其配置，聊天与任务从空白开始。':'直接在对话中说明目标。'}</DialogDescription></DialogHeader>
    <DialogBody className="room-form"><fieldset disabled={pending} className="room-setup-fields">
      {!room&&!copyFrom?<SegmentedControl label="团队创建方式" value={mode} onValueChange={setMode} options={[{value:'new',label:'新建'},{value:'restore',label:'从目录恢复'}]}/>:null}
      {!room&&mode==='new'?<label className="room-field"><span>团队名称</span><Input name="title" required maxLength={120} autoFocus defaultValue={copyFrom?`${copyFrom.title.slice(0,117)} 副本`:undefined}/></label>:null}
      {!room&&mode==='restore'?<label className="room-field"><span>团队资料来源目录</span><Input name="source_directory" required placeholder="/path/to/saved-room"/><small>保留来源资料，恢复后先核对执行状态。</small></label>:null}
      {room||mode==='restore'?<details className="room-storage-settings"><summary>资料存储（可选）</summary><label className="room-field"><span>自定义资料目录</span><Input name="memory_directory" defaultValue={room?.config?.memory_directory??''} placeholder="留空使用 Rillo 默认存储"/><small>用于资料备份与迁移，留空由 Rillo 管理。</small></label></details>:null}
      </fieldset>{error?<p role="alert" className="room-error">{error}</p>:null}</DialogBody>

    <DialogFooter><Button onClick={onClose} disabled={pending}>取消</Button><Button type="submit" variant="primary" isPending={pending}>{room?'保存':copyFrom?'复制房间':mode==='restore'?'恢复团队':'创建团队'}</Button></DialogFooter>
  </form></DialogContent></Dialog>
}

export function AgentDirectoryDialog({api,room,onClose,onSaved}:{api:DashboardApi;room:LoopRoomDetail;onClose:()=>void;onSaved:()=>void}) {
  const client=useQueryClient(),[source,setSource]=useState('local'),[query,setQuery]=useState(''),[selected,setSelected]=useState('')
  const [runtime,setRuntime]=useState('codex'),[name,setName]=useState<string|null>(null),[mode,setMode]=useState('default'),[model,setModel]=useState('')
  const [effort,setEffort]=useState<string|null>(null),[avatar,setAvatar]=useState<LoopAvatar>(()=>({seed:crypto.randomUUID()}))
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[imported,setImported]=useState<Record<string,{id:string;path:string}>>({})
  const [refreshing,setRefreshing]=useState(false)
  const sources=useQuery({queryKey:['agent-catalog-sources'],queryFn:()=>api.agentCatalogSources(),staleTime:60000})
  const markets=sources.data?.sources.filter(item=>item.id!=='local')??[]
  const catalog=useQuery({queryKey:['agent-catalog',source],queryFn:()=>api.agentCatalog(source),staleTime:30000})
  const rows=catalog.data?.definitions.filter(item=>`${item.name} ${item.slug??''} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))??[]
  const id=selected||rows[0]?.id||''
  const detail=useQuery({queryKey:['agent-definition',id,runtime],queryFn:()=>api.agentDefinition(id,runtime),enabled:!!id})
  const availability=useQuery({queryKey:['room-runtime',runtime],queryFn:()=>api.roomRuntime(runtime),staleTime:60000})
  const definition=detail.data?.definition, saved=imported[id], localId=source==='local'?id:saved?.id
  const exists=room.members.some(member=>Boolean(localId&&member.profile?.id===localId)||member.profile?.id===id||member.profile?.source?.origin?.id===id)
  const validModel=mode==='default'||!!availability.data?.models.some(item=>item.id===model)
  const unavailable=availability.data?.state==='unavailable'||!!availability.error
  function chooseSource(value:string){if(pending||refreshing)return;setSource(value);setSelected('');setName(null);setError('')}
  async function refreshMarket(){
    if(pending||refreshing||catalog.isFetching)return
    setRefreshing(true);setError('')
    const previous=catalog.data?.definitions.find(item=>item.id===id)
    try{
      const updated=await api.agentCatalog(source,{refresh:true})
      const next=previous?.source?.path?updated.definitions.find(item=>item.source?.path===previous.source?.path):undefined
      client.setQueryData(['agent-catalog',source],updated);setSelected(next?.id??'')
    }catch(cause){setError(cause instanceof Error?cause.message:'刷新市场失败')}finally{setRefreshing(false)}
  }
  async function confirm() {
    if(!definition||pending||refreshing)return
    setPending(true);setError('')
    try {
      if(!localId) {
        const result=await api.importAgent({definition_id:id,runtime_id:runtime})
        setImported(value=>({...value,[id]:{id:result.definition.id,path:result.path}}))
        await client.invalidateQueries({queryKey:['agent-catalog','local']})
      } else {
        await api.addRoomMember(room.id,{definition_id:localId,name:(name??definition.name).trim(),runtime_id:runtime,model:mode==='specific'?model:null,effort,avatar})
        onSaved();onClose()
      }
    } catch(cause){setError(cause instanceof Error?cause.message:'添加失败')}finally{setPending(false)}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className="room-agent-directory room-theme" showCloseButton={!pending}>
    <DialogHeader><DialogTitle>添加 Agent</DialogTitle><DialogDescription>选择角色，配置在这个团队中的身份。</DialogDescription></DialogHeader>
    <div className="agent-directory-layout"><aside>
      <SegmentedControl label="Agent 来源" value={source==='local'?'local':'market'} onValueChange={value=>{if(value==='local')chooseSource('local');else if(markets[0])chooseSource(markets[0].id)}} options={[{value:'local',label:<><Folder/>本地 Agent</>},{value:'market',label:<><Globe/>Agent 市场</>,disabled:!markets.length}]}/>
      {sources.error?<div><p className="room-error" role="alert">{sources.error.message}</p><Button size="xs" variant="quiet" onClick={()=>{void sources.refetch()}}>重试市场来源</Button></div>:null}
      {source!=='local'?<div className="agent-market-controls"><select className="room-select" aria-label="Agent 市场来源" value={source} disabled={pending||refreshing} onChange={event=>chooseSource(event.target.value)}>{markets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><Button size="sm" variant="quiet" isIconOnly aria-label="刷新 Agent 市场" title="在线刷新目录" disabled={pending||catalog.isFetching} isPending={refreshing} onClick={()=>{void refreshMarket()}}><RefreshCw/></Button></div>:null}
      <div className="agent-directory-search"><Search/><Input aria-label="搜索 Agent 定义" placeholder="搜索角色…" value={query} disabled={pending} onChange={event=>setQuery(event.target.value)}/></div>
      <div className="agent-directory-list">{rows.map(item=><button type="button" key={item.id} disabled={pending} data-selected={item.id===id||undefined} onClick={()=>{setSelected(item.id);setName(null);setMode('default');setModel('');setEffort(null);setError('')}}><BookOpen/><div><strong>{item.name}</strong><span>{item.description.slice(0,100)}</span>{imported[item.id]?<small>已添加到本地</small>:null}</div></button>)}{catalog.isPending?<p role="status">正在读取目录…</p>:!catalog.error&&!rows.length?<p>没有匹配的角色</p>:null}{catalog.error?<div><p className="room-error" role="alert">{catalog.error.message}</p><Button size="xs" variant="quiet" onClick={()=>{void catalog.refetch()}}>重试目录</Button></div>:null}{catalog.data?.errors.map(item=><p key={item.source} role="alert" className="room-error" title={item.source}>{item.message}</p>)}</div>
    </aside><section className="agent-definition-detail">{definition?<>
      <h3>{definition.name}</h3><p>{definition.description}</p><div className="agent-definition-meta"><span>{definition.source?.label}</span>{definition.source?.license?<span>{definition.source.license}</span>:null}{definition.source?.revision?<code>{definition.source.revision.slice(0,8)}</code>:null}</div>
      <fieldset className="agent-definition-fields" disabled={pending}><label className="room-field"><span>团队中的名字</span><Input aria-label="Agent 名字" value={name??definition.name} maxLength={80} onChange={event=>setName(event.target.value)}/></label>
        <label className="room-field"><span>运行客户端</span><select className="room-select" aria-label="运行客户端" value={runtime} onChange={event=>{setRuntime(event.target.value);setMode('default');setModel('');setEffort(null);setError('')}}><option value="codex">Codex</option><option value="claude">Claude Code · 讨论与审阅</option><option disabled>OpenCode · 未接入</option></select></label>
        <MemberRuntimeFields runtime={availability.data} model={model||null} effort={effort} onModel={value=>{setModel(value??'');setMode(value?'specific':'default');setEffort(null)}} onEffort={setEffort}/>
      </fieldset>
      {availability.isPending?<p className="room-field-note" role="status">正在检测客户端…</p>:unavailable?<p className="room-error" role="alert">客户端不可用：{availability.data?.error_code??availability.error?.message}</p>:!availability.data?.model_override_supported?<p className="room-field-note">客户端未提供可验证的模型列表，仅支持跟随默认模型。</p>:null}
      {mode==='specific'&&model&&!validModel?<p className="room-error">该 ID 不在客户端返回的可用模型中</p>:null}
      <AvatarEditor value={avatar} onChange={setAvatar}/>
      <Agent><AgentHeader name={name??definition.name} model={model||'跟随客户端默认模型'}/><AgentContent><AgentInstructions>{definition.instructions??''}</AgentInstructions></AgentContent></Agent>
      <div className="agent-definition-source">{definition.source?.url?<a href={definition.source.url} target="_blank" rel="noreferrer">查看固定版本来源 ↗</a>:<code>{definition.source?.path}</code>}{saved?<span role="status">已保存到 {saved.path}</span>:null}</div>
    </>:<div className="room-empty"><BookOpen/><p>{detail.isPending&&id?'正在读取定义…':'选择角色查看完整定义'}</p></div>}{detail.error||error?<p className="room-error" role="alert">{error||detail.error?.message}</p>:null}</section></div>
    <DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" isPending={pending} disabled={refreshing||!definition||exists||!((name??definition?.name)?.trim())||!!localId&&(!validModel||unavailable||availability.isPending)} onClick={()=>{void confirm()}}>{exists?'已在团队':localId?'加入团队':'添加到本地'}</Button></DialogFooter>
  </DialogContent></Dialog>
}

export function MemberDefinitionDialog({api,roomId,member,onClose,onMention}:{api:DashboardApi;roomId:string;member:LoopMember;onClose:()=>void;onMention:(member:LoopMember)=>void}) {
  const detail=useQuery({queryKey:['room-member-definition',roomId,member.id],queryFn:()=>api.roomMemberDefinition(roomId,member.id)})
  const current=detail.data?.member??member,definition=detail.data?.definition
  return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="room-member-definition room-theme" showCloseButton>
    <DialogHeader><DialogTitle>{current.name} · Agent 定义</DialogTitle><DialogDescription>{detail.data?.source==='snapshot'?'加入团队时保存的定义快照':'成员关联的角色定义'}</DialogDescription></DialogHeader>
    <DialogBody>{detail.isPending?<p role="status">正在读取定义…</p>:null}{detail.error?<p role="alert" className="room-error">{detail.error.message}</p>:null}
      {definition?.instructions?<Agent><AgentHeader name={definition.name} model={current.execution_config?.model??'跟随客户端默认模型'}/><AgentContent>
        <dl className="member-definition-facts"><dt>定义标识</dt><dd>{definition.id}</dd><dt>定义来源</dt><dd>{definition.source?.label??'本地定义'}</dd><dt>运行客户端</dt><dd>{current.runtime_id==='claude'?'Claude Code':'Codex'}</dd><dt>推理强度</dt><dd>{current.execution_config?.effort??'跟随客户端默认'}</dd></dl>
        <AgentInstructions>{definition.instructions}</AgentInstructions>{definition.tools?.length?<AgentTools>{definition.tools.map(name=><AgentTool key={name} name={name} description="角色定义中的声明；不代表当前执行已授权此工具。实际权限由客户端和本次执行决定。"/>)}</AgentTools>:null}
      </AgentContent></Agent>:!detail.isPending&&!detail.error?<p role="status">{detail.data?.message??'没有可读取的 Agent 定义'}</p>:null}
      {definition?.source?.url?<a className="agent-definition-source" href={definition.source.url} target="_blank" rel="noreferrer">查看来源 ↗</a>:<code className="agent-definition-source">{definition?.source?.path}</code>}
    </DialogBody><DialogFooter><Button onClick={onClose}>关闭</Button><Button variant="primary" onClick={()=>{onMention(current);onClose()}}>在对话中提及</Button></DialogFooter>
  </DialogContent></Dialog>
}

export function MemberEditDialog({api,roomId,member,onClose,onSaved}:{api:DashboardApi;roomId:string;member:LoopMember;onClose:()=>void;onSaved:()=>void}){
  const [name,setName]=useState(member.name),[model,setModel]=useState(member.execution_config?.model??null),[effort,setEffort]=useState(member.execution_config?.effort??null),[avatar,setAvatar]=useState<LoopAvatar>(member.avatar??{seed:member.id}),[pending,setPending]=useState(false),[error,setError]=useState('')
  const runtime=useQuery({queryKey:['room-runtime',member.runtime_id],queryFn:()=>api.roomRuntime(member.runtime_id),staleTime:60000})
  async function save(){setPending(true);setError('');try{await api.updateRoomMember(roomId,member.id,{name,model,effort,avatar});onSaved();onClose()}catch(cause){setError(cause instanceof Error?cause.message:'保存失败');setPending(false)}}
  return <Dialog open onOpenChange={value=>{if(!value&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>编辑成员</DialogTitle><DialogDescription>仅修改在此团队的身份和运行配置。</DialogDescription></DialogHeader><DialogBody><fieldset className="room-setup-fields" disabled={pending}><label className="room-field"><span>团队中的名字</span><Input autoFocus value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label><div className="agent-definition-fields"><MemberRuntimeFields runtime={runtime.data} model={model} effort={effort} onModel={value=>{setModel(value);setEffort(null)}} onEffort={setEffort}/></div><AvatarEditor value={avatar} onChange={setAvatar}/></fieldset>{error?<p className="room-error" role="alert">{error}</p>:null}</DialogBody><DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" isPending={pending} disabled={!name.trim()} onClick={()=>{void save()}}>保存</Button></DialogFooter></DialogContent></Dialog>
}
export function MemberDeleteDialog({api,roomId,member,onClose,onSaved}:{api:DashboardApi;roomId:string;member:LoopMember;onClose:()=>void;onSaved:()=>void}){
  const plan=useQuery({queryKey:['room-member-delete',roomId,member.id],queryFn:()=>api.roomMemberDeletion(roomId,member.id)}),[pending,setPending]=useState(false),[error,setError]=useState('')
  async function remove(){if(!plan.data)return;setPending(true);try{await api.deleteRoomMember(roomId,member.id,{confirm:true,files:plan.data.files});onSaved();onClose()}catch(cause){setError(cause instanceof Error?cause.message:'删除失败');setPending(false);void plan.refetch()}}
  return <Dialog open onOpenChange={value=>{if(!value&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>删除 {member.name}</DialogTitle><DialogDescription>移除当前团队成员，同时删除以下本地全局 Agent 定义。</DialogDescription></DialogHeader><DialogBody>{plan.data?.files.length?<ul className="room-delete-files">{plan.data.files.map(file=><li key={file.path}><code>{file.path}</code></li>)}</ul>:<p>{plan.isPending?'正在检查定义文件…':'此成员没有关联的本地定义，仅删除团队成员。'}</p>}<p className="room-field-note">历史消息和执行记录保留。其他团队继续使用已保存的定义快照。</p>{plan.error||error?<p className="room-error" role="alert">{error||plan.error?.message}</p>:null}</DialogBody><DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" className="room-delete-button" disabled={!plan.data} isPending={pending} onClick={()=>{void remove()}}>确认删除</Button></DialogFooter></DialogContent></Dialog>
}
