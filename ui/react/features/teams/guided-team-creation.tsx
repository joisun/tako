import { useEffect,useRef,useState,type FormEvent } from 'react'
import { useQuery,useQueries,useQueryClient } from '@tanstack/react-query'
import { ArrowLeft,LoaderCircle,Plus,RotateCcw,Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input,TextArea } from '@/components/ui/input'
import { FieldLabel } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogBody,DialogFooter } from '@/components/ui/dialog'
import { MessageResponse } from '@/components/ai-elements/message'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { GuidedDraft,GuidedMember,GuidedPlan } from '@/lib/api/guided-types'
import { AvatarEditor } from './member-identity'
import { MemberRuntimeFields } from './member-runtime-fields'

const STORAGE='undercontrol.guided-team-draft'
interface SavedDraft {feedback:string;reviewPlanId:string|null;requirements:string;workspace:string;runtime:'codex'|'claude';model:string|null;effort:string|null;planId:string|null;draft:GuidedDraft|null;requestKey:string;requestBody:string}
function restored():SavedDraft {
  const empty:SavedDraft={feedback:'',reviewPlanId:null,requirements:'',workspace:'',runtime:'codex',model:null,effort:null,planId:null,draft:null,requestKey:crypto.randomUUID(),requestBody:''}
  try { const value=JSON.parse(sessionStorage.getItem(STORAGE)??'null');return value&&typeof value.requirements==='string'?{...empty,...value,reviewPlanId:value.reviewPlanId??(value.draft?value.planId:null)}:empty } catch{return empty}
}
const running=(plan?:GuidedPlan)=>!!plan&&['queued','running'].includes(plan.status)
const phaseLabel={queued:'等待规划',catalog:'正在读取 Agent 池',starting:'正在启动客户端',generating:'正在分析与组队',review:'团队方案'}

export function GuidedTeamCreation({api,onBack,onClose,onSaved}:{api:DashboardApi;onBack:()=>void;onClose:()=>void;onSaved:(id?:string)=>void}){
  const [saved,setSaved]=useState(restored),[pending,setPending]=useState(false),[error,setError]=useState('')
  const conversation=useRef<HTMLDivElement>(null)
  const client=useQueryClient(),applied=useRef(saved.reviewPlanId)
  const runtimes=useQueries({queries:(['codex','claude'] as const).map(id=>({queryKey:['guided-runtime',id],queryFn:()=>api.roomRuntime(id),staleTime:300000}))})
  const runtime=(id:string)=>runtimes.find(value=>value.data?.id===id)?.data
  const query=useQuery({queryKey:['guided-team-plan',saved.planId],queryFn:()=>api.guidedPlan(saved.planId!),enabled:!!saved.planId,retry:false,
    refetchInterval:value=>running(value.state.data?.plan)?1000:false})
  const plan=query.data?.plan,busy=pending||running(plan)||!!saved.planId&&query.isPending
  useEffect(()=>{try{sessionStorage.setItem(STORAGE,JSON.stringify(saved))}catch{/* Recovery is optional when browser storage is unavailable. */}},[saved])
  useEffect(()=>{
    if(plan?.status==='ready'&&plan.draft&&applied.current!==plan.id){applied.current=plan.id;setSaved(value=>({...value,draft:plan.draft,reviewPlanId:plan.id,feedback:''}))}
  },[plan])
  useEffect(()=>{if(conversation.current)conversation.current.scrollTop=conversation.current.scrollHeight},[plan?.id,plan?.messages?.length])
  function update<K extends keyof SavedDraft>(key:K,value:SavedDraft[K]){setSaved(current=>({...current,[key]:value}))}
  function member(index:number,changes:Partial<GuidedMember>){
    setSaved(current=>current.draft?{...current,draft:{...current.draft,members:current.draft.members.map((row,i)=>i===index?{...row,...changes}:row)}}:current)
  }
  function draft(changes:Partial<GuidedDraft>){setSaved(current=>current.draft?{...current,draft:{...current.draft,...changes}}:current)}
  async function generate(event?:FormEvent,force=false){
    event?.preventDefault();if(busy||!saved.requirements.trim())return
    const body={requirements:saved.requirements.trim(),workspace:saved.workspace.trim()||null,runtime_id:saved.runtime,model:saved.model,effort:saved.effort}
    const retryFinished=!!plan&&!running(plan),encoded=JSON.stringify(body),key=!force&&!retryFinished&&saved.requestBody===encoded?saved.requestKey:crypto.randomUUID()
    setPending(true);setError('');setSaved(value=>({...value,requestKey:key,requestBody:encoded}))
    try{
      const value=await api.startGuidedPlan({...body,request_key:key});applied.current=null
      client.setQueryData(['guided-team-plan',value.plan.id],value)
      setSaved(current=>({...current,planId:value.plan.id,draft:null,reviewPlanId:null}))
    }catch(cause){setError(cause instanceof Error?cause.message:'生成失败')}finally{setPending(false)}
  }
  async function refine(event?:FormEvent,regenerate=false){
    event?.preventDefault();if(busy||!saved.draft||!saved.reviewPlanId)return
    const feedback=saved.feedback.trim()||(regenerate?'请重新分析任务所需的专业角色，从 Agent 池重新匹配，保留我已调整且无关的配置。':'')
    if(!feedback)return
    const body={feedback,draft:saved.draft},encoded=JSON.stringify({parent:saved.reviewPlanId,...body})
    const retryFinished=!!plan&&['failed','canceled','interrupted'].includes(plan.status),key=!retryFinished&&saved.requestBody===encoded?saved.requestKey:crypto.randomUUID()
    setPending(true);setError('');setSaved(value=>({...value,requestKey:key,requestBody:encoded}))
    try{
      const value=await api.refineGuidedPlan(saved.reviewPlanId,{...body,request_key:key})
      client.setQueryData(['guided-team-plan',value.plan.id],value)
      setSaved(current=>({...current,planId:value.plan.id}))
    }catch(cause){setError(cause instanceof Error?cause.message:'调整失败')}finally{setPending(false)}
  }
  async function cancel(){
    if(!saved.planId)return
    setPending(true);setError('')
    try{const value=await api.cancelGuidedPlan(saved.planId);client.setQueryData(['guided-team-plan',saved.planId],value)}
    catch(cause){setError(cause instanceof Error?cause.message:'停止失败')}finally{setPending(false)}
  }
  async function create(start:boolean){
    if(!saved.draft||!saved.reviewPlanId||busy)return
    setPending(true);setError('')
    try{
      const value=await api.createGuidedTeam(saved.reviewPlanId,{...saved.draft,confirm:true,start})
      sessionStorage.removeItem(STORAGE);onSaved(value.room.id);onClose()
    }catch(cause){setError(cause instanceof Error?cause.message:'创建失败')}finally{setPending(false)}
  }
  function addMember(){
    if(!saved.draft)return
    draft({members:[...saved.draft.members,{id:crypto.randomUUID(),name:'新成员',candidate_id:null,responsibilities:'',reason:'',runtime_id:saved.runtime,model:plan?.planner.model??null,effort:null,leader:false,avatar:{seed:crypto.randomUUID()}}]})
  }
  function editRequirements(){setError('');setSaved(value=>({...value,draft:null,planId:null,reviewPlanId:null,feedback:'',requestKey:crypto.randomUUID(),requestBody:''}))}
  const proposal=saved.draft,selected=plan?.candidates??[]
  const marketNames=proposal?.members.map(row=>selected.find(candidate=>candidate.id===row.candidate_id)).filter(row=>row?.kind==='market').map(row=>row!.name)??[]
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className="room-dialog room-theme guided-team-dialog" showCloseButton={!pending}>
    <DialogHeader><DialogTitle>引导式创建</DialogTitle>{running(plan)?<div className="guided-planning-status" role="status"><LoaderCircle className="guided-spinner"/><span>{phaseLabel[plan!.phase]}</span></div>:null}</DialogHeader>
    <DialogBody className="guided-team-body">
      {!proposal?<form id="guided-team-request" onSubmit={event=>{void generate(event)}} className="room-form">
        <div className="room-field"><FieldLabel htmlFor="guided-requirements">你想完成什么？</FieldLabel><TextArea id="guided-requirements" autoFocus required maxLength={8000} rows={6} disabled={busy} value={saved.requirements} placeholder="说明目标、预期成果和限制…" onChange={event=>update('requirements',event.target.value)}/></div>
        <div className="room-field"><FieldLabel htmlFor="guided-workspace">项目目录（可选）</FieldLabel><Input id="guided-workspace" disabled={busy} value={saved.workspace} placeholder="/path/to/project" onChange={event=>update('workspace',event.target.value)}/></div>
        <details className="guided-planner-options"><summary>规划配置</summary><fieldset disabled={busy} className="agent-definition-fields">
          <label className="room-field"><span>运行客户端</span><select className="room-select" aria-label="规划客户端" disabled={busy} value={saved.runtime} onChange={event=>setSaved(value=>({...value,runtime:event.target.value as 'codex'|'claude',model:null,effort:null}))}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
          <MemberRuntimeFields runtime={runtime(saved.runtime)} model={saved.model} effort={saved.effort} onModel={value=>setSaved(current=>({...current,model:value,effort:null}))} onEffort={value=>update('effort',value)}/>
        </fieldset></details>
      </form>:<div className="guided-proposal">
        <div className="guided-requirements-preview"><p>{saved.requirements}</p><Button size="xs" variant="quiet" disabled={busy} onClick={editRequirements}>修改需求</Button></div>
        {plan?.messages?.length?<div className="guided-conversation" aria-label="组队沟通" ref={conversation}>{plan.messages.filter((_,index)=>index>0).map((message,index)=><div className="guided-conversation-message" data-role={message.role} key={index}><span>{message.role==='user'?'你':'组队助手'}</span><p>{message.content}</p></div>)}</div>:null}
        <form className="guided-feedback" onSubmit={event=>{void refine(event)}}><FieldLabel htmlFor="guided-feedback">补充意见</FieldLabel><TextArea id="guided-feedback" rows={2} maxLength={8000} disabled={busy} value={saved.feedback} placeholder="补充目标、调整角色或说明偏好…" onChange={event=>update('feedback',event.target.value)} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();void refine()}}}/><Button type="submit" disabled={busy||!saved.feedback.trim()}>调整方案</Button></form>
        <div className="room-field"><FieldLabel htmlFor="guided-title">团队名称</FieldLabel><Input id="guided-title" disabled={busy} maxLength={120} value={proposal.title} onChange={event=>draft({title:event.target.value})}/></div>
        <div className="room-field"><FieldLabel htmlFor="guided-summary">任务理解</FieldLabel><TextArea id="guided-summary" disabled={busy} rows={2} maxLength={2000} value={proposal.summary} onChange={event=>draft({summary:event.target.value})}/></div>
        <div className="guided-member-heading"><h3>团队成员 <span>{proposal.members.length}</span></h3><Button size="xs" variant="quiet" disabled={busy} onClick={addMember}><Plus/>添加成员</Button></div>
        <div className="guided-members">{proposal.members.map((row,index)=>{
          const candidate=selected.find(value=>value.id===row.candidate_id)
          return <details className="guided-member" key={row.id}>
            <summary><AgentAvatar id={row.avatar.seed} avatar={row.avatar} name={row.name}/><span><strong>{row.name}</strong><small>{candidate?.source_name??'按需求生成'}</small><span className="guided-member-scope">{row.responsibilities}</span></span>{index===0&&row.name!=='Leader'?<Badge>Leader</Badge>:null}<span className="guided-member-effort">{row.effort??'默认'}</span></summary>
            <fieldset disabled={busy} className="guided-member-fields">
              <div className="agent-definition-fields"><label className="room-field"><span>团队中的名字</span><Input aria-label={'成员 '+(index+1)+' 名字'} maxLength={80} value={row.name} onChange={event=>member(index,{name:event.target.value})}/></label>
              <label className="room-field"><span>Agent 定义</span><select className="room-select" aria-label={'成员 '+(index+1)+' Agent 定义'} value={row.candidate_id??''} onChange={event=>member(index,{candidate_id:event.target.value||null})}><option value="">按需求生成</option>{selected.map(value=><option key={value.id} value={value.id}>{value.name+' · '+value.source_name}</option>)}</select></label></div>
              <label className="room-field"><span>职责与交接</span><TextArea aria-label={'成员 '+(index+1)+' 职责'} rows={3} maxLength={4000} value={row.responsibilities} onChange={event=>member(index,{responsibilities:event.target.value})}/></label>
              <div className="agent-definition-fields"><label className="room-field"><span>运行客户端</span><select className="room-select" aria-label={'成员 '+(index+1)+' 客户端'} value={row.runtime_id} onChange={event=>member(index,{runtime_id:event.target.value as 'codex'|'claude',model:null,effort:null})}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
              <MemberRuntimeFields runtime={runtime(row.runtime_id)} model={row.model} effort={row.effort} onModel={value=>member(index,{model:value,effort:null})} onEffort={value=>member(index,{effort:value})}/></div>
              {row.reason?<p className="guided-member-reason">{row.reason}</p>:null}
              <details className="team-agent-instructions"><summary>头像</summary><AvatarEditor value={row.avatar} onChange={value=>member(index,{avatar:value})}/></details>
              {candidate?<details className="team-agent-instructions"><summary>查看定义{candidate.license?' · '+candidate.license:''}</summary>{candidate.url?<a href={candidate.url} target="_blank" rel="noreferrer">查看来源 ↗</a>:null}<MessageResponse className="guided-definition-preview" mode="static">{candidate.instructions}</MessageResponse></details>:null}
              {index>0?<Button size="xs" variant="quiet" onClick={()=>draft({members:proposal.members.filter((_,i)=>i!==index)})}><Trash2/>移出成员</Button>:null}
            </fieldset>
          </details>
        })}</div>
        <div className="room-field"><FieldLabel htmlFor="guided-acceptance">验收要求</FieldLabel><TextArea id="guided-acceptance" disabled={busy} rows={3} maxLength={2000} value={proposal.acceptance} onChange={event=>draft({acceptance:event.target.value})}/></div>
        {marketNames.length?<p className="guided-install-notice">创建时将安装所选市场定义：{marketNames.join('、')}。</p>:null}
      </div>}
      {plan?.activities?.length?<details className="guided-pool-activity" open={running(plan)||undefined}><summary>Agent 池检索 · {plan.activities.filter(row=>row.kind==='search').length} 次搜索</summary><ol>{plan.activities.map(activity=><li key={activity.id} data-state={activity.state}><span>{activity.kind==='search'?'搜索：'+activity.query:'读取定义：'+(activity.name??'…')}</span>{activity.state==='running'?<LoaderCircle className="guided-spinner"/>:null}{activity.total!=null?<small>{activity.total} 个匹配 · {activity.sources?.join('、')}</small>:null}{activity.matches?.length?<small>{activity.matches.map(row=>row.name).join('、')}</small>:null}{activity.error?<small className="room-error">{activity.error}</small>:null}</li>)}</ol></details>:null}

      {plan?.warnings.length?<details className="guided-source-warnings"><summary>部分候选未读取</summary>{plan.warnings.map(value=><p key={value}>{value}</p>)}</details>:null}
      {error||query.error||plan?.error?<p className="room-error" role="alert">{error||query.error?.message||plan?.error}</p>:null}
    </DialogBody>
    <DialogFooter>
      <Button variant="quiet" disabled={busy} onClick={onBack}><ArrowLeft/>手动创建</Button>
      {running(plan)?<Button disabled={pending} onClick={()=>{void cancel()}}>停止生成</Button>:proposal?<><Button variant="quiet" disabled={busy} onClick={()=>{void refine(undefined,true)}}><RotateCcw/>重新分析</Button><Button disabled={busy} onClick={()=>{void create(false)}}>仅创建</Button><Button variant="primary" disabled={busy} onClick={()=>{void create(true)}}>{pending?<LoaderCircle className="guided-spinner"/>:null}创建并开始</Button></>:<Button type="submit" form="guided-team-request" variant="primary" disabled={pending||!saved.requirements.trim()}>{pending?<LoaderCircle className="guided-spinner"/>:null}{plan?'重新生成':'生成团队方案'}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>
}
