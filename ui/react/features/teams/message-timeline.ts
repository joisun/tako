import type {LoopMessage,LoopPart,LoopRoomDetail,LoopRun,LoopTaskDetail,LoopSubmission} from '@/lib/api/loop-types'
export const OPEN_RUNS=new Set(['queued','starting','running','stopping','unknown'])
export function isPartStreaming(run:LoopRun,part:LoopPart){
  const latest=run.parts?.filter(part=>part.type!=='usage').at(-1)
  return (run.status==='running'||run.status==='starting')&&part.state==='running'&&latest?.id===part.id&&latest.type===part.type
}
export type TeamTimelineEvent={id:string;at:string;author:string;run:LoopRun|null;recipients?:string[]} & (
  {kind:'message';message:LoopMessage}|{kind:'part';part:LoopPart}|{kind:'result';submission:LoopSubmission}|{kind:'status'}|{kind:'error'}
)
export function activitySections(events:TeamTimelineEvent[]){
  const sections:TeamTimelineEvent[][]=[]
  const isActivity=(event:TeamTimelineEvent)=>event.kind==='part'&&(event.part.type==='reasoning'||event.part.type==='tool'||event.part.origin==='hook')
  for(const event of events){
    const section=sections.at(-1),previous=section?.at(-1)
    if(previous&&isActivity(event)&&isActivity(previous)&&event.run&&event.run.id===previous.run?.id&&event.author===previous.author&&(event.kind!=='part'||previous.kind!=='part'||(event.part.origin==='hook')===(previous.part.origin==='hook')))section!.push(event)
    else sections.push([event])
  }
  return sections
}
export interface TeamTimelineGroup {id:string;author:string;run:LoopRun|null;events:TeamTimelineEvent[]}
function loopReceipt(part:LoopPart){
  if(part.type!=='tool'||part.state!=='completed')return null
  const name=part.label?.match(/^(?:(?:undercontrol|rillo)_loop\s*·\s*|mcp__(?:undercontrol|rillo)_loop__)(send_message|submit_result)$/)?.[1]
  if(!name||!part.output)return null
  try{
    const value:unknown=JSON.parse(part.output)
    if(!value||typeof value!=='object'||'isError' in value&&value.isError===true)return null
    let receipt:unknown=value
    if('content' in value&&Array.isArray(value.content)){
      const text=value.content.find(item=>item&&item.type==='text'&&typeof item.text==='string')?.text
      if(!text)return null
      receipt=JSON.parse(text)
    }
    if(!receipt||typeof receipt!=='object'||!('accepted' in receipt)||receipt.accepted!==true)return null
    return {name,reused:'reused' in receipt&&receipt.reused===true,messageId:'message_id' in receipt&&typeof receipt.message_id==='string'?receipt.message_id:null,runId:'run_id' in receipt&&typeof receipt.run_id==='string'?receipt.run_id:null}
  }catch{return null}
}
function resultRecipients(run:LoopRun,task:LoopTaskDetail|undefined){
  const leader=task?.config?.leader
  if(task?.config?.workflow!=='conversation'||!leader)return []
  if(task.inbox)return [...new Set(task.inbox.filter(item=>item.source_run_id===run.id&&item.kind==='reply').map(item=>item.member_id))].filter(id=>id!==run.member_id)
  const parent=task.runs.find(value=>value.id===run.routing?.parent_run_id)
  return run.routing?.reply_expected&&parent&&parent.member_id!==run.member_id?[parent.member_id]:[]
}
export function messageTimeline(room:LoopRoomDetail,task?:LoopTaskDetail){
  const runs=new Map(task?.runs.map(run=>[run.id,run])??[])
  const hidden=new Set<LoopPart>(),suppressedMessages=new Set<string>(),reportParts=new Map<LoopPart,string[]>(),reportMessages=new Map<string,string[]>(),reports:TeamTimelineEvent[]=[]
  for(const run of task?.runs??[]){
    const parts=run.parts??[],recipients=resultRecipients(run,task),submission=run.submission??run.result?.submission
    let submitted=-1
    for(const [index,part]of parts.entries()){
      const receipt=loopReceipt(part)
      if(receipt?.name==='send_message'&&(receipt.reused||room.messages.some(message=>message.id===receipt.messageId&&message.run_id===run.id)))hidden.add(part)
      if(receipt?.name==='submit_result'&&receipt.runId===run.id&&submission){hidden.add(part);if(submitted<0)submitted=index}
    }
    if(!submission&&run.status==='succeeded'){
      const formal=parts.filter(part=>part.type==='text'&&part.phase==='final_answer'&&part.origin!=='hook'&&part.text).at(-1)
      if(formal)reportParts.set(formal,recipients)
    }
    if(!submission||submitted<0)continue
    const following=parts.slice(submitted+1).filter(part=>part.type==='text'&&part.text&&part.origin!=='hook')
    const formal=following.find(part=>part.phase==='final_answer')??following.find(part=>!part.phase)
    if(formal)reportParts.set(formal,recipients)
    const fallback=room.messages.filter(message=>message.run_id===run.id&&!message.intent&&!message.mentions?.length&&message.text===submission.summary)
    for(const message of fallback){if(formal)suppressedMessages.add(message.id);else reportMessages.set(message.id,recipients)}
    const hasPublicReply=room.messages.some(message=>message.run_id===run.id&&(message.intent==='reply'||message.intent==='announce'))
    const at=run.finished_at
    // A submission is control data until the Run exits; it must not become a
    // temporary chat message that disappears when native answer text arrives.
    if(!OPEN_RUNS.has(run.status)&&!formal&&!fallback.length&&!hasPublicReply&&at&&Number.isFinite(Date.parse(at)))reports.push({id:'result:'+run.id,at,author:run.member_id,run,kind:'result',submission,recipients})
  }
  const events:TeamTimelineEvent[]=room.messages.filter(message=>!suppressedMessages.has(message.id)).map(message=>({id:message.id,at:message.created_at,author:message.author,run:runs.get(message.run_id??'')??null,kind:'message',message,recipients:reportMessages.get(message.id)}))
  events.push(...reports)
  const untimed:LoopRun[]=[]
  for(const run of task?.runs??[]){
    const visible=(run.parts??[]).filter(part=>!hidden.has(part)&&(part.type==='tool'||!!part.text||(part.type==='reasoning'&&isPartStreaming(run,part))))
    const timed=visible.filter(part=>Number.isFinite(Date.parse(part.created_at??'')))
    for(const part of timed)events.push({id:run.id+':'+part.id,at:part.created_at!,author:run.member_id,run,kind:'part',part,recipients:reportParts.get(part)})
    const missing=visible.filter(part=>!Number.isFinite(Date.parse(part.created_at??'')))
    if(missing.length)untimed.push({...run,parts:missing})
    if(run.error_code&&run.finished_at)events.push({id:run.id+':error',at:run.finished_at,author:run.member_id,run,kind:'error'})
  }
  events.sort((a,b)=>a.at.localeCompare(b.at)||(a.run?.id&&a.run.id===b.run?.id&&a.kind==='part'&&b.kind==='part'?(a.part.sequence??0)-(b.part.sequence??0):0))
  const groups:TeamTimelineGroup[]=[]
  for(const event of events){
    const previous=groups.at(-1)
    if(previous&&event.author!=='user'&&previous.author===event.author&&event.run&&previous.run?.id===event.run.id)previous.events.push(event)
    else groups.push({id:event.id,author:event.author,run:event.run,events:[event]})
  }
  return {groups,untimed}
}
