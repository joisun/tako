import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { BookOpen, Search } from 'lucide-react'
import { Agent,AgentHeader,AgentContent,AgentInstructions,AgentTools,AgentTool } from '@/components/ai-elements/agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogBody, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import { MemberRuntimeFields } from './member-runtime-fields'
import { AvatarEditor } from './member-identity'
import { GuidedTeamCreation } from './guided-team-creation'
import type { AgentDefinition,LoopAvatar,LoopRoom,LoopRoomDetail, LoopMember } from '@/lib/api/loop-types'

export function RoomSetupDialog({ api, room, copyFrom, onClose, onSaved }: { api:DashboardApi; room?:LoopRoomDetail; copyFrom?:LoopRoom; onClose:()=>void; onSaved:(id?:string)=>void }) {
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[mode,setMode]=useState(()=>!room&&!copyFrom&&new URLSearchParams(window.location.search).get('team_create')==='guided'?'guided':'new'),[requestKey]=useState(()=>crypto.randomUUID())
  function changeMode(value:string){setMode(value);const url=new URL(window.location.href);if(value==='guided')url.searchParams.set('team_create','guided');else url.searchParams.delete('team_create');window.history.replaceState(window.history.state,'',url)}
  function close(){const url=new URL(window.location.href);url.searchParams.delete('team_create');window.history.replaceState(window.history.state,'',url);onClose()}
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
      onSaved(result.room.id);close()
    }catch(cause){setError(cause instanceof Error?cause.message:'保存失败');setPending(false)}
  }
  if(!room&&!copyFrom&&mode==='guided')return <GuidedTeamCreation api={api} onBack={()=>changeMode('new')} onClose={close} onSaved={onSaved}/>
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)close()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><form onSubmit={submit}>
    <DialogHeader><DialogTitle>{room?'团队设置':copyFrom?'复制房间':mode==='restore'?'恢复团队':'新建团队'}</DialogTitle><DialogDescription>{copyFrom?'沿用成员及其配置，聊天与任务从空白开始。':'直接在对话中说明目标。'}</DialogDescription></DialogHeader>
    <DialogBody className="room-form"><fieldset disabled={pending} className="room-setup-fields">
      {!room&&!copyFrom?<SegmentedControl label="团队创建方式" value={mode} onValueChange={changeMode} options={[{value:'new',label:'手动创建'},{value:'guided',label:'引导式创建'},{value:'restore',label:'从目录恢复'}]}/>:null}
      {!room&&mode==='new'?<label className="room-field"><span>团队名称</span><Input name="title" required maxLength={120} autoFocus defaultValue={copyFrom?`${copyFrom.title.slice(0,117)} 副本`:undefined}/></label>:null}
      {!room&&mode==='restore'?<label className="room-field"><span>团队资料来源目录</span><Input name="source_directory" required placeholder="/path/to/saved-room"/><small>保留来源资料，恢复后先核对执行状态。</small></label>:null}
      {room||mode==='restore'?<details className="room-storage-settings"><summary>资料存储（可选）</summary><label className="room-field"><span>自定义资料目录</span><Input name="memory_directory" defaultValue={room?.config?.memory_directory??''} placeholder="留空使用 TAKO 默认存储"/><small>用于资料备份与迁移，留空由 TAKO 管理。</small></label></details>:null}
      </fieldset>{error?<p role="alert" className="room-error">{error}</p>:null}</DialogBody>

    <DialogFooter><Button onClick={close} disabled={pending}>取消</Button><Button type="submit" variant="primary" isPending={pending}>{room?'保存':copyFrom?'复制房间':mode==='restore'?'恢复团队':'创建团队'}</Button></DialogFooter>
  </form></DialogContent></Dialog>
}

export function AgentDirectoryDialog({api,room,onClose,onSaved,onManage}:{api:DashboardApi;room:LoopRoomDetail;onClose:()=>void;onSaved:()=>void;onManage:()=>void}){
  const [query,setQuery]=useState(''),[selected,setSelected]=useState<AgentDefinition|null>(null)
  const catalog=useQuery({queryKey:['agent-catalog','local'],queryFn:()=>api.agentCatalog('local'),staleTime:0})
  const rows=catalog.data?.definitions.filter(item=>[item.name,item.description,item.slug??''].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()))??[]
  if(selected)return <AgentJoinDialog api={api} room={room} profile={selected} onBack={()=>setSelected(null)} onClose={onClose} onSaved={onSaved}/>
  return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="room-dialog team-agent-picker room-theme" showCloseButton><DialogHeader><DialogTitle>选择本地 Agent</DialogTitle><DialogDescription>选择角色后，配置其在当前团队的身份。</DialogDescription></DialogHeader><DialogBody><div className="agent-directory-search"><Search/><Input autoFocus aria-label="搜索本地 Agent" placeholder="搜索本地角色…" value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="team-agent-picker-list">{rows.map(profile=>{
    const exists=room.members.some(member=>member.profile?.id===profile.id)
    return <button type="button" key={profile.id} disabled={exists} aria-label={'选择 '+profile.name} onClick={()=>setSelected(profile)}><BookOpen/><span><strong>{profile.name}</strong><small>{profile.description}</small></span>{exists?<em>已在团队</em>:null}</button>
  })}</div>{catalog.isPending?<p role="status">正在读取本地 Agent…</p>:!catalog.error&&!rows.length?<p className="room-field-note">没有匹配的本地角色，可在 Agent 管理中安装。</p>:null}{catalog.error?<p role="alert" className="room-error">{catalog.error.message}<Button onClick={()=>{void catalog.refetch()}}>重试</Button></p>:null}{catalog.data?.errors.map(item=><p key={item.source} role="alert" className="room-error">{item.message}</p>)}</DialogBody><DialogFooter><Button variant="quiet" onClick={onManage}>Agent 管理</Button><Button onClick={onClose}>取消</Button></DialogFooter></DialogContent></Dialog>
}
function AgentJoinDialog({api,room,profile,onBack,onClose,onSaved}:{api:DashboardApi;room:LoopRoomDetail;profile:AgentDefinition;onBack:()=>void;onClose:()=>void;onSaved:()=>void}){
  const [runtime,setRuntime]=useState('codex'),[name,setName]=useState(profile.name),[model,setModel]=useState<string|null>(null),[effort,setEffort]=useState<string|null>(null),[avatar,setAvatar]=useState<LoopAvatar>(()=>({seed:crypto.randomUUID()})),[pending,setPending]=useState(false),[error,setError]=useState('')
  const detail=useQuery({queryKey:['agent-definition',profile.id,runtime],queryFn:()=>api.agentDefinition(profile.id,runtime)})
  const availability=useQuery({queryKey:['room-runtime',runtime],queryFn:()=>api.roomRuntime(runtime),staleTime:60000})
  const valid=!model||availability.data?.models.some(item=>item.id===model),unavailable=availability.data?.state!=='ready'||!!availability.error
  async function confirm(){if(pending||!detail.data)return;setPending(true);setError('');try{await api.addRoomMember(room.id,{definition_id:profile.id,name:name.trim(),runtime_id:runtime,model,effort,avatar});onSaved();onClose()}catch(cause){setError(cause instanceof Error?cause.message:'加入失败')}finally{setPending(false)}}
  return <Dialog open onOpenChange={value=>{if(!value&&!pending)onClose()}}><DialogContent className="room-dialog team-agent-configuration room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>加入团队 · {profile.name}</DialogTitle><DialogDescription>角色定义不变，以下设置仅用于当前团队。</DialogDescription></DialogHeader><DialogBody><fieldset className="room-setup-fields" disabled={pending}><div className="agent-definition-fields"><label className="room-field"><span>团队中的名字</span><Input autoFocus aria-label="Agent 名字" value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label><label className="room-field"><span>运行客户端</span><select className="room-select" aria-label="运行客户端" value={runtime} onChange={event=>{setRuntime(event.target.value);setModel(null);setEffort(null)}}><option value="codex">Codex</option><option value="claude">Claude Code · 讨论与审阅</option></select></label><MemberRuntimeFields runtime={availability.data} model={model} effort={effort} onModel={value=>{setModel(value);setEffort(null)}} onEffort={setEffort}/></div><AvatarEditor value={avatar} onChange={setAvatar}/></fieldset>{detail.isPending?<p role="status">正在读取角色定义…</p>:detail.error?<p role="alert" className="room-error">{detail.error.message}</p>:<details className="team-agent-instructions"><summary>角色指令</summary><pre>{detail.data?.definition.instructions}</pre></details>}{availability.isPending?<p role="status">正在检测客户端…</p>:unavailable?<p role="alert" className="room-error">客户端不可用：{availability.data?.error_code??availability.error?.message}</p>:null}{error?<p role="alert" className="room-error">{error}</p>:null}</DialogBody><DialogFooter><Button disabled={pending} onClick={onBack}>返回</Button><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" isPending={pending} disabled={!name.trim()||!detail.data||detail.isFetching||!valid||unavailable||availability.isPending} onClick={()=>{void confirm()}}>加入团队</Button></DialogFooter></DialogContent></Dialog>
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
export function MemberRemoveDialog({api,roomId,member,onClose,onSaved}:{api:DashboardApi;roomId:string;member:LoopMember;onClose:()=>void;onSaved:()=>void}){
  const [pending,setPending]=useState(false),[error,setError]=useState('')
  async function remove(){setPending(true);try{await api.removeRoomMember(roomId,member.id,{confirm:true});onSaved();onClose()}catch(cause){setError(cause instanceof Error?cause.message:'移出失败');setPending(false)}}
  return <Dialog open onOpenChange={value=>{if(!value&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>移出 {member.name}</DialogTitle><DialogDescription>仅从当前团队移出。本地 Agent 定义、其他团队成员和历史记录保留。</DialogDescription></DialogHeader><DialogBody>{error?<p className="room-error" role="alert">{error}</p>:null}</DialogBody><DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="danger" isPending={pending} onClick={()=>{void remove()}}>确认移出</Button></DialogFooter></DialogContent></Dialog>
}
