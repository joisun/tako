import { loopError } from '../errors.mjs'

const parse=value=>JSON.parse(value??'{}')
const closed=new Set(['answered','completed','canceled'])

export function createTeamCommunication({db,clock}) {
  const now=()=>new Date(clock()).toISOString()
  const task=id=>{const row=db.prepare('SELECT * FROM loop_tasks WHERE id=?').get(id);return{...row,config:parse(row.config_json)}}
  function rows(taskId,memberId=null){
    return db.prepare('SELECT * FROM loop_inbox WHERE task_id=? AND (? IS NULL OR member_id=?) ORDER BY rowid').all(taskId,memberId,memberId)
      .map(row=>({...row,payload:parse(row.payload_json),delivery:parse(row.delivery_json),processing:parse(row.processing_json)}))
  }
  function validateLinks(candidate,input) {
    if(input.resource_scope!=null){
      const scope=input.resource_scope,current=task(candidate.task_id)
      if(!['none','read','write'].includes(scope.access)||!Array.isArray(scope.projects)||scope.projects.length>8||scope.projects.some(value=>!Number.isSafeInteger(value)||value<1||value>(current.config.resources?.length??0)))throw loopError('LOOP_INPUT_INVALID','资源范围须引用当前任务已准备的项目编号')
    }
    const answered=input.answered_message_ids??[]
    if(!Array.isArray(answered)||answered.length>32||answered.some(id=>typeof id!=='string'||!id||id.length>128))throw loopError('LOOP_INPUT_INVALID','回答消息标识无效')
    for(const id of [...answered,...(input.reply_to_message_id?[input.reply_to_message_id]:[])]){
      if(!db.prepare('SELECT id FROM loop_messages WHERE id=? AND task_id=?').get(id,candidate.task_id))throw loopError('LOOP_MESSAGE_MISMATCH','关联消息不属于当前任务',409)
    }
    if(input.assignment_id&&!db.prepare('SELECT id FROM loop_inbox WHERE id=? AND task_id=?').get(input.assignment_id,candidate.task_id))throw loopError('LOOP_TASK_MISMATCH','关联工作不属于当前任务',409)
    return [...new Set(answered)]
  }
  function cancelQueued(inboxId) {
    const queued=db.prepare("SELECT id FROM loop_runs WHERE status='queued' AND json_extract(routing_json,'$.inbox_id')=?").all(inboxId)
    for(const row of queued){
      db.prepare("UPDATE loop_runs SET status='canceled',error_code='LOOP_INPUT_ALREADY_HANDLED',finished_at=? WHERE id=? AND status='queued'").run(now(),row.id)
      db.prepare("UPDATE loop_outbox SET state='done' WHERE run_id=?").run(row.id)
    }
  }
  function resolve(candidate,input,{messageId=null,reportId=null,reportVersion=null}={}) {
    const current=task(candidate.task_id),ids=validateLinks(candidate,input)
    if(input.reply_to_message_id)ids.push(input.reply_to_message_id)
    const targets=rows(current.id).filter(row=>ids.includes(row.message_id)||input.assignment_id===row.id&&!input.reply_to_message_id)
    const resolved=[]
    for(const row of targets){
      if(closed.has(row.processing.state))continue
      const kind=row.payload.message_kind
      if(!['ask','delegate','verify'].includes(kind))continue
      if(row.member_id!==candidate.member_id&&candidate.member_id!==current.config.leader)continue
      const state=kind==='ask'?'answered':'completed'
      db.prepare('UPDATE loop_inbox SET processing_json=? WHERE id=?').run(JSON.stringify({state,run_id:candidate.id,message_id:messageId,report_id:reportId,report_version:reportVersion,at:now()}),row.id)
      cancelQueued(row.id);resolved.push(row.id)
    }
    return resolved
  }
  function stampDelivery(inboxIds,runId,state,extra={}) {
    const candidate=db.prepare('SELECT * FROM loop_runs WHERE id=?').get(runId)
    if(!candidate)return []
    const updated=[]
    for(const id of inboxIds){
      const row=db.prepare('SELECT * FROM loop_inbox WHERE id=? AND task_id=? AND member_id=?').get(id,candidate.task_id,candidate.member_id)
      if(!row)continue
      const previous=parse(row.delivery_json)
      if(previous.state==='delivered')continue
      if(previous.state==='unknown'&&state==='sending')continue
      db.prepare('UPDATE loop_inbox SET delivery_json=? WHERE id=?').run(JSON.stringify({state,run_id:runId,at:now(),...extra}),id)
      if(state==='delivered'){
        db.prepare('UPDATE loop_inbox SET consumed_by=coalesce(consumed_by,?) WHERE id=?').run(runId,id)
        const processing=parse(row.processing_json),payload=parse(row.payload_json)
        if(processing.state==='pending'&&candidate.revision===task(candidate.task_id).revision&&candidate.generation===task(candidate.task_id).generation)db.prepare('UPDATE loop_inbox SET processing_json=? WHERE id=?').run(JSON.stringify({state:['announce','reply'].includes(payload.message_kind)?'completed':'in_progress',run_id:runId,at:now()}),id)
        const queued=db.prepare("SELECT id FROM loop_runs WHERE status='queued' AND json_extract(routing_json,'$.inbox_id')=? AND id!=?").all(id,runId)
        for(const duplicate of queued){db.prepare("UPDATE loop_runs SET status='canceled',error_code='LOOP_INPUT_ALREADY_DELIVERED',finished_at=? WHERE id=?").run(now(),duplicate.id);db.prepare("UPDATE loop_outbox SET state='done' WHERE run_id=?").run(duplicate.id)}
      }
      updated.push(id)
    }
    return updated
  }
  function initialDeliveryIds(candidate,messageIds,resultIds) {
    return rows(candidate.task_id,candidate.member_id).filter(row=>row.revision===candidate.revision&&row.delivery.state==='pending'&&(row.consumed_by===candidate.id||!['delegate','verify'].includes(row.payload.message_kind)&&messageIds.includes(row.message_id)||!row.message_id&&resultIds.includes(row.source_run_id))).map(row=>row.id)
  }
  function pendingForRun(candidate) {
    return rows(candidate.task_id,candidate.member_id).filter(row=>row.revision===candidate.revision&&row.delivery.state==='pending'&&!closed.has(row.processing.state)&&!['announce','delegate','verify'].includes(row.payload.message_kind)&&(row.payload.message_kind==='ask'||!row.payload.assignment_id||row.payload.assignment_id===ownedAssignment(candidate)))
  }
  function ownedAssignment(candidate) {
    const routing=candidate.routing??parse(candidate.routing_json)
    if(routing.assignment_id&&db.prepare('SELECT id FROM loop_inbox WHERE id=? AND member_id=?').get(routing.assignment_id,candidate.member_id))return routing.assignment_id
    return routing.inbox_id??null
  }
  function outgoingWork(candidate) {
    const assignmentId=ownedAssignment(candidate)
    return db.prepare("SELECT i.id,r.routing_json FROM loop_inbox i JOIN loop_messages m ON m.id=i.message_id JOIN loop_runs r ON r.id=m.run_id WHERE i.task_id=? AND i.revision=? AND m.author=? AND m.intent IN ('ask','delegate','verify') AND json_extract(i.processing_json,'$.state') NOT IN ('answered','completed','canceled')").all(candidate.task_id,candidate.revision,candidate.member_id)
      .filter(row=>ownedAssignment({member_id:candidate.member_id,routing_json:row.routing_json})===assignmentId)
  }
  function finishAssignment(candidate,reportId) {
    const id=ownedAssignment(candidate)
    if(!id)return
    const row=db.prepare('SELECT * FROM loop_inbox WHERE id=? AND member_id=?').get(id,candidate.member_id)
    if(!row||closed.has(parse(row.processing_json).state)||outgoingWork(candidate).length)return
    const payload=parse(row.payload_json)
    if(!['ask','delegate','verify'].includes(payload.message_kind))return
    db.prepare('UPDATE loop_inbox SET processing_json=? WHERE id=?').run(JSON.stringify({state:payload.message_kind==='ask'?'answered':'completed',run_id:candidate.id,report_id:reportId,at:now()}),id)
  }
  function recover(){
    for(const row of db.prepare("SELECT id,delivery_json FROM loop_inbox WHERE json_extract(delivery_json,'$.state')='sending'").all())db.prepare('UPDATE loop_inbox SET delivery_json=? WHERE id=?').run(JSON.stringify({...parse(row.delivery_json),state:'unknown',reason:'daemon_restarted'}),row.id)
  }
  return {rows,validateLinks,resolve,stampDelivery,initialDeliveryIds,pendingForRun,outgoingWork,finishAssignment,cancelQueued,recover,
    isClosed:row=>closed.has(parse(row.processing_json).state)}
}
