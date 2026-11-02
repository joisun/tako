import { useEffect,useState,type ComponentProps } from 'react'
import { LoaderCircle,Terminal,Wrench } from 'lucide-react'
import { Message,MessageContent,MessageResponse } from '@/components/ai-elements/message'
import { ChainOfThought,ChainOfThoughtHeader,ChainOfThoughtContent,ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { Tool,ToolHeader,ToolContent,ToolInput,ToolOutput } from '@/components/ai-elements/tool'
import { Attachments,Attachment,AttachmentInfo } from '@/components/ai-elements/attachments'
import { InlineCitationLink } from '@/components/ai-elements/inline-citation'
import { Badge } from '@/components/ui/badge'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { MentionMessage } from './message-mentions'
import type { LoopMember,LoopRoomDetail,LoopTaskDetail,LoopRun } from '@/lib/api/loop-types'
const LIVE=new Set(['starting','running','stopping','unknown']),OPEN=new Set([...LIVE,'queued'])
const ACTION_LABEL={delegate:{badge:'指派',recipient:'指派给'},verify:{badge:'验证',recipient:'验证交给'},reply:{badge:'回复',recipient:'回复给'},announce:{badge:'广播',recipient:'广播给'}}
const markdownComponents={a:({href,children}:ComponentProps<'a'>)=><InlineCitationLink href={href??''}>{children}</InlineCitationLink>}
function runLabel(run:LoopRun){
  if(run.status==='queued')return '等待执行'
  if(run.status==='unknown')return '执行状态待核对'
  if(run.status==='stopping')return '正在停止'
  if(run.status==='starting'&&!run.session_id)return '正在启动客户端'
  const last=run.parts?.at(-1)
  if(last?.type==='tool'&&last.state==='running')return '正在调用工具'
  if(last?.type==='reasoning'&&last.text)return '正在思考'
  if(last?.type==='text'&&last.text)return '正在回复'
  return run.session_id?'正在处理':'等待客户端响应'
}
function RunActivity({run}:{run:LoopRun}){
  const live=OPEN.has(run.status),parts=(run.parts??[]).filter(part=>part.type==='tool'||!!part.text)
  const [open,setOpen]=useState(live),[touched,setTouched]=useState(false)
  useEffect(()=>{if(!touched)setOpen(live)},[live,touched])
  const tools=parts.filter(part=>part.type==='tool'),completed=tools.filter(part=>part.state==='completed').length
  return <ChainOfThought className="room-run-activity" open={open} onOpenChange={value=>{setTouched(true);setOpen(value)}}>
    <ChainOfThoughtHeader><span>{live?runLabel(run):'执行过程'}</span><small>{tools.length?`${completed}/${tools.length} 项工具调用`:live?'执行中':'已结束'}</small>{live?<LoaderCircle className="room-spinner"/>:null}</ChainOfThoughtHeader>
    <ChainOfThoughtContent>{parts.map(part=>{
      if(part.type==='text')return <MessageResponse key={part.id} className="room-markdown" components={markdownComponents} isAnimating={live}>{part.text}</MessageResponse>
      if(part.type==='reasoning')return <MessageResponse key={part.id} className="room-markdown team-reasoning-summary" aria-label="思考摘要" components={markdownComponents} isAnimating={live}>{part.text}</MessageResponse>
      return <ChainOfThoughtStep key={part.id} icon={part.label?.startsWith('Command')?Terminal:Wrench} status={part.state==='running'&&live?'active':'complete'}><Tool><ToolHeader title={part.label??'工具调用'} state={live?part.state:part.state==='running'?'interrupted':part.state}/><ToolContent><ToolInput input={part.input}/><ToolOutput output={part.output}/>{part.truncated?<small>内容较长，仅展示末段。</small>:null}</ToolContent></Tool></ChainOfThoughtStep>
    })}{!parts.length&&live?<p className="team-run-empty">{runLabel(run)}</p>:null}{run.error_code?<p className="room-error" role="status">{run.error_code}</p>:null}</ChainOfThoughtContent>
  </ChainOfThought>
}
export function RoomMessages({room,task,onInspect}:{room:LoopRoomDetail;task?:LoopTaskDetail;onInspect:(member:LoopMember)=>void}){
  const name=(id:string)=>id==='user'?'你':room.members.find(member=>member.id===id)?.name??room.messages.find(message=>message.author===id&&message.author_snapshot)?.author_snapshot?.name??task?.runs.find(run=>run.member_id===id)?.member_snapshot?.name??'已移除成员'
  const entries=[...room.messages.map(message=>({id:message.id,time:message.created_at,message,run:null as LoopRun|null})),...(task?.runs.filter(run=>run.parts?.length||OPEN.has(run.status)).map(run=>({id:run.id,time:run.created_at,message:null,run}))??[])].sort((a,b)=>a.time.localeCompare(b.time))
  return <>{entries.map(entry=>{
    const message=entry.message,run=entry.run,author=message?.author??run!.member_id,isUser=author==='user',member:LoopMember|undefined|null=room.members.find(value=>value.id===author)??message?.author_snapshot??run?.member_snapshot
    const action=!isUser&&message?.intent?ACTION_LABEL[message.intent]:null
    return <Message from={isUser?'user':'assistant'} role="article" className="room-message" id={`message-${entry.id}`} key={entry.id} data-author={isUser?'user':'agent'}><div className="room-message__avatar">{isUser?'你':<AgentAvatar id={author} name={member?.name??name(author)} avatar={member?.avatar}/>}</div><MessageContent className="team-message-content"><header><strong>{member?.name??name(author)}</strong>{member?<span>{member.runtime_id==='claude'?'Claude Code':'Codex'}</span>:null}{author===room.config?.leader_id?<span className="room-leader-tag">Leader</span>:null}{action?<Badge variant="outline" className="team-message-intent">{action.badge}</Badge>:null}<time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></header>{message?<><MentionMessage text={message.text} recipientLabel={action?.recipient} recipients={[...new Set(message.mentions??[])].map(id=>({id,name:name(id),available:room.members.some(member=>member.id===id)}))} onInspect={id=>{const member=room.members.find(member=>member.id===id);if(member)onInspect(member)}}/>{message.attachments?.length?<Attachments>{message.attachments.map((attachment,index)=><Attachment key={attachment.path}><a href={`/api/v1/teams/${room.id}/attachments/${message.id}/${index}`} target="_blank" rel="noreferrer">{attachment.media_type.startsWith('image/')?<img loading="lazy" alt={attachment.name} src={`/api/v1/teams/${room.id}/attachments/${message.id}/${index}`}/>:null}<AttachmentInfo name={attachment.name} path={attachment.path} mediaType={attachment.media_type}/></a></Attachment>)}</Attachments>:null}</>:<RunActivity run={run!}/>}</MessageContent></Message>
  })}</>
}
