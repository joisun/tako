import {useState,type ComponentProps,type ReactNode} from 'react'
import {Gauge,LoaderCircle,ListChecks,Terminal,FileText,Wrench,CircleSlash} from 'lucide-react'
import {Message,MessageAvatar,MessageHeader,MessageContent} from '@/components/ui/message'
import {Bubble,BubbleContent} from '@/components/ui/bubble'
import {MarkdownCodeBlock} from '@/components/ui/code-block'
import {MessageScrollerItem} from '@/components/ui/message-scroller'
import {MessageResponse} from '@/components/ai-elements/message'
import {ChainOfThought,ChainOfThoughtHeader,ChainOfThoughtContent} from '@/components/ai-elements/chain-of-thought'
import {Tool,ToolHeader,ToolContent,ToolInput,ToolOutput} from '@/components/ai-elements/tool'
import {Attachments,Attachment,AttachmentInfo} from '@/components/ai-elements/attachments'
import {InlineCitationLink} from '@/components/ai-elements/inline-citation'
import {Popover,PopoverTrigger,PopoverContent} from '@/components/ui/popover'
import {AgentAvatar} from '@/components/agents/agent-avatar'
import {MentionMessage} from './message-mentions'
import {messageTimeline,activitySections,OPEN_RUNS,isPartStreaming,type TeamTimelineEvent} from './message-timeline'
import type {LoopMember,LoopPart,LoopRoomDetail,LoopTaskDetail,LoopRun} from '@/lib/api/loop-types'
const markdownComponents={pre:MarkdownCodeBlock,a:({href,children}:ComponentProps<'a'>)=><InlineCitationLink href={href??''}>{children}</InlineCitationLink>}
function runLabel(run:LoopRun){
  if(run.status==='queued')return run.timing?.waiting_for_resources?'已安排，等待目录可用':'已安排，等待执行'
  if(run.status==='unknown')return '执行状态待核对'
  if(run.status==='stopping')return '正在停止'
  if(run.status==='starting'&&!run.session_id)return '正在启动客户端'
  const last=run.parts?.filter(part=>part.type!=='usage').at(-1)
  if(last?.type==='tool'&&last.state==='running')return '正在调用工具'
  if(last?.type==='reasoning'&&isPartStreaming(run,last))return '正在思考'
  if(last?.type==='text'&&isPartStreaming(run,last))return '正在回复'
  return run.session_id?'正在处理':'等待客户端响应'
}
function toolTitle(part:LoopPart){
  if(part.files?.length)return `文件变更 · ${part.files.length} 个文件`
  const action=part.label?.match(/^(?:(?:tako|undercontrol|rillo)_loop\s*·\s*|mcp__(?:tako|undercontrol|rillo)_loop__)(\w+)$/)?.[1]
  if(action==='read_context'){
    try{if(JSON.parse(part.input??'{}').section==='messages')return '读取团队消息'}catch{/* The original input remains readable in the tool detail. */}
    return '读取团队上下文'
  }
  const titles:Record<string,string>={remember:'保存共享记忆',report_progress:'更新协作进度',request_action:'调整协作安排',send_message:'发送团队消息',submit_result:'提交工作汇报'}
  if(action==='request_action'){
    try{const input=JSON.parse(part.input??'{}');return ({prepare_projects:'准备项目目录',deliver:'交付当前成果',wait:'等待补充信息',cancel_assignment:'取消待执行指派'} as Record<string,string>)[input.action]??titles.request_action}catch{/* Keep the original protocol detail available. */}
  }
  return (action&&titles[action])||part.label?.replace(/^Command\s*·\s*/, '').replace(/^\/[^ ]*\/(?:ba|z)?sh\s+-[a-z]+\s+/, '')||'工具调用'
}
function toolState(part:LoopPart,run:LoopRun){
  let state=OPEN_RUNS.has(run.status)?part.state:part.state==='running'?'interrupted':part.state
  if(run.status==='unknown'&&state==='running')state='unknown'
  try{if(state==='completed'&&JSON.parse(part.output??'null')?.isError===true)state='failed'}catch{/* Non-JSON tool output keeps its native status. */}
  return state
}
function RunActivity({events,children}:{events:TeamTimelineEvent[];children:ReactNode}){
  const automatic=events.every(event=>event.kind==='part'&&event.part.origin==='hook'&&(event.part.type!=='reasoning'||!isPartStreaming(event.run!,event.part)))
  const [open,setOpen]=useState(false)
  return <div className="team-activity">{automatic?<ChainOfThought className="team-automatic-activity" open={open} onOpenChange={setOpen}><ChainOfThoughtHeader icon={ListChecks}>客户端自动续轮</ChainOfThoughtHeader><ChainOfThoughtContent>{children}</ChainOfThoughtContent></ChainOfThought>:children}</div>
}
function thinkingSummary(text:string){
  return text.split('\n').find(line=>line.trim())?.replace(/^\s*#{1,6}\s+|\*\*/g,'').trim()||'正在思考…'
}
function RunPart({part,run}:{part:LoopPart;run:LoopRun}){
  if(part.type==='usage')return null
  if(part.type==='text')return <MessageResponse className="room-markdown" components={markdownComponents} isAnimating={isPartStreaming(run,part)}>{part.text}</MessageResponse>
  if(part.type==='reasoning')return isPartStreaming(run,part)?<p className="team-thinking" role="status"><span className="shimmer" title={thinkingSummary(part.text)}>{thinkingSummary(part.text)}</span></p>:null
  return <ToolPart part={part} run={run}/>
}
function ToolPart({part,run}:{part:LoopPart;run:LoopRun}){
  const [open,setOpen]=useState(false)
  const state=toolState(part,run)
  return <Tool open={open} onOpenChange={setOpen}><ToolHeader title={toolTitle(part)} state={state} icon={part.files?.length?FileText:/^Command(?:\s*·|$)/.test(part.label??'')?Terminal:Wrench}/><ToolContent><small>{part.label}</small>{part.files?.length?<ul className="team-file-changes">{part.files.map(file=><li key={file.path}><span>{{add:'新增',update:'修改',delete:'删除'}[file.kind]}</span><code>{file.path}</code></li>)}</ul>:null}<ToolInput input={part.input}/><ToolOutput output={part.output}/>{part.truncated?<small>内容较长，当前展示部分记录。</small>:null}</ToolContent></Tool>
}
function duration(value:number|null){return value==null?'未记录':`${(value/1000).toLocaleString('zh-CN',{maximumFractionDigits:1})} 秒`}
function RunUsage({run}:{run:LoopRun}){
  const usage=run.parts?.find(part=>part.type==='usage')?.usage??run.result?.usage
  if((!usage?.total||!usage.last)&&!run.timing)return null
  const count=(value:number|undefined)=>value==null?'—':value.toLocaleString('zh-CN')
  return <Popover><PopoverTrigger className="team-usage-trigger" aria-label="查看用量" title="查看用量"><Gauge/></PopoverTrigger><PopoverContent className="team-usage-detail"><strong>执行与用量</strong><dl>{run.timing?<><dt>排队时间</dt><dd>{duration(run.timing.queued_ms)}</dd><dt>等待目录</dt><dd>{duration(run.timing.resource_wait_ms)}</dd><dt>客户端准备</dt><dd>{duration(run.timing.startup_ms??null)}</dd><dt>等待首次模型输出</dt><dd>{duration(run.timing.model_wait_ms)}</dd><dt>处理时间</dt><dd>{duration(run.timing.processing_ms)}</dd></>:null}<dt>累计 Token</dt><dd>{count(usage?.total.totalTokens)}</dd><dt>输入 / 输出</dt><dd>{count(usage?.total.inputTokens)} / {count(usage?.total.outputTokens)}</dd><dt>缓存输入</dt><dd>{count(usage?.total.cachedInputTokens)}</dd><dt>最近一次上下文</dt><dd>{count(usage?.last.totalTokens)}{usage?.modelContextWindow?` / ${count(usage?.modelContextWindow)}`:''}</dd></dl></PopoverContent></Popover>
}
function UntimedRun({run}:{run:LoopRun}){
  const [open,setOpen]=useState(false)
  return <ChainOfThought className="room-run-activity" open={open} onOpenChange={setOpen}><ChainOfThoughtHeader>历史执行详情 · 时间未记录</ChainOfThoughtHeader><ChainOfThoughtContent>{run.parts?.map(part=><RunPart key={part.id} part={part} run={run}/>)}</ChainOfThoughtContent></ChainOfThought>
}
export function RoomMessages({room,task,onInspect}:{room:LoopRoomDetail;task?:LoopTaskDetail;onInspect:(member:LoopMember)=>void}){
  const memberFor=(id:string)=>room.members.find(member=>member.id===id)??room.messages.find(message=>message.author===id&&message.author_snapshot)?.author_snapshot??task?.runs.find(run=>run.member_id===id&&run.member_snapshot)?.member_snapshot
  const name=(id:string)=>id==='user'?'你':memberFor(id)?.name??'已移除成员'
  const recipientsFor=(ids:string[])=>[...new Set(ids)].map(id=>({id,name:name(id),available:room.members.some(member=>member.id===id)}))
  const inspect=(id:string)=>{const member=room.members.find(value=>value.id===id);if(member)onInspect(member)}
  const timeline=messageTimeline(room,task)
  const groups=timeline.groups.map(group=>({...group,events:group.events.filter(event=>event.kind!=='part'||event.part.type!=='reasoning'||isPartStreaming(event.run!,event.part))})).filter(group=>group.events.length)
  const untimed=timeline.untimed.map(run=>({...run,parts:run.parts?.filter(part=>part.type!=='reasoning'||isPartStreaming(run,part))})).filter(run=>run.parts?.length)
  const lastGroup=new Map(groups.filter(group=>group.run).map(group=>[group.run!.id,group.id]))
  const pendingRuns=(task?.runs??[]).filter(run=>['queued','starting','running'].includes(run.status)&&!(run.parts??[]).some(part=>part.type!=='usage'&&(part.type==='tool'||part.type==='reasoning'||!!part.text)))
  return <>{groups.map(group=>{
    const isUser=group.author==='user',member=memberFor(group.author),time=group.events[0].at
    const renderEvent=(event:TeamTimelineEvent)=>{
        const index=group.events.indexOf(event)
        const previous=group.events[index-1]
        const continuedReport=event.kind==='part'&&event.part.type==='text'&&!!event.recipients?.length&&previous?.kind==='part'&&previous.part.type==='text'&&event.recipients.length===previous.recipients?.length&&event.recipients.every(id=>previous.recipients!.includes(id))
        return <div key={event.id} id={`message-${event.id}`} className="team-timeline-event" data-event-kind={event.kind} data-event-at={event.at} data-event-id={event.id}>
        {event.kind==='error'?<p className="team-run-outcome" data-status={event.run?.status} role="status" title={event.run?.error_code??undefined}><CircleSlash/>{event.run?.status==='canceled'?'执行已取消':event.run?.status==='timed_out'?'执行超时':event.run?.status==='unknown'?'执行状态待核对':'执行未完成，请查看执行详情'}</p>:event.kind==='part'?(event.part.type==='text'&&event.recipients?.length?<MentionMessage text={event.part.text} recipients={recipientsFor(event.recipients)} onInspect={inspect} prependRecipients={!continuedReport}/>:<RunPart part={event.part} run={event.run!}/>):event.kind==='status'?<p className="room-run-presence" role="status"><LoaderCircle className="room-spinner"/>{runLabel(event.run!)}</p>:event.kind==='result'?<MentionMessage text={event.submission.summary} recipients={recipientsFor(event.recipients??[])} onInspect={inspect}/>:<>
          <MentionMessage text={event.message.text} recipients={recipientsFor(event.recipients??event.message.mentions??[])} onInspect={inspect}/>
          {event.message.attachments?.length?<Attachments>{event.message.attachments.map((attachment,index)=><Attachment key={attachment.path}><a href={`/api/v1/teams/${room.id}/attachments/${event.message.id}/${index}`} target="_blank" rel="noreferrer">{attachment.media_type.startsWith('image/')?<img loading="lazy" alt={attachment.name} src={`/api/v1/teams/${room.id}/attachments/${event.message.id}/${index}`}/>:null}<AttachmentInfo name={attachment.name} path={attachment.path} mediaType={attachment.media_type}/></a></Attachment>)}</Attachments>:null}
        </>}
      </div>}
    return <MessageScrollerItem key={group.id} messageId={group.id} scrollAnchor={isUser}><Message align={isUser?'end':'start'} role="article" className="room-message" data-author={isUser?'user':'agent'} data-run-id={group.run?.id}>{!isUser?<MessageAvatar className="room-message__avatar"><AgentAvatar id={group.author} name={name(group.author)} avatar={member?.avatar}/></MessageAvatar>:null}<MessageContent className="team-message-content"><MessageHeader className="team-message-header">{!isUser?<strong>{name(group.author)}</strong>:null}{member?<span>{member.runtime_id==='claude'?'Claude Code':'Codex'}</span>:null}{group.author===room.config?.leader_id?<span className="room-leader-tag">Leader</span>:null}{group.run&&OPEN_RUNS.has(group.run.status)&&lastGroup.get(group.run.id)===group.id&&runLabel(group.run)!=='正在思考'?<span role="status">{runLabel(group.run)}</span>:null}<time dateTime={time}>{new Date(time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>{group.run&&lastGroup.get(group.run.id)===group.id?<RunUsage run={group.run}/>:null}</MessageHeader><Bubble variant={isUser?'muted':'ghost'}><BubbleContent>
      {activitySections(group.events).map(events=>events.every(event=>event.kind==='part'&&(event.part.type==='reasoning'||event.part.type==='tool'||event.part.origin==='hook'))?<RunActivity key={events[0].id} events={events}>{events.map(renderEvent)}</RunActivity>:events.map(renderEvent))}
    </BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem>
  })}{untimed.length?<section className="team-untimed-history" aria-label="时间缺失的历史动作"><p>以下历史动作未记录时间，无法确定它们与其他成员消息的先后。</p>{untimed.map(run=><div key={run.id}><strong>{name(run.member_id)}</strong><UntimedRun run={run}/></div>)}</section>:null}{pendingRuns.map(run=><MessageScrollerItem key={`presence:${run.id}`} messageId={`presence:${run.id}`}><Message align="start" role="article" className="room-message" data-author="agent" data-run-id={run.id} data-run-presence><MessageAvatar className="room-message__avatar"><AgentAvatar id={run.member_id} name={name(run.member_id)} avatar={memberFor(run.member_id)?.avatar}/></MessageAvatar><MessageContent className="team-message-content"><MessageHeader className="team-message-header"><strong>{name(run.member_id)}</strong><span>{memberFor(run.member_id)?.runtime_id==='claude'?'Claude Code':'Codex'}</span>{run.member_id===room.config?.leader_id?<span className="room-leader-tag">Leader</span>:null}</MessageHeader><p className="room-run-presence" role="status"><LoaderCircle className="room-spinner"/>{run.status==='running'&&run.session_id?'等待模型响应':runLabel(run)}</p></MessageContent></Message></MessageScrollerItem>)}</>
}
