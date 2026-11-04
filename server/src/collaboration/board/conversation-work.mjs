const parse = value => JSON.parse(value ?? '{}')
const CLOSED = new Set(['answered', 'completed', 'canceled'])
const ACTIVE = new Set(['starting', 'running', 'stopping', 'unknown'])

export function conversationWork(db, roomId) {
  const tasks = db.prepare("SELECT rowid AS number,* FROM loop_tasks WHERE room_id=? AND json_extract(config_json,'$.workflow')='conversation' ORDER BY rowid").all(roomId).map(row => ({...row, config:parse(row.config_json)}))
  if (!tasks.length) return []
  const runs = db.prepare('SELECT r.* FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE t.room_id=? ORDER BY r.rowid').all(roomId).map(row => ({...row, routing:parse(row.routing_json)}))
  const inbox = db.prepare('SELECT i.rowid AS number,i.* FROM loop_inbox i JOIN loop_tasks t ON t.id=i.task_id WHERE t.room_id=? ORDER BY i.rowid').all(roomId).map(row => ({...row, payload:parse(row.payload_json), processing:parse(row.processing_json), delivery:parse(row.delivery_json)}))
  const byInbox = new Map(inbox.map(row => [row.id,row]))
  const byRun = new Map(runs.map(row => [row.id,row]))
  const names = new Map(db.prepare('SELECT id,name FROM loop_members WHERE room_id=?').all(roomId).map(row=>[row.id,row.name]))
  for (const run of runs) if (!names.has(run.member_id) && run.member_snapshot_json) names.set(run.member_id,parse(run.member_snapshot_json).name)
  const resourceWaits = new Set(db.prepare("SELECT DISTINCT e.run_id FROM loop_events e JOIN loop_tasks t ON t.id=e.task_id WHERE t.room_id=? AND e.kind='resource_waiting'").all(roomId).map(row=>row.run_id))
  const messages = db.prepare('SELECT id,task_id,author FROM loop_messages WHERE room_id=? ORDER BY sequence').all(roomId)
  const reportRows = db.prepare("SELECT payload_json,created_at FROM loop_events WHERE sequence IN (SELECT max(e.sequence) FROM loop_events e JOIN loop_tasks t ON t.id=e.task_id WHERE t.room_id=? AND e.kind='report_recorded' GROUP BY json_extract(e.payload_json,'$.id')) ORDER BY sequence").all(roomId)
  const reports = reportRows.map(row => ({...parse(row.payload_json),created_at:row.created_at}))
  const byReport = new Map(reports.map(report => [report.assignment_id ?? report.id,report]))
  const assignmentId = run => {
    const linked = byInbox.get(run.routing.assignment_id)
    return linked?.member_id === run.member_id ? linked.id : run.routing.inbox_id
  }
  const workRuns = new Map()
  for (const run of runs) {
    const id=assignmentId(run)
    if (!workRuns.has(id)) workRuns.set(id,[])
    workRuns.get(id).push(run)
  }
  function questions(taskId, workId=null) {
    return inbox.filter(row => row.task_id===taskId && row.payload.message_kind==='ask' && (!workId || byRun.get(row.source_run_id) && assignmentId(byRun.get(row.source_run_id))===workId))
      .map(row => ({message_id:row.message_id,member_id:row.member_id,text:row.payload.assignment,state:row.processing.state,delivery:row.delivery.state}))
  }
  function card(task, row=null) {
    const linked = row ? workRuns.get(row.id) ?? [] : runs.filter(run=>run.task_id===task.id)
    const latest = linked.findLast(run=>ACTIVE.has(run.status)) ?? linked.at(-1)
    const report = row ? byReport.get(row.id) : reports.findLast(value=>value.task_id===task.id && value.member_id===task.config.leader)
    const waiting = questions(task.id,row?.id).filter(value=>!CLOSED.has(value.state))
    const dependencies = (row?.payload.depends_on ?? []).map(id=>({run_id:id,status:byRun.get(id)?.status ?? 'missing'}))
    const processing = row?.processing.state
    const state = workState({task,row,latest,report,processing,waiting,dependencies,resourceWaiting:resourceWaits.has(latest?.id)})
    const column = ['reported','review_failed'].includes(state) ? 'review' : state==='accepted' ? 'done' : ['starting','running','stopping','unknown'].includes(state) ? 'working' : 'backlog'
    const sourceMessage = row?.message_id ?? messages.find(value=>value.task_id===task.id && value.author==='user')?.id ?? null
    const owner = row?.member_id ?? task.config.leader
    const latestReport = report ? {id:report.id,version:report.version,run_id:report.run_id,verdict:report.submission?.verdict ?? null,excerpt:report.content.slice(0,1200),truncated:report.content.length>1200,artifacts:report.submission?.artifacts ?? []} : null
    return {
      id:row ? `assignment-${row.id}` : `task-${task.id}`,room_id:roomId,number:row?.number ?? task.number,
      name:row ? (row.payload.expected_output || row.payload.assignment || '协作工作').split('\n')[0].slice(0,160) : task.title,
      column,owner_id:owner,type:row?.payload.message_kind==='verify' ? 'review' : 'task',
      details:row?.payload.assignment ?? task.goal,position:row?.number ?? task.number,
      created_at:row?.created_at ?? task.created_at,updated_at:latest?.finished_at ?? report?.created_at ?? task.updated_at,
      tracking:{kind:row?'assignment':'task',task_id:task.id,task_title:task.title,assignment_id:row?.id ?? null,source_message_id:sourceMessage,
        requester_id:row ? byRun.get(row.source_run_id)?.member_id ?? null : null,
        state,task_status:task.status,processing_state:processing ?? null,run_ids:linked.map(value=>value.id),run_status:latest?.status ?? null,
        owner_name:names.get(owner) ?? '已移除成员',
        expected_output:row?.payload.expected_output ?? null,acceptance:row?.payload.acceptance ?? task.acceptance,
        dependencies,questions:questions(task.id,row?.id),report:latestReport,error_code:latest?.error_code ?? null},
    }
  }
  return tasks.flatMap(task => [card(task),...inbox.filter(row=>row.task_id===task.id && ['delegate','verify'].includes(row.payload.message_kind)).map(row=>card(task,row))])
}

function workState({task,row,latest,report,processing,waiting,dependencies,resourceWaiting}) {
  if (!row) {
    if (task.status==='completed') return 'accepted'
    if (task.status==='review') return 'reported'
    if (task.status==='waiting') return 'waiting_user'
    if (['paused','failed','canceled'].includes(task.status)) return task.status
    return latest && (ACTIVE.has(latest.status) || latest.status==='queued') ? latest.status : 'pending'
  }
  if (processing==='canceled') return 'canceled'
  if (latest && ACTIVE.has(latest.status)) return latest.status
  if (task.status==='paused' && latest?.status==='canceled') return 'paused'
  if (latest && ['failed','interrupted','canceled'].includes(latest.status)) return latest.status
  if (report?.submission?.verdict==='fail') return 'review_failed'
  if (task.status==='completed' && CLOSED.has(processing)) return 'accepted'
  if (report && CLOSED.has(processing)) return 'reported'
  if (task.status==='canceled') return 'canceled'
  if (task.status==='paused') return 'paused'
  if (task.status==='waiting') return 'waiting_user'
  if (task.status==='failed') return 'failed'
  if (waiting.length) return 'waiting_answer'
  if (dependencies.some(value=>['failed','canceled','interrupted','missing'].includes(value.status))) return 'dependency_failed'
  if (dependencies.some(value=>value.status!=='succeeded')) return 'blocked'
  if (latest?.status!=='queued') return 'pending'
  return resourceWaiting ? 'waiting_resources' : 'queued'
}
