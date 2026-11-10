import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { loopError } from './errors.mjs'
import { createRoomMemory } from './room-memory.mjs'
import { createRoomBoard } from './board.mjs'
import { createConversationOperations } from './conversation.mjs'
import { createTeamSessionProjection } from './session-projection.mjs'
import { createCollaborationSchema } from './schema.mjs'
import { createTeamCommunication } from './store/communication.mjs'
import { executionMetrics } from './store/metrics.mjs'
import { createFormalReports } from './store/reports.mjs'

const LIVE_RUNS = new Set(['starting', 'running', 'stopping', 'unknown'])
const PROVIDERS = new Set(['codex', 'claude'])
const PHASES = ['planning', 'discussing', 'converging', 'implementing', 'verifying']
const MAX_TEXT = 20_000
const MEMORY_CONTEXT_CHARACTERS = 12_000
const MEMORY_EXCERPT_CHARACTERS = 2_000
const memorySegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function memoryKeywords(query) {
  const value=query.toLowerCase(),words=[...memorySegmenter.segment(value)].filter(part=>part.isWordLike&&part.segment.length>=2).map(part=>part.segment)
  const pairs=(value.match(/\p{Script=Han}{2,}/gu)??[]).flatMap(word=>Array.from({length:word.length-1},(_,index)=>word.slice(index,index+2)))
  const ignored=new Set(['the','and','with','from','this','that','一个','需要','完成','进行'])
  return [...new Set([...words,...pairs])].filter(word=>!ignored.has(word)).slice(0,32)
}

function text(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw loopError('LOOP_INPUT_INVALID', `${label}不能为空且不能超过${max}个字符`)
  }
  return value.trim()
}
function decode(row) {
  if (!row) return row
  const result = { ...row }
  for (const key of Object.keys(result).filter(key => key.endsWith('_json'))) {
    result[key.slice(0, -5)] = result[key] == null ? null : JSON.parse(result[key])
    delete result[key]
  }
  delete result.token_hash
  return result
}

export function createCollaborationStore({ database: db, clock = () => new Date(), createId = randomUUID }) {
  createCollaborationSchema(db)
  const now = () => new Date(clock()).toISOString()
  const get = (table, id) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
    if (!row) throw loopError('LOOP_NOT_FOUND', '团队、成员、任务或执行不存在', 404)
    return decode(row)
  }
  const memory = createRoomMemory({db,clock})
  const board = createRoomBoard({ db, clock, createId })
  const communication = createTeamCommunication({db,clock})
  const reports = createFormalReports({db,clock})
  const conversation = createConversationOperations({ db, clock, createId,communication,reports })
  const task = id => get('loop_tasks', id)
  const run = id => get('loop_runs', id)
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE')
    try { const value = operation(); db.exec('COMMIT'); return value }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function event(taskId, runId, kind, payload = {}) {
    db.prepare('INSERT INTO loop_events(task_id,run_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(taskId, runId, kind, JSON.stringify(payload), now())
  }
  function message(roomId, taskId, runId, author, value, requestKey = null) {
    db.prepare(`INSERT INTO loop_messages(id,room_id,task_id,run_id,author,text,request_key,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(createId(), roomId, taskId, runId, author, value, requestKey, now())
  }
  function createRoom(input) { return transaction(()=>insertRoom(input)) }
  function insertRoom(input) {
    const title = text(input.title, '团队名称', 120)
    const id = input.id ?? createId()
    db.prepare('INSERT INTO loop_rooms(id,title,created_at,config_json) VALUES(?,?,?,?)').run(id, title, now(), JSON.stringify({ creation_request_key:input.request_key??null, leader_id: null, workspace: input.workspace ?? input.workspaces?.[0] ?? null, workspaces: input.workspaces ?? (input.workspace ? [input.workspace] : []), memory_directory: input.memory_directory ?? null, instructions: input.instructions ?? '' }))
    if(input.initial_member)addMember(id,input.initial_member)
    for(const member of input.initial_members??[])addMember(id,member)
    return room(id)
  }
  function copyRoom(sourceId,input) {
    return transaction(()=>{
      const source=get('loop_rooms',sourceId)
      if(source.config?.deleted_at)throw loopError('LOOP_NOT_FOUND','来源团队不存在',404)
      const members=db.prepare('SELECT id FROM loop_members WHERE room_id=? ORDER BY rowid').all(sourceId)
      if(!members.some(member=>member.id===source.config?.leader_id))throw loopError('LOOP_LEADER_REQUIRED','来源团队需要有效的 Leader')
      const created=insertRoom({title:input.title,id:input.id,request_key:input.request_key,memory_directory:input.memory_directory})
      const memberIds=new Map()
      for(const member of members){
        const id=createId();memberIds.set(member.id,id)
        db.prepare('INSERT INTO loop_members(id,room_id,name,runtime_id,instructions,profile_json,execution_config_json,avatar_json) SELECT ?,?,name,runtime_id,instructions,profile_json,execution_config_json,avatar_json FROM loop_members WHERE id=?').run(id,created.id,member.id)
      }
      db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({...created.config,leader_id:memberIds.get(source.config.leader_id),copy_source_room_id:sourceId}),created.id)
      return room(created.id)
    })
  }
  function addMember(roomId, input) {
    if(room(roomId).config?.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散',409)
    if (input.profile?.id) {
      const existing = room(roomId).members.find(member => member.profile?.id === input.profile.id || (member.profile?.source?.origin?.id ?? member.profile?.id) === (input.profile.source?.origin?.id ?? input.profile.id))
      if (existing) {
        if (existing.name === input.name && existing.runtime_id === input.runtime_id && JSON.stringify(existing.execution_config) === JSON.stringify(input.execution_config ?? null)) return existing
        throw loopError('LOOP_MEMBER_EXISTS', '该角色已在团队中', 409)
      }
    }
    get('loop_rooms', roomId)
    const name = text(input.name, '成员名称', 80)
    if (!PROVIDERS.has(input.runtime_id)) throw loopError('LOOP_PROVIDER_INVALID', '协作成员支持 Codex 或 Claude')
    const instructions = input.instructions == null || input.instructions === '' ? '' : text(input.instructions, '成员职责', 96 * 1024)
    const id = createId()
    db.prepare('INSERT INTO loop_members(id,room_id,name,runtime_id,instructions,profile_json,execution_config_json) VALUES(?,?,?,?,?,?,?)').run(id, roomId, name, input.runtime_id, instructions, JSON.stringify(input.profile ?? null), JSON.stringify(input.execution_config ?? null))
    if(input.avatar)db.prepare('UPDATE loop_members SET avatar_json=? WHERE id=?').run(JSON.stringify(input.avatar),id)
    const config = room(roomId).config ?? {}
    if (!config.leader_id) db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({ ...config, leader_id: id }), roomId)
    return get('loop_members', id)
  }
  function roomMessages(roomId) {
    const messages=db.prepare('SELECT * FROM (SELECT * FROM loop_messages WHERE room_id=? ORDER BY sequence DESC LIMIT 200) ORDER BY sequence').all(roomId).map(decode)
    const taskIds=[...new Set(messages.map(message=>message.task_id).filter(Boolean))]
    if(!taskIds.length)return messages
    const actions=db.prepare(`SELECT run_id,payload_json FROM loop_events WHERE task_id IN (${taskIds.map(()=>'?').join(',')}) AND kind='agent_message' ORDER BY sequence`).all(...taskIds)
    const byMessage=new Map(actions.map(action=>{const payload=JSON.parse(action.payload_json);return [payload.message_id,{runId:action.run_id,intent:payload.intent}]}))
    return messages.map(message=>{
      const action=byMessage.get(message.id)
      const intent=message.author!=='user'&&action?.runId===message.run_id? action?.intent : null
      return {...message,intent:message.intent??(['delegate','verify','ask','reply','announce'].includes(intent)?intent:null)}
    })
  }
  function room(id) {
    return { ...get('loop_rooms', id), memory_sync:memory.status(id),
      definition_deletions:db.prepare('SELECT member_id,state FROM loop_definition_deletions WHERE room_id=?').all(id),
      members: db.prepare('SELECT * FROM loop_members WHERE room_id=? ORDER BY rowid').all(id).map(decode),
      tasks: db.prepare('SELECT * FROM loop_tasks WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(id).map(decode),
      artifact_runs:db.prepare(`SELECT r.id,r.task_id,r.member_id,r.phase,r.stage,r.status,r.revision,r.generation,r.attempt,r.pid,r.session_id,r.error_code,r.created_at,r.finished_at,r.submission_json,r.action_json,r.member_snapshot_json
        FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE t.room_id=?
        AND (json_array_length(r.submission_json,'$.artifacts')>0 OR json_array_length(r.action_json,'$.artifacts')>0)
        ORDER BY r.rowid DESC LIMIT 100`).all(id).map(row=>({...decode(row),parts:null,result:null})),
      messages: roomMessages(id) }
  }
  function postMessage(roomId, input) {
    get('loop_rooms', roomId)
    const value = text(input.text, '消息')
    const requestKey = text(input.request_key, '请求标识', 128)
    const taskId = input.task_id ?? null
    if (taskId && task(taskId).room_id !== roomId) throw loopError('LOOP_TASK_MISMATCH', '任务不属于此团队')
    const existing = db.prepare('SELECT * FROM loop_messages WHERE request_key=?').get(requestKey)
    if (existing) {
      if (existing.room_id !== roomId || existing.task_id !== taskId || existing.text !== value) throw loopError('LOOP_IDEMPOTENCY_CONFLICT', '请求标识已用于其他消息', 409)
      return decode(existing)
    }
    return transaction(() => {
      message(roomId, taskId, null, 'user', value, requestKey)
      return decode(db.prepare('SELECT * FROM loop_messages WHERE request_key=?').get(requestKey))
    })
  }
  function validateTaskInput(roomId, input) {
    const target = room(roomId)
    if(target.config?.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散',409)
    const title = text(input.title, '任务名称', 160)
    const goal = text(input.goal, '任务目标')
    const acceptance = text(input.acceptance, '验收要求', 8000)
    const workspace = text(input.workspace, '工作目录', 4096)
    const requestKey = text(input.request_key, '请求标识', 128)
    if (!Array.isArray(input.participants)) throw loopError('LOOP_INPUT_INVALID', '请选择讨论成员')
    const config = {
      source_workspace: input.source_workspace ?? input.workspace, branch: input.branch ?? null,
      coordinator: input.coordinator, implementer: input.implementer, verifier: input.verifier,
      participants: [...new Set(input.participants ?? [])],
      timeout_seconds: input.timeout_seconds ?? 600,
      max_runs: input.max_runs ?? 12,
    }
    if (!Array.isArray(input.participants) || config.participants.length < 1 || config.participants.length > 6
      || !Number.isSafeInteger(config.timeout_seconds) || config.timeout_seconds < 60 || config.timeout_seconds > 3600
      || !Number.isSafeInteger(config.max_runs) || config.max_runs < config.participants.length + 4 || config.max_runs > 30) {
      throw loopError('LOOP_INPUT_INVALID', '参与者、执行时限或执行预算无效')
    }
    for (const id of [config.coordinator, config.implementer, config.verifier, ...config.participants]) {
      if (!target.members.some(member => member.id === id)) throw loopError('LOOP_MEMBER_INVALID', '任务成员必须属于此团队')
    }
    return { title, goal, acceptance, workspace, requestKey, config }
  }
  function createTask(roomId, input) {
    const { title, goal, acceptance, workspace, requestKey, config } = validateTaskInput(roomId, input)
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM loop_tasks WHERE request_key=?').get(requestKey)
      if (existing) {
        if (existing.room_id !== roomId || existing.title !== title || existing.goal !== goal || existing.acceptance !== acceptance
          || existing.workspace !== workspace || existing.config_json !== JSON.stringify(config)) throw loopError('LOOP_IDEMPOTENCY_CONFLICT', '请求标识已用于其他任务', 409)
        return detail(existing.id)
      }
      const id = createId(), timestamp = now()
      db.prepare('INSERT INTO loop_tasks VALUES(?,?,?,?,?,?,\'active\',\'planning\',1,1,?,?,?,?)')
        .run(id, roomId, title, goal, acceptance, workspace, JSON.stringify(config), requestKey, timestamp, timestamp)
      message(roomId, id, null, 'user', goal)
      event(id, null, 'task_created', { revision: 1 })
      enqueueStage(task(id), 0)
      return detail(id)
    })
  }
  function enqueueStage(current, stage, retry = false) {
    const config = current.config
    let members = stage === 1 ? config.participants : [stage === 3 ? config.implementer : stage === 4 ? config.verifier : config.coordinator]
    if (retry && stage === 1) members = members.filter(memberId => !db.prepare("SELECT id FROM loop_runs WHERE task_id=? AND revision=? AND stage=? AND member_id=? AND status='succeeded'").get(current.id, current.revision, stage, memberId))
    const count = db.prepare('SELECT count(*) AS n FROM loop_runs WHERE task_id=?').get(current.id).n
    if (count + members.length > config.max_runs) {
      setTask(current.id, 'waiting', PHASES[stage]); event(current.id, null, 'budget_exhausted'); return
    }
    for (const memberId of members) {
      const attempt = db.prepare('SELECT coalesce(max(attempt),0)+1 AS n FROM loop_runs WHERE task_id=? AND revision=? AND stage=? AND member_id=?')
        .get(current.id, current.revision, stage, memberId).n
      const id = createId()
      db.prepare(`INSERT INTO loop_runs(id,task_id,member_id,phase,stage,attempt,revision,generation,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, current.id, memberId, PHASES[stage], stage, attempt, current.revision, current.generation, 'queued', now())
      db.prepare("INSERT INTO loop_outbox VALUES(?,'queued')").run(id)
      event(current.id, id, 'run_queued', { stage, attempt })
    }
    setTask(current.id, 'active', PHASES[stage])
  }
  function setTask(id, status, phase) {
    db.prepare('UPDATE loop_tasks SET status=?,phase=?,updated_at=? WHERE id=?').run(status, phase, now(), id)
  }
  function detail(id) {
    const runs=db.prepare('SELECT * FROM loop_runs WHERE task_id=? ORDER BY rowid').all(id).map(decode)
    const facts=db.prepare("SELECT * FROM loop_events WHERE task_id=? AND kind IN ('run_claimed','run_spawned','first_response','resource_waiting','input_delivered') ORDER BY sequence").all(id).map(decode)
    const metrics=executionMetrics(runs,facts,now())
    return { ...task(id),metrics,
      reports:reports.index(id),
      inbox:communication.rows(id).map(({id,member_id,message_id,source_run_id,delivery,processing,payload})=>({id,member_id,message_id,source_run_id,kind:payload.message_kind,delivery,processing})),
      runs:runs.map(value=>({...value,timing:metrics.runs[value.id]})),
      events: db.prepare('SELECT * FROM (SELECT * FROM loop_events WHERE task_id=? ORDER BY sequence DESC LIMIT 200) ORDER BY sequence').all(id).map(decode).map(value=>value.kind==='report_recorded'?{...value,payload:{id:value.payload.id,version:value.payload.version,run_id:value.payload.run_id}}:value) }
  }
  function claim(runId, token) {
    return transaction(() => {
      const candidate = run(runId), current = task(candidate.task_id)
      if (candidate.status !== 'queued' || current.status !== 'active' || candidate.revision !== current.revision || candidate.generation !== current.generation) return null
      conversation.consumeInbox(candidate)
      const input = { message_cursor: db.prepare('SELECT coalesce(max(sequence),0) AS n FROM loop_messages WHERE room_id=?').get(current.room_id).n, result_cursor: db.prepare("SELECT coalesce(max(sequence),0) AS n FROM loop_events WHERE task_id=? AND kind='run_completed'").get(current.id).n, delivered: false }
      db.prepare('UPDATE loop_runs SET input_json=?,member_snapshot_json=? WHERE id=?').run(JSON.stringify(input),JSON.stringify(get('loop_members',candidate.member_id)),runId)
      db.prepare("UPDATE loop_runs SET status='starting',token_hash=? WHERE id=?").run(hash(token), runId)
      db.prepare("UPDATE loop_outbox SET state='claimed' WHERE run_id=?").run(runId)
      event(current.id, runId, 'run_claimed')
      const value=context(runId)
      input.delivery_ids=communication.initialDeliveryIds(run(runId),(value.room_messages??[]).map(message=>message.id),value.results.map(result=>result.id))
      db.prepare('UPDATE loop_runs SET input_json=? WHERE id=?').run(JSON.stringify(input),runId)
      return value
    })
  }
  function context(runId) {
    const execution = run(runId), current = task(execution.task_id)
    const link=continuity(execution,current),facts=conversation.context(runId),deliveredResults=new Set()
    if(link.session_id&&facts.room_messages){
      const deliveredRows=communication.rows(current.id,execution.member_id).filter(row=>row.delivery.state==='delivered'&&row.delivery.run_id&&run(row.delivery.run_id).session_id===link.session_id)
      const delivered=new Set(deliveredRows.map(row=>row.message_id))
      for(const row of deliveredRows)if(!row.message_id&&row.source_run_id)deliveredResults.add(row.source_run_id)
      facts.room_messages=facts.room_messages.filter(message=>message.sequence>link.message_cursor&&!delivered.has(message.id))
    }
    const query=[facts.assignment?.text,facts.assignment?.expected_output,current.goal].filter(Boolean).join(' ')
    const recovering=!link.session_id||link.recovering===true
    return { ...facts, reports:reports.index(current.id),memories: memories(current,query), ...(current.config.workflow==='conversation'&&recovering?{work_progress:workProgress(current,execution)}:{}),continuity: link, run: execution, task: current, member: decode(db.prepare('SELECT * FROM loop_members WHERE id=?').get(execution.member_id)) ?? execution.member_snapshot,
      results: db.prepare(`SELECT id,member_id,phase,status,error_code,result_json,routing_json FROM loop_runs
        WHERE task_id=? AND revision=? AND result_json IS NOT NULL AND id IN (SELECT run_id FROM loop_events WHERE task_id=? AND kind='run_completed' AND sequence>?) ORDER BY rowid DESC LIMIT 12`).all(current.id, current.revision, current.id, link.result_cursor ?? 0).reverse().map(decode).filter(value=>!deliveredResults.has(value.id)).map(value => {
          const {routing,...row}=value,assignment=conversation.assignment(value)
          return{...row,assignment:{...assignment,text:assignment.text.slice(0,600),expected_output:assignment.expected_output?.slice(0,400)??null,acceptance:assignment.acceptance?.slice(0,400)??null},result:{formal_report:reports.latestForRun(row.id)?{id:reports.latestForRun(row.id).id,version:reports.latestForRun(row.id).version,excerpt:formalSummary(row).slice(0,1200)}:null,submission:row.result?.submission?{...row.result.submission,summary:row.result.submission.summary.slice(0,1200)}:null,...(row.status==='succeeded'?{}:{error:row.result?.final_message?.slice(0,600)}),public_messages:{source_run_id:row.id,read:'read_context(section=results,source_run_id)'}}}
        }),
      messages: db.prepare('SELECT author,text FROM loop_messages WHERE task_id=? AND run_id IS NULL ORDER BY sequence DESC LIMIT 12').all(current.id).reverse().map(row => ({ ...row, text: row.text.slice(-2000) })) }
  }
  function memories(current,query) {
    if(current.config.workflow!=='conversation')return db.prepare('SELECT * FROM loop_memories WHERE room_id=? ORDER BY rowid DESC LIMIT 20').all(current.room_id).reverse().map(decode)
    const rows=db.prepare(`SELECT m.*,r.revision AS source_revision,
      (SELECT count(*) FROM json_each(?) q WHERE instr(lower(m.text),q.value)>0) AS matches
      FROM loop_memories m JOIN loop_runs r ON r.id=m.run_id WHERE m.room_id=?
      AND NOT EXISTS(SELECT 1 FROM loop_events e JOIN loop_tasks t ON t.id=e.task_id JOIN json_each(e.payload_json,'$.supersedes') s
        WHERE e.kind='memory_recorded' AND t.room_id=m.room_id AND s.value=m.id)
      ORDER BY (m.task_id=? AND r.revision=? AND m.kind='decision') DESC,matches DESC,(m.kind='decision') DESC,m.rowid DESC LIMIT 50`)
      .all(JSON.stringify(memoryKeywords(query)),current.room_id,current.id,current.revision)
    const selected=[];let remaining=MEMORY_CONTEXT_CHARACTERS-2
    for(const row of rows){
      if(!(row.task_id===current.id&&row.source_revision===current.revision)&&!row.matches)continue
      const {matches,...entry}=decode(row),full=entry.text
      entry.text=full.slice(0,MEMORY_EXCERPT_CHARACTERS)
      if(entry.text.length<full.length)entry.truncated=true
      const size=JSON.stringify(entry).length+1
      if(size>remaining)continue
      selected.push(entry);remaining-=size
      if(selected.length===20)break
    }
    return selected
  }
  function formalSummary(value) {
    const report=reports.latestForRun(value.id)
    if(report)return report.content
    if(value.submission?.summary)return value.submission.summary
    const parts=value.parts??run(value.id).parts??[]
    const body=parts.filter(part=>part.type==='text'&&part.origin!=='hook'&&(part.phase==='final_answer'||!part.phase)).map(part=>part.text).join('\n\n')
    return body||(parts.some(part=>part.origin==='hook')?'':value.result?.final_message??'')
  }
  function workProgress(current,execution) {
    const leader=execution.member_id===current.config.leader,dependencies=execution.routing?.depends_on??[]
    const runs=db.prepare('SELECT id,member_id,status,error_code,routing_json,submission_json,result_json FROM loop_runs WHERE task_id=? AND revision=? AND id!=? ORDER BY rowid DESC').all(current.id,current.revision,execution.id).map(decode)
      .filter(value=>leader||value.member_id===execution.member_id||dependencies.includes(value.id)||value.routing?.parent_run_id&&run(value.routing.parent_run_id).member_id===execution.member_id)
    const boundedAssignment=value=>{const assignment=conversation.assignment(value);return{...assignment,text:assignment.text.slice(0,400),expected_output:assignment.expected_output?.slice(0,200)??null,acceptance:assignment.acceptance?.slice(0,200)??null}}
    const summarize=value=>({run_id:value.id,member_id:value.member_id,status:value.status,error_code:value.error_code,assignment:boundedAssignment(value),summary:formalSummary(value).slice(0,600),report:reports.latestForRun(value.id)?{id:reports.latestForRun(value.id).id,version:reports.latestForRun(value.id).version}:null,artifacts:(value.submission?.artifacts??value.result?.submission?.artifacts??[]).slice(0,2)})
    const completed=runs.filter(value=>value.status==='succeeded'),unresolved=runs.filter(value=>value.status!=='succeeded')
    const pending=db.prepare(`SELECT i.* FROM loop_inbox i LEFT JOIN loop_runs source ON source.id=i.source_run_id
      WHERE i.task_id=? AND i.revision=? AND i.consumed_by IS NULL AND json_extract(i.payload_json,'$.reply_expected')=1
      AND NOT EXISTS(SELECT 1 FROM loop_runs queued WHERE queued.task_id=i.task_id AND json_extract(queued.routing_json,'$.inbox_id')=i.id AND queued.status IN ('queued','starting','running','stopping','unknown'))
      AND (? OR i.member_id=? OR source.member_id=?) ORDER BY i.rowid`)
      .all(current.id,current.revision,Number(leader),execution.member_id,execution.member_id)
    const known=new Set(runs.map(value=>value.id))
    const progress=db.prepare("SELECT sequence,run_id,payload_json,created_at FROM loop_events WHERE task_id=? AND kind='progress' ORDER BY sequence DESC").all(current.id)
      .filter(value=>known.has(value.run_id)).slice(0,6).map(value=>({sequence:value.sequence,run_id:value.run_id,text:JSON.parse(value.payload_json).text?.slice(0,600),created_at:value.created_at}))
    const checkpoint={revision:current.revision,completed_executions:[],incomplete_executions:[],pending_assignments:[],last_progress:[],counts:{completed_executions:completed.length,incomplete_executions:unresolved.length,pending_assignments:pending.length},execution_success_is_not_delivery:true,truncated:false}
    const sections={incomplete_executions:unresolved.slice(0,8).map(summarize),pending_assignments:pending.slice(0,8).map(value=>({inbox_id:value.id,member_id:value.member_id,source_run_id:value.source_run_id,...boundedAssignment({member_id:value.member_id,routing:{...JSON.parse(value.payload_json),inbox_id:value.id,parent_run_id:value.source_run_id,source_message_id:value.message_id}})})),last_progress:progress,completed_executions:completed.slice(0,8).map(summarize)}
    let remaining=MEMORY_CONTEXT_CHARACTERS-JSON.stringify(checkpoint).length-100
    for(const [section,items]of Object.entries(sections))for(const item of items){
      const size=JSON.stringify(item).length+1
      if(size>remaining){checkpoint.truncated=true;continue}
      checkpoint[section].push(item);remaining-=size
    }
    checkpoint.truncated||=Object.keys(checkpoint.counts).some(section=>checkpoint.counts[section]>checkpoint[section].length)
    return checkpoint
  }
  function continuity(execution,current) {
    const key = execution.routing?.intent ?? execution.phase
    const candidates = db.prepare('SELECT * FROM loop_runs WHERE task_id=? AND member_id=? AND rowid<(SELECT rowid FROM loop_runs WHERE id=?) AND session_id IS NOT NULL ORDER BY rowid DESC').all(current.id,execution.member_id,execution.id).map(decode)
    const member=decode(db.prepare('SELECT * FROM loop_members WHERE id=?').get(execution.member_id))??execution.member_snapshot
    const previous = current.config.workflow==='conversation' ? candidates[0] : candidates.find(row => (row.routing?.intent ?? row.phase) === key)
    if (!previous) return {session_id:null,message_cursor:0}
    if (LIVE_RUNS.has(previous.status)) throw loopError('LOOP_SESSION_BUSY','成员原会话的执行尚未确认结束',409)
    if(current.config.workflow==='conversation'&&(previous.revision!==execution.revision||previous.member_snapshot?.runtime_id!==member.runtime_id))return {session_id:null,message_cursor:0}
    return {session_id:previous.session_id,message_cursor:previous.input?.delivered ? previous.input.message_cursor : 0,result_cursor:previous.input?.delivered ? previous.input.result_cursor ?? 0 : 0,source_run_id:previous.id,recovering:previous.status!=='succeeded'||execution.generation>previous.generation,definition_unchanged:previous.input?.delivered===true&&previous.member_snapshot?.instructions===member.instructions}
  }
  function inputDelivered(id,{recordStart=true}={}) {
    const value=run(id)
    if(!value.input||value.input.delivered)return
    if(recordStart)event(value.task_id,id,'input_delivered')
    if (value.input) db.prepare('UPDATE loop_runs SET input_json=? WHERE id=?').run(JSON.stringify({...value.input,delivered:true}),id)
    communication.stampDelivery(value.input?.delivery_ids??[],id,'delivered',{mode:'initial_context'})
  }
  function readContext(id,input={}) {
    const current=context(id)
    if (!input.section || input.section==='snapshot') return current
    if(input.section==='reports')return {section:'reports',report:reports.read(current.task.id,input)}
    if(input.section==='progress')return {section:'progress',checkpoint:workProgress(current.task,current.run)}
    if(input.section==='memories'&&input.source_memory_id){
      const source=get('loop_memories',text(input.source_memory_id,'记忆标识',128))
      if(source.room_id!==current.task.room_id)throw loopError('LOOP_NOT_FOUND','记忆不属于当前团队',404)
      const replacements=db.prepare("SELECT json_extract(e.payload_json,'$.memory_id') AS id FROM loop_events e JOIN loop_tasks t ON t.id=e.task_id JOIN json_each(e.payload_json,'$.supersedes') s WHERE e.kind='memory_recorded' AND t.room_id=? AND s.value=? ORDER BY e.sequence").all(source.room_id,source.id)
      return{section:'memories',items:[{...source,superseded_by:replacements.map(value=>value.id)}],next_before:null}
    }
    if (input.section==='results' && input.source_run_id) {
      const source=run(text(input.source_run_id,'执行标识',128))
      if (source.task_id!==current.task.id) throw loopError('LOOP_NOT_FOUND','执行结果不属于当前任务',404)
      return {section:'results',items:[{id:source.id,member_id:source.member_id,status:source.status,assignment:conversation.assignment(source),result:{...source.result,final_message:formalSummary(source)},submission:source.submission,report:reports.latestForRun(source.id)?reports.read(current.task.id,{report_id:reports.latestForRun(source.id).id,offset:input.offset}):null,public_messages:(source.parts??[]).filter(part=>part.type==='text'&&part.text&&part.origin!=='hook').map(({id,text,phase,origin,truncated})=>({id,text,phase,origin,truncated}))}],next_before:null}
    }
    const limit=input.limit??20,before=input.before??Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(before)||before<1||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>200)) throw loopError('LOOP_INPUT_INVALID','历史页数、游标或搜索词无效')
    if (!['messages','memories','results'].includes(input.section)) throw loopError('LOOP_INPUT_INVALID','上下文区域无效')
    const table=input.section==='messages'?'loop_messages':input.section==='memories'?'loop_memories':'loop_runs'
    const scope=input.section==='results'?'task_id':'room_id',scopeId=input.section==='results'?current.task.id:current.task.room_id
    const column=input.section==='messages'?'sequence':'rowid',search=input.section==='results'?'result_json':'text'
    const rows=db.prepare(`SELECT rowid AS cursor,* FROM ${table} WHERE ${scope}=? AND ${column}<? AND instr(lower(coalesce(${search},'')),lower(?))>0 ORDER BY ${column} DESC LIMIT ?`).all(scopeId,before,input.query??'',limit+1)
    const page=[];let characters=0
    for(const row of rows.slice(0,limit)){const value=decode(row),size=JSON.stringify(value).length;if(page.length&&characters+size>65536)break;page.push(value);characters+=size}
    return {section:input.section,items:page,next_before:rows.length>page.length?page.at(-1).cursor:null}
  }
  function remember(id,input) {
    const candidate=run(id),current=task(candidate.task_id);assertLive(candidate)
    if (!['decision','summary'].includes(input.kind)) throw loopError('LOOP_INPUT_INVALID','记忆类型无效')
    const value=text(input.text,'记忆',12000),key=text(input.request_key,'请求标识',128),sources=input.sources??[]
    if (!Array.isArray(sources)||!sources.length||sources.length>32||sources.some(source=>typeof source!=='string'||!db.prepare('SELECT id FROM loop_messages WHERE id=? AND room_id=? UNION SELECT id FROM loop_runs WHERE id=? AND task_id=?').get(source,current.room_id,source,current.id))) throw loopError('LOOP_MEMORY_SOURCE_INVALID','记忆须引用本团队消息或当前任务执行')
    if(input.kind==='decision'&&!(current.config.workflow==='conversation'?candidate.member_id===current.config.leader&&candidate.routing?.intent==='lead':candidate.member_id===current.config.coordinator&&['planning','converging'].includes(candidate.phase))) throw loopError('LOOP_ACTION_FORBIDDEN','只有 Leader 可记录决定',403)
    if(input.supersedes!==undefined&&(!Array.isArray(input.supersedes)||input.supersedes.length>32))throw loopError('LOOP_INPUT_INVALID','替代记忆须为最多32个标识的列表')
    const supersedes=[...new Set(input.supersedes??[])].sort()
    if(supersedes.some(source=>typeof source!=='string'||!db.prepare('SELECT id FROM loop_memories WHERE id=? AND room_id=? AND kind=?').get(source,current.room_id,input.kind)))throw loopError('LOOP_MEMORY_SOURCE_INVALID','只能替代本团队同类型的已有记忆')
    return transaction(()=>{
      const previous=db.prepare('SELECT * FROM loop_memories WHERE run_id=? AND request_key=?').get(id,key)
      if(previous){
        const saved=db.prepare("SELECT payload_json FROM loop_events WHERE run_id=? AND kind='memory_recorded' AND json_extract(payload_json,'$.memory_id')=?").get(id,previous.id)
        if(previous.text!==value||previous.kind!==input.kind||previous.sources_json!==JSON.stringify(sources)||JSON.stringify(JSON.parse(saved?.payload_json??'{}').supersedes??[])!==JSON.stringify(supersedes))throw loopError('LOOP_IDEMPOTENCY_CONFLICT','请求标识已用于其他记忆',409)
        return decode(previous)
      }
      const memoryId=createId();db.prepare('INSERT INTO loop_memories VALUES(?,?,?,?,?,?,?,?,?)').run(memoryId,current.room_id,current.id,id,input.kind,value,JSON.stringify(sources),key,now())
      event(current.id,id,'memory_recorded',{memory_id:memoryId,kind:input.kind,supersedes});return get('loop_memories',memoryId)
    })
  }
  function projectContext(id,input) {
    const candidate=run(id),current=task(candidate.task_id);assertLive(candidate)
    if(current.config.workflow!=='conversation'||candidate.member_id!==current.config.leader||candidate.routing?.intent!=='lead')throw loopError('LOOP_ACTION_FORBIDDEN','只有当前 Leader 可准备任务项目',403)
    if(!Array.isArray(input.workspaces)||!input.workspaces.length||input.workspaces.length>8||input.workspaces.some(path=>typeof path!=='string'||!path.trim()||path.length>4096||path.includes('\0')))throw loopError('LOOP_INPUT_INVALID','请提供1–8个项目路径')
    if(input.execution_mode!==undefined&&!['isolated','existing_branch','in_place'].includes(input.execution_mode))throw loopError('LOOP_EXECUTION_MODE_INVALID','执行方式无效')
    if(input.branch!==undefined&&(typeof input.branch!=='string'||!input.branch.trim()||input.branch.length>255))throw loopError('LOOP_BRANCH_INVALID','分支引用无效')
    return{task:current,run:candidate}
  }
  function extendProjects(id,input,prepared) {
    return transaction(()=>{
      const{task:current}=projectContext(id,input),resources=current.config.resources??[{workspace:current.workspace,source_workspace:current.config.source_workspace,branch:current.config.branch}]
      for(const resource of prepared){
        const index=resources.findIndex(value=>value.source_workspace===resource.source_workspace)
        if(index<0)resources.push(resource)
        else resources[index]=resource
      }
      if(resources.length>8)throw loopError('LOOP_INPUT_INVALID','同一任务最多使用8个项目')
      const config={...current.config,resources,source_workspaces:resources.map(resource=>resource.source_workspace)}
      db.prepare('UPDATE loop_tasks SET config_json=?,updated_at=? WHERE id=?').run(JSON.stringify(config),now(),current.id)
      event(current.id,id,'projects_prepared',{resources})
      return{accepted:true,resources}
    })
  }
  function refreshProjects(taskId,previous,refreshed) {
    return transaction(()=>{
      const current=task(taskId),resources=[...(current.config.resources??[])];let changed=false
      for(let index=0;index<previous.length;index++){
        const target=resources.findIndex(value=>value.source_workspace===previous[index].source_workspace)
        if(target<0||JSON.stringify(resources[target])!==JSON.stringify(previous[index])||JSON.stringify(previous[index])===JSON.stringify(refreshed[index]))continue
        resources[target]=refreshed[index];changed=true
      }
      if(!changed)return
      db.prepare('UPDATE loop_tasks SET config_json=?,updated_at=? WHERE id=?').run(JSON.stringify({...current.config,resources}),now(),taskId)
      event(taskId,null,'projects_refreshed',{resources})
    })
  }
  function authenticate(runId, token) {
    const candidate = db.prepare('SELECT * FROM loop_runs WHERE id=?').get(runId)
    if (typeof token !== 'string' || !candidate?.token_hash || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(candidate.token_hash))) throw loopError('LOOP_AUTH_REQUIRED', '执行凭据无效', 401)
    const current = task(candidate.task_id)
    if (!['starting','running'].includes(candidate.status) || current.status !== 'active'
      || current.revision !== candidate.revision || current.generation !== candidate.generation) throw loopError('LOOP_CREDENTIAL_EXPIRED', '执行授权已过期', 409)
    return decode(candidate)
  }
  function assertLive(candidate) {
    const current = task(candidate.task_id)
    if (!['starting','running'].includes(candidate.status) || current.status !== 'active'
      || candidate.revision !== current.revision || candidate.generation !== current.generation) throw loopError('LOOP_CREDENTIAL_EXPIRED', '执行授权已过期', 409)
  }
  function submit(runId, input) {
    const candidate = run(runId),current=task(candidate.task_id)
    assertLive(candidate)
    const summary = text(input.summary, '执行结果', 12000)
    const verdict = input.verdict ?? 'complete'
    if (!['pass','fail','complete'].includes(verdict)) throw loopError('LOOP_INPUT_INVALID', '结果状态无效')
    if (candidate.phase === 'verifying' && !['pass','fail'].includes(verdict)) throw loopError('LOOP_INPUT_INVALID', '验证者须明确通过或失败')
    const artifacts = input.artifacts ?? []
    if (!Array.isArray(artifacts) || artifacts.length > 32 || artifacts.some(path => typeof path !== 'string' || !path.trim() || path.includes('\0') || path.length > 2048 || path.startsWith('/') || path.split(/[\\/]/).includes('..'))) throw loopError('LOOP_INPUT_INVALID', '产物须为工作目录内的相对路径')
    const answered=communication.validateLinks(candidate,input)
    const correction=input.correction_reason===undefined?null:text(input.correction_reason,'报告修正原因',2000)
    const origin=db.prepare("SELECT payload_json FROM loop_events WHERE run_id=? AND kind='execution_origin' ORDER BY sequence DESC LIMIT 1").get(runId)
    const previous=reports.latestForRun(runId)
    const newEvidence=previous&&(input.evidence_ids??[]).some(id=>!previous.evidence.some(value=>value.id===id))
    const newFinding=previous&&(input.findings??[]).some(finding=>!previous.findings.some(value=>value.id===finding.id&&value.text===finding.text))
    if(current.config.workflow==='conversation'&&previous&&JSON.parse(origin?.payload_json??'{}').origin==='hook'&&!correction&&!newEvidence&&!newFinding){
      event(current.id,runId,'hook_report',{summary,verdict,report_id:previous.id,report_version:previous.version})
      return{accepted:true,run_id:runId,report_id:previous.id,report_version:previous.version,notification:'internal_only',recipients:[],ignored:true,reason:'hook_acknowledgement'}
    }
    const submission = { summary, verdict, artifacts,...(correction?{correction_reason:correction}:{}),...(answered.length?{answered_message_ids:answered}:{}),...(input.evidence_ids?.length?{evidence_ids:input.evidence_ids}:{}),...(input.findings?.length?{findings:input.findings}:{}) }
    if (current.config.workflow!=='conversation'&&candidate.submission && JSON.stringify(candidate.submission) !== JSON.stringify(submission)) throw loopError('LOOP_RESULT_CONFLICT', '本次执行已提交其他结果', 409)
    db.prepare('UPDATE loop_runs SET submission_json=? WHERE id=?').run(JSON.stringify(submission), runId)
    if(current.config.workflow==='conversation'){
      const report=reports.save(candidate,{submission,answered_message_ids:answered,evidence:input.evidence??[],findings:input.findings??[]})
      communication.resolve(candidate,{...input,answered_message_ids:answered},{reportId:report.id,reportVersion:report.version})
      return{accepted:true,run_id:runId,report_id:report.id,report_version:report.version,...conversation.reportNotification(candidate,report)}
    }
    return { accepted: true, run_id: runId }
  }
  function requestAction(runId, input) {
    const candidate = run(runId), current = task(candidate.task_id)
    assertLive(candidate)
    if (current.config.workflow === 'conversation') return transaction(() => conversation.requestAction(candidate, input))
    if (candidate.member_id !== current.config.coordinator || !['planning','converging'].includes(candidate.phase)) throw loopError('LOOP_ACTION_FORBIDDEN', '只有当前协调执行可以请求阶段动作', 403)
    if (!['advance','wait'].includes(input.action)) throw loopError('LOOP_INPUT_INVALID', '动作须为 advance 或 wait')
    const action = { action: input.action, reason: text(input.reason, '动作原因', 2000) }
    if (candidate.action && JSON.stringify(candidate.action) !== JSON.stringify(action)) throw loopError('LOOP_ACTION_CONFLICT', '阶段动作已提交', 409)
    db.prepare('UPDATE loop_runs SET action_json=? WHERE id=?').run(JSON.stringify(action), runId)
    return { accepted: true }
  }
  function spawned(runId, { pid }) {
    db.prepare("UPDATE loop_runs SET status=CASE WHEN status='starting' THEN 'running' ELSE status END,pid=? WHERE id=?").run(pid, runId)
    event(run(runId).task_id,runId,'run_spawned')
  }
  function complete(runId, result, { exited = true } = {}) {
    return transaction(() => {
      const candidate = run(runId), current = task(candidate.task_id)
      if (!LIVE_RUNS.has(candidate.status)) return candidate
      let status = exited ? result.status : 'unknown'
      if (result.status === 'succeeded' && exited) inputDelivered(runId,{recordStart:false})
      if (!candidate.session_id && result.session_id) db.prepare('UPDATE loop_runs SET session_id=? WHERE id=?').run(result.session_id,runId)
      const errorCode = !exited ? 'LOOP_PROCESS_UNKNOWN' : result.error_code ?? (result.status === 'succeeded' && current.config.workflow !== 'conversation' && !candidate.submission ? 'LOOP_RESULT_MISSING' : null)
      if (errorCode && status === 'succeeded') status = 'failed'
      const report=current.config.workflow==='conversation'?reports.complete(candidate,result):null
      const {formal_messages,...executionResult}=result
      db.prepare('UPDATE loop_runs SET status=?,result_json=?,error_code=?,token_hash=NULL,finished_at=? WHERE id=?')
        .run(status, JSON.stringify({ ...executionResult,...(report?{final_message:report.content.slice(0,12000),formal_report:{id:report.id,version:report.version}}:{}),submission: candidate.submission }), errorCode, exited ? now() : null, runId)
      if(report&&status==='succeeded'&&exited&&current.status==='active'&&candidate.revision===current.revision&&candidate.generation===current.generation)communication.finishAssignment(candidate,report.id)
      db.prepare("UPDATE loop_outbox SET state='done' WHERE run_id=?").run(runId)
      event(current.id, runId, 'run_completed', { status, error_code: errorCode })
      const fallback=candidate.submission?.summary??result.final_message??(current.config.workflow==='conversation'?null:errorCode??status)
      if (fallback && (current.config.workflow !== 'conversation' || (!(candidate.parts??[]).some(part=>part.type==='text'&&part.text&&part.origin!=='hook') && !db.prepare('SELECT id FROM loop_messages WHERE run_id=?').get(runId)))) message(current.room_id, current.id, runId, candidate.member_id, fallback)
      if (current.status !== 'active' || candidate.revision !== current.revision || candidate.generation !== current.generation) return run(runId)
      if (current.config.workflow === 'conversation') { conversation.afterRun(candidate.id); return run(runId) }
      if (status !== 'succeeded') { setTask(current.id, status === 'unknown' ? 'waiting' : 'failed', candidate.phase); return run(runId) }
      if (candidate.action?.action === 'wait') { setTask(current.id, 'waiting', candidate.phase); return run(runId) }
      const pending = db.prepare("SELECT count(*) AS n FROM loop_runs WHERE task_id=? AND revision=? AND generation=? AND stage=? AND status!='succeeded'")
        .get(current.id, current.revision, current.generation, candidate.stage).n
      if (pending > 0) return run(runId)
      if (candidate.stage === 4) {
        if (candidate.submission.verdict === 'pass') {
          setTask(current.id, 'review', 'delivery')
          event(current.id, runId, 'review_ready')
        } else {
          event(current.id, runId, 'verification_failed')
          enqueueStage(current, 3)
        }
      } else enqueueStage(current, candidate.stage + 1)
      return run(runId)
    })
  }
  function control(id, input) {
    return transaction(() => {
      const current = task(id)
      if (input.expected_revision !== current.revision) throw loopError('LOOP_VERSION_CONFLICT', '任务已改变，请重新读取', 409)
      const action = input.action
      if(action==='resume'&&room(current.room_id).config?.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散',409)
      if(action==='resume'&&current.config.imported)throw loopError('LOOP_RESTORED_WORKSPACE_REQUIRED','此任务来自迁移；请先恢复原项目 worktree。可在团队发送新消息，在当前项目目录继续推进',409)
      if (action === 'revise' && !['completed','canceled'].includes(current.status)) {
        const goal = text(input.goal, '任务目标')
        const acceptance = text(input.acceptance ?? current.acceptance, '验收要求', 8000)
        db.prepare("UPDATE loop_tasks SET goal=?,acceptance=?,status='paused',phase='planning',revision=revision+1,generation=generation+1,updated_at=? WHERE id=?").run(goal, acceptance, now(), id)
        db.prepare("UPDATE loop_runs SET status='canceled',finished_at=? WHERE task_id=? AND status='queued'").run(now(), id)
        db.prepare("UPDATE loop_runs SET status='stopping',token_hash=NULL WHERE task_id=? AND status IN ('starting','running')").run(id)
        message(current.room_id, id, null, 'user', goal)
      } else if (action === 'accept' && current.status === 'review') setTask(id, 'completed', 'delivery')
      else if (['pause','cancel'].includes(action) && !['completed','canceled'].includes(current.status)) {
        db.prepare('UPDATE loop_tasks SET status=?,generation=generation+1,updated_at=? WHERE id=?').run(action === 'pause' ? 'paused' : 'canceled', now(), id)
        db.prepare("UPDATE loop_runs SET status='canceled',finished_at=? WHERE task_id=? AND status='queued'").run(now(), id)
        db.prepare("UPDATE loop_runs SET status='stopping',token_hash=NULL WHERE task_id=? AND status IN ('starting','running')").run(id)
      } else if (action === 'resume' && ['paused','waiting','failed'].includes(current.status)) {
        if (db.prepare("SELECT id FROM loop_runs WHERE task_id=? AND status IN ('starting','running','stopping','unknown')").get(id)) throw loopError('LOOP_RUN_UNRESOLVED', '先确认所有旧执行已退出', 409)
        const stages = db.prepare('SELECT stage FROM loop_runs WHERE task_id=? AND revision=? ORDER BY rowid DESC LIMIT 1').get(id, current.revision)
        db.prepare('UPDATE loop_tasks SET generation=generation+1 WHERE id=?').run(id)
        if (current.config.workflow === 'conversation') {
          db.prepare("UPDATE loop_runs SET generation=? WHERE task_id=? AND revision=? AND status='queued'").run(current.generation + 1, id, current.revision)
          conversation.resume(task(id))
        } else enqueueStage(task(id), stages?.stage ?? 0, true)
      } else throw loopError('LOOP_STATE_CONFLICT', '此状态不支持该操作', 409)
      event(id, null, `task_${action}`)
      return detail(id)
    })
  }
  function failQueued(id,result) {
    return transaction(()=>{
      const candidate=run(id),current=task(candidate.task_id)
      if(candidate.status!=='queued'||current.status!=='active'||candidate.revision!==current.revision||candidate.generation!==current.generation)return
      db.prepare("UPDATE loop_runs SET status='failed',result_json=?,error_code=?,finished_at=? WHERE id=?").run(JSON.stringify(result),result.error_code,now(),id)
      db.prepare("UPDATE loop_outbox SET state='done' WHERE run_id=?").run(id)
      event(current.id,id,'run_preparation_failed',{error_code:result.error_code})
      if(current.config.workflow==='conversation')conversation.afterRun(id)
      else setTask(current.id,'failed',candidate.phase)
    })
  }
  function recover() {
    return transaction(() => {
      communication.recover()
      const rows = db.prepare("SELECT * FROM loop_runs WHERE status IN ('starting','running','stopping')").all()
      for (const row of rows) {
        db.prepare("UPDATE loop_runs SET status='unknown',token_hash=NULL,error_code='LOOP_RESTART_UNKNOWN' WHERE id=?").run(row.id)
        if (!['paused','canceled','completed'].includes(task(row.task_id).status)) setTask(row.task_id, 'waiting', row.phase)
        event(row.task_id, row.id, 'recovery_unknown')
      }
      return rows.length
    })
  }
  function resolveUnknown(runId) {
    return transaction(() => {
      const candidate = run(runId)
      if (candidate.status !== 'unknown') throw loopError('LOOP_STATE_CONFLICT', '执行不处于未知状态', 409)
      db.prepare("UPDATE loop_runs SET status='interrupted',finished_at=?,error_code='LOOP_RECONCILED' WHERE id=?").run(now(), runId)
      event(candidate.task_id, runId, 'run_reconciled')
      return run(runId)
    })
  }
  return Object.freeze({
    memory,
    projectSessions:createTeamSessionProjection({db}),
    database:db,
    recordParts(id,parts){db.prepare('UPDATE loop_runs SET parts_json=? WHERE id=?').run(JSON.stringify(parts),id)},
    updateMember(roomId,id,input){return transaction(()=>{
      const member=get('loop_members',id)
      if(member.room_id!==roomId)throw loopError('LOOP_NOT_FOUND','成员不属于此团队',404)
      if(db.prepare("SELECT r.id FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE r.member_id=? AND r.status IN ('queued','starting','running','stopping','unknown')").get(id))throw loopError('LOOP_MEMBER_BUSY','成员执行结束后才能修改或删除',409)
      db.prepare('UPDATE loop_members SET name=?,execution_config_json=?,avatar_json=? WHERE id=?').run(text(input.name??member.name,'成员名称',80),JSON.stringify(input.execution_config??member.execution_config),JSON.stringify(input.avatar??member.avatar),id)
      return get('loop_members',id)
    })},
    removeMember(roomId,id){return transaction(()=>{
      const member=get('loop_members',id)
      if(member.room_id!==roomId)throw loopError('LOOP_NOT_FOUND','成员不属于此团队',404)
      if(db.prepare("SELECT id FROM loop_tasks WHERE room_id=? AND status IN ('active','paused','waiting')").get(roomId)||db.prepare("SELECT id FROM loop_runs WHERE member_id=? AND status IN ('queued','starting','running','stopping','unknown')").get(id))throw loopError('LOOP_MEMBER_BUSY','请先结束团队协作并确认成员执行已退出',409)
      db.prepare('UPDATE loop_runs SET member_snapshot_json=coalesce(member_snapshot_json,?) WHERE member_id=?').run(JSON.stringify(member),id)
      db.prepare('UPDATE loop_messages SET author_snapshot_json=? WHERE room_id=? AND author=?').run(JSON.stringify({id:member.id,name:member.name,runtime_id:member.runtime_id,avatar:member.avatar}),roomId,id)
      db.prepare('DELETE FROM loop_inbox WHERE member_id=? AND consumed_by IS NULL').run(id)
      db.prepare('UPDATE loop_work_items SET owner_id=NULL WHERE owner_id=?').run(id)
      const current=room(roomId),config=current.config
      if(config.leader_id===id)db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({...config,leader_id:null}),roomId)
      db.prepare('DELETE FROM loop_members WHERE id=?').run(id)
      return {deleted:true,member_id:id}
    })},
    dissolveRoom(id){const current=room(id);if(current.tasks.some(task=>!['completed','canceled','failed','review'].includes(task.status))||db.prepare("SELECT r.id FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE t.room_id=? AND r.status IN ('starting','running','stopping','unknown')").get(id))throw loopError('LOOP_ROOM_BUSY','仍有执行未确认退出，暂不能解散',409);db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({...current.config,dissolved_at:now()}),id);return room(id)},
    configureMemory(id,path) {const config=get('loop_rooms',id).config;db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({...config,memory_directory:path}),id)},
    board: board.snapshot,
    createWorkItem: (id,input) => transaction(() => board.create(id,input)),
    reorderWorkItems: (id,input) => transaction(() => board.reorder(id,input)),
    updateWorkItem: (id,itemId,input) => transaction(() => board.update(id,itemId,input)),
    configureRoom: (id, input) => transaction(() => conversation.configureRoom(id, input)),
    startConversation: (roomId, input, workspace) => transaction(() => conversation.start(roomId, input, workspace)),
    continueConversation: (roomId, taskId, input) => transaction(() => conversation.continue(roomId, taskId, input)),
    sendAgentMessage: (runId, input) => { assertLive(run(runId)); return transaction(() => conversation.send(runId, input)) },
    roomForRequest:key=>decode(db.prepare("SELECT * FROM loop_rooms WHERE json_extract(config_json,'$.creation_request_key')=?").get(key)),
    unresolvedRoom:id=>db.prepare("SELECT r.id FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE t.room_id=? AND r.status='unknown'").all(id),
    validateTaskInput, resolveUnknown, createRoom, copyRoom,
    taskForRequest: key => decode(db.prepare('SELECT * FROM loop_tasks WHERE request_key=?').get(key)),
    addMember, room, postMessage, createTask, detail, run, context, readContext, remember, inputDelivered:(...args)=>transaction(()=>inputDelivered(...args)), projectContext, extendProjects, refreshProjects,
    pendingDeliveries:runId=>communication.pendingForRun(run(runId)),
    deliveryRows:taskId=>communication.rows(taskId),
    executionOrigin:(id,origin)=>{const candidate=run(id);event(candidate.task_id,id,'execution_origin',{origin})},
    formalReport:runId=>reports.latestForRun(runId),
    evidenceForRun:(runId,ids)=>{
      const candidate=run(runId);assertLive(candidate)
      if(!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string'))throw loopError('LOOP_INPUT_INVALID','证据标识列表无效')
      return ids.map(id=>{const row=db.prepare("SELECT payload_json FROM loop_events WHERE task_id=? AND kind='evidence_read' AND json_extract(payload_json,'$.id')=?").get(candidate.task_id,id);if(!row)throw loopError('LOOP_NOT_FOUND','证据不属于当前任务',404);return JSON.parse(row.payload_json)})
    },
    recordEvidence:(runId,value)=>transaction(()=>{const candidate=run(runId);assertLive(candidate);const {text,...metadata}=value;event(candidate.task_id,runId,'evidence_read',metadata);return value}),
    recordProjectVersions:(runId,stage,value)=>{const candidate=run(runId);event(candidate.task_id,runId,'project_versions',{stage,resources:value})},
    resourceWaiting:id=>{const candidate=run(id);if(!db.prepare("SELECT sequence FROM loop_events WHERE run_id=? AND kind='resource_waiting'").get(id))event(candidate.task_id,id,'resource_waiting')},
    firstResponse:(id,observedAt)=>{const candidate=run(id);if(!db.prepare("SELECT sequence FROM loop_events WHERE run_id=? AND kind='first_response'").get(id))event(candidate.task_id,id,'first_response',{observed_at:observedAt??now()})},
    recordDelivery:(runId,ids,state,extra={})=>transaction(()=>communication.stampDelivery(ids,runId,state,extra)),
    resolveMessages:(runId,input,reference={})=>transaction(()=>{const candidate=run(runId);assertLive(candidate);return communication.resolve(candidate,input,reference)}),
    claim, authenticate, submit:(...args)=>transaction(()=>submit(...args)), requestAction, spawned, complete, control, recover, failQueued,
    schedulePending:(taskId,ids)=>transaction(()=>conversation.schedulePending(taskId,ids)),
    hideRoom(id){const current=room(id);if(!current.config?.dissolved_at)throw loopError('LOOP_ROOM_BUSY','请先解散团队',409);db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({...current.config,deleted_at:now()}),id);return room(id)},
    rooms: () => db.prepare("SELECT * FROM loop_rooms WHERE json_extract(config_json,'$.deleted_at') IS NULL ORDER BY rowid DESC").all().map(decode),
    queued: ({after=0}={}) => db.prepare(`SELECT r.*,r.rowid AS queue_cursor FROM loop_runs r JOIN loop_outbox o ON o.run_id=r.id
      JOIN loop_tasks t ON t.id=r.task_id WHERE o.state='queued' AND r.status='queued' AND t.status='active' AND r.rowid>? ORDER BY r.rowid LIMIT 32`).all(after).map(decode),
    recordSession: (id, sessionId, reference=null) => {const previous=run(id).input??{};db.prepare('UPDATE loop_runs SET session_id=?,input_json=? WHERE id=?').run(sessionId,JSON.stringify({...previous,...(reference?{native_session:reference}:{})}),id)},
    progress(id, value) { const candidate = run(id); assertLive(candidate); event(candidate.task_id, id, 'progress', { text: text(value, '进度', 2000) }); return { accepted: true,notification:'internal_only' } },
  })
}
function hash(token) { return createHash('sha256').update(token).digest('hex') }
