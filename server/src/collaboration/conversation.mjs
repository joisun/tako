import { loopError } from './errors.mjs'

const OPEN = "('queued','starting','running','stopping','unknown')"
const parse = value => (value ? JSON.parse(value) : null) ?? {}
const required = (value, label, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw loopError('LOOP_INPUT_INVALID', `${label}无效`)
  return value.trim()
}
export function createConversationOperations({ db, clock, createId }) {
  const now = () => new Date(clock()).toISOString()
  const task = id => { const row = db.prepare('SELECT * FROM loop_tasks WHERE id=?').get(id); if (!row) throw loopError('LOOP_NOT_FOUND', '任务不存在', 404); return { ...row, config: parse(row.config_json) } }
  const run = id => { const row = db.prepare('SELECT * FROM loop_runs WHERE id=?').get(id); if (!row) throw loopError('LOOP_NOT_FOUND', '执行不存在', 404); return row }
  const room = id => { const row = db.prepare('SELECT * FROM loop_rooms WHERE id=?').get(id); if (!row) throw loopError('LOOP_NOT_FOUND', '团队不存在', 404); return { ...row, config: parse(row.config_json) } }
  const members = roomId => db.prepare('SELECT * FROM loop_members WHERE room_id=? ORDER BY rowid').all(roomId)
  const event = (taskId, runId, kind, payload = {}) => db.prepare('INSERT INTO loop_events(task_id,run_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)').run(taskId, runId, kind, JSON.stringify(payload), now())
  function updateTask(current, status, phase) { db.prepare('UPDATE loop_tasks SET status=?,phase=?,updated_at=? WHERE id=?').run(status, phase, now(), current.id) }
  function mentionIds(roomId, value = []) {
    if (!Array.isArray(value) || value.length > 6) throw loopError('LOOP_MENTION_INVALID', '每条消息最多指定6位团队成员')
    const ids = [...new Set(value)], roster = members(roomId)
    if (ids.some(id => !roster.some(member => member.id === id))) throw loopError('LOOP_MENTION_INVALID', '@的成员不属于此团队')
    return ids
  }
  function insertMessage(current, author, text, requestKey, mentions, runId = null) {
    const existing = db.prepare('SELECT * FROM loop_messages WHERE request_key=?').get(requestKey)
    if (existing) {
      if (existing.text !== text || existing.room_id !== current.room_id || existing.task_id !== current.id || JSON.stringify(parse(existing.mentions_json)) !== JSON.stringify(mentions)) throw loopError('LOOP_IDEMPOTENCY_CONFLICT', '请求标识已用于其他消息', 409)
      return { id: existing.id, created: false }
    }
    const id = createId()
    db.prepare('INSERT INTO loop_messages(id,room_id,task_id,run_id,author,text,request_key,created_at,mentions_json) VALUES(?,?,?,?,?,?,?,?,?)').run(id, current.room_id, current.id, runId, author, text, requestKey, now(), JSON.stringify(mentions))
    return { id, created: true }
  }
  function inbox(current, memberId, { messageId = null, sourceRunId = null, reason, key, intent = 'lead', write = false, assignment = '', depends_on = [], reply_expected = false, wait_for_source = false }) {
    db.prepare('INSERT OR IGNORE INTO loop_inbox VALUES(?,?,?,?,?,?,?,NULL,?,?,?)').run(createId(), current.id, memberId, messageId, sourceRunId, reason, key, current.revision, JSON.stringify({ intent, write_access: write, assignment, depends_on, reply_expected, wait_for_source }), now())
  }
  function openWorkers(current) {
    return db.prepare(`SELECT * FROM loop_runs WHERE task_id=? AND revision=? AND status IN ${OPEN}`).all(current.id, current.revision)
      .filter(row => parse(row.routing_json).intent !== 'lead')
  }
  function ensureRun(current, memberId, { immediate = false } = {}) {
    current = task(current.id)
    if (current.status !== 'active' || db.prepare(`SELECT id FROM loop_runs WHERE task_id=? AND member_id=? AND status IN ${OPEN}`).get(current.id, memberId)) return
    const pending = db.prepare('SELECT * FROM loop_inbox WHERE task_id=? AND member_id=? AND revision=? AND consumed_by IS NULL ORDER BY rowid').all(current.id, memberId, current.revision).find(value=>{const payload=parse(value.payload_json);return (!payload.wait_for_source||!OPEN.includes(run(value.source_run_id).status))&&(payload.depends_on??[]).every(id=>run(id).status==='succeeded')})
    if (!pending) return
    const payload = parse(pending.payload_json)
    const dependencies=(payload.depends_on??[]).map(run)
    if(dependencies.some(value=>value.status!=='succeeded')) return
    if (payload.intent === 'lead' && !immediate && openWorkers(current).length) return
    const id = createId(), stage = db.prepare('SELECT coalesce(max(stage),-1)+1 AS n FROM loop_runs WHERE task_id=?').get(current.id).n
    const phase = payload.intent === 'lead' ? 'leading' : payload.intent === 'verify' ? 'verifying' : payload.write_access ? 'implementing' : 'discussing'
    db.prepare(`INSERT INTO loop_runs(id,task_id,member_id,phase,stage,attempt,revision,generation,status,created_at,routing_json) VALUES(?,?,?,?,?,1,?,?,'queued',?,?)`)
      .run(id, current.id, memberId, phase, stage, current.revision, current.generation, now(), JSON.stringify({ ...payload, inbox_id: pending.id, parent_run_id: pending.source_run_id }))
    db.prepare("INSERT INTO loop_outbox VALUES(?,'queued')").run(id)
    event(current.id, id, 'mention_queued', { member_id: memberId, reason: pending.reason, source_run_id: pending.source_run_id })
    db.prepare('UPDATE loop_tasks SET phase=?,updated_at=? WHERE id=?').run(phase, now(), current.id)
  }
  function consumeInbox(candidate) {
    const current = task(candidate.task_id)
    if (current.config.workflow !== 'conversation') return
    const routing = candidate.routing ?? parse(candidate.routing_json)
    if (routing.intent === 'lead') db.prepare('UPDATE loop_inbox SET consumed_by=? WHERE task_id=? AND member_id=? AND revision=? AND consumed_by IS NULL').run(candidate.id, current.id, candidate.member_id, current.revision)
    else db.prepare('UPDATE loop_inbox SET consumed_by=? WHERE id=? AND consumed_by IS NULL').run(candidate.id, routing.inbox_id)
  }
  function routeUser(current, input) {
    const mentions = mentionIds(current.room_id, input.mentions), value = required(input.text, '消息'), key = required(input.request_key, '请求标识', 128)
    const message = insertMessage(current, 'user', value, key, mentions)
    const attachments=input.attachments??[]
    const existingAttachments=parse(db.prepare('SELECT attachments_json FROM loop_messages WHERE id=?').get(message.id).attachments_json)
    if(!message.created&&JSON.stringify(existingAttachments)!==JSON.stringify(attachments)&&!(attachments.length===0&&!Array.isArray(existingAttachments)))throw loopError('LOOP_IDEMPOTENCY_CONFLICT','同一请求的文件引用已改变',409)
    if (!message.created) return { task_id: current.id, message_id: message.id }
    db.prepare('UPDATE loop_messages SET attachments_json=? WHERE id=?').run(JSON.stringify(attachments),message.id)
    for(const memberId of mentions.length ? mentions : [current.config.leader]) {
      inbox(current, memberId, { messageId: message.id, reason: 'user_message', key: `user:${message.id}:${memberId}`, intent:memberId===current.config.leader?'lead':'discuss', assignment:value })
      ensureRun(current, memberId, { immediate: true })
    }
    event(current.id, null, 'user_message', { message_id: message.id, mentions })
    return { task_id: current.id, message_id: message.id }
  }
  function start(roomId, input, workspace) {
    const target = room(roomId), roster = members(roomId)
    if(target.config.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散，只能查看历史',409)
    if (!roster.some(member => member.id === target.config.leader_id)) throw loopError('LOOP_LEADER_REQUIRED', '请先添加成员并指定团队 leader')
    const existingMessage = db.prepare('SELECT task_id FROM loop_messages WHERE request_key=?').get(input.request_key)
    if (existingMessage?.task_id) {
      const existing = task(existingMessage.task_id)
      if (existing.room_id !== roomId) throw loopError('LOOP_IDEMPOTENCY_CONFLICT', '请求标识已用于其他团队', 409)
      return routeUser(existing, input)
    }
    const goal = required(input.text, '消息'), id = createId(), timestamp = now()
    const config = { workflow: 'conversation', leader: target.config.leader_id, coordinator: target.config.leader_id,
      participants: roster.map(member => member.id),
      source_workspace: target.config.workspace, source_workspaces:target.config.workspaces??(target.config.workspace?[target.config.workspace]:[]), resources:workspace.resources??[{source_workspace:target.config.workspace,workspace:workspace.workspace,branch:workspace.branch}], branch: workspace.branch, room_instructions: target.config.instructions ?? '', allow_write: true }
    db.prepare(`INSERT INTO loop_tasks(id,room_id,title,goal,acceptance,workspace,status,phase,revision,generation,config_json,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'active','leading',1,1,?,?,?,?)`)
      .run(id, roomId, goal.split('\n')[0].slice(0,100), goal, 'Deliver the requested outcome with concrete verification evidence.', workspace.workspace, JSON.stringify(config), `conversation:${input.request_key}`, timestamp, timestamp)
    event(id, null, 'conversation_started')
    return routeUser(task(id), input)
  }
  function continueConversation(roomId, taskId, input) {
    let current = task(taskId)
    if(room(roomId).config.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散，只能查看历史',409)
    if (current.room_id !== roomId || current.config.workflow !== 'conversation') throw loopError('LOOP_TASK_MISMATCH', '消息不属于此团队的协作任务')
    if (['completed','canceled'].includes(current.status)) throw loopError('LOOP_STATE_CONFLICT', '任务已结束，请发起新的团队消息', 409)
    if (db.prepare("SELECT id FROM loop_runs WHERE task_id=? AND status='unknown'").get(taskId)) throw loopError('LOOP_RUN_UNRESOLVED', '先确认未知执行是否已退出', 409)
    if (current.status !== 'active') { updateTask(current, 'active', 'leading'); current = task(taskId) }
    return routeUser(current, input)
  }
  function send(runId, input) {
    const candidate = run(runId), current = task(candidate.task_id), routing = parse(candidate.routing_json)
    if (current.config.workflow !== 'conversation') throw loopError('LOOP_ACTION_FORBIDDEN', '该任务不使用团队消息委派')
    const parent=routing.parent_run_id ? run(routing.parent_run_id) : null
    const targets=input.mentions?.length ? input.mentions : input.intent==='reply' && parent ? [parent.member_id] : []
    const mentions = mentionIds(current.room_id, targets), value = required(input.text, '消息'), key = `agent:${runId}:${required(input.request_key, '请求标识', 128)}`
    const intent = input.intent ?? 'reply'
    if (!['delegate','verify','reply','announce'].includes(intent)) throw loopError('LOOP_INPUT_INVALID', '消息用途无效')
    if (['delegate','verify'].includes(intent) && !mentions.length) throw loopError('LOOP_MENTION_INVALID', '指派任务需要@具体成员')
    const dependencies=input.depends_on??[]
    if(!Array.isArray(dependencies)||dependencies.length>12||dependencies.some(id=>{const dependency=run(id);return dependency.task_id!==current.id||dependency.id===runId||dependency.member_id===candidate.member_id&&OPEN.includes(dependency.status)})) throw loopError('LOOP_DEPENDENCY_INVALID','依赖须为当前任务其他成员的执行')
    const write = input.write_access === true
    if (write && members(current.room_id).some(member => mentions.includes(member.id) && member.runtime_id !== 'codex')) throw loopError('LOOP_WRITE_UNSUPPORTED', '当前只有Codex成员可承担受限实施')
    if (intent !== 'delegate' && write) throw loopError('LOOP_ACTION_FORBIDDEN', '只有实施指派能授予写入权限', 403)
    const message = insertMessage(current, candidate.member_id, value, key, mentions, runId)
    if (!message.created) return { accepted: true, message_id: message.id }
    for (const memberId of intent === 'announce' ? [] : mentions) {
      const purpose = memberId === current.config.leader && intent === 'reply' ? 'lead' : intent === 'verify' ? 'verify' : write ? 'implement' : 'discuss'
      inbox(current, memberId, { messageId: message.id, sourceRunId: runId, reason: intent === 'delegate' ? 'delegation' : 'agent_mention', key: `mention:${message.id}:${memberId}`, intent: purpose, write, assignment: value, depends_on:dependencies, reply_expected:['delegate','verify'].includes(intent), wait_for_source:intent==='reply' })
      if (intent !== 'announce') ensureRun(current, memberId)
    }
    event(current.id, runId, 'agent_message', { message_id: message.id, mentions, intent, write_access: write })
    return { accepted: true, message_id: message.id, runs:db.prepare("SELECT id,member_id,status FROM loop_runs WHERE task_id=? AND json_extract(routing_json,'$.inbox_id') IN (SELECT id FROM loop_inbox WHERE message_id=?)").all(current.id,message.id) }
  }
  function requestAction(candidate, input) {
    const current = task(candidate.task_id), routing = candidate.routing ?? parse(candidate.routing_json)
    if (candidate.member_id !== current.config.leader || routing.intent !== 'lead') throw loopError('LOOP_ACTION_FORBIDDEN', '只有团队 leader 可以决定交付或等待', 403)
    if(input.action==='cancel_assignment'){
      const pending=db.prepare('SELECT * FROM loop_inbox WHERE id=? AND task_id=? AND consumed_by IS NULL').get(input.inbox_id,current.id)
      if(!pending)throw loopError('LOOP_NOT_FOUND','待执行指派不存在',404)
      db.prepare('UPDATE loop_inbox SET consumed_by=? WHERE id=?').run(candidate.id,pending.id)
      event(current.id,candidate.id,'assignment_canceled',{inbox_id:pending.id,reason:required(input.reason,'取消原因',4000)})
      return {accepted:true}
    }
    if (!['wait','deliver','advance'].includes(input.action)) throw loopError('LOOP_INPUT_INVALID', 'leader动作无效')
    const reason = required(input.reason, '动作说明', 4000)
    if (input.action === 'deliver') {
      if (openWorkers(current).length) throw loopError('LOOP_DELIVERY_PENDING', '仍有成员执行未完成', 409)
    }
    const action = { action: input.action, reason }
    if (candidate.action && JSON.stringify(candidate.action) !== JSON.stringify(action)) throw loopError('LOOP_ACTION_CONFLICT', '本次执行已提交不同的阶段决定', 409)
    db.prepare('UPDATE loop_runs SET action_json=? WHERE id=?').run(JSON.stringify(action), candidate.id)
    return { accepted: true }
  }
  function afterRun(runId) {
    const candidate = run(runId), current = task(candidate.task_id), routing = parse(candidate.routing_json)
    if (candidate.status === 'unknown') { updateTask(current, 'waiting', 'leading'); return }
    const isLeader = candidate.member_id === current.config.leader && routing.intent === 'lead'
    if (isLeader) {
      const action = parse(candidate.action_json)
      if (candidate.status !== 'succeeded') { updateTask(current, 'waiting', 'leading'); event(current.id, runId, 'leader_failed'); return }
      const unread = db.prepare('SELECT id FROM loop_inbox WHERE task_id=? AND revision=? AND consumed_by IS NULL').get(current.id,current.revision)
      if (action.action === 'deliver' && !unread && !openWorkers(current).length) { updateTask(current, 'review', 'delivery'); event(current.id, runId, 'delivery_ready', { summary: action.reason }); return }
      if (action.action === 'wait' && !unread && !openWorkers(current).length) { updateTask(current, 'waiting', 'leading'); event(current.id, runId, 'waiting_for_user', { reason: action.reason }); return }
      const pending = db.prepare('SELECT id FROM loop_inbox WHERE task_id=? AND revision=? AND consumed_by IS NULL').get(current.id,current.revision)
      if (!pending && !openWorkers(current).length) {
        const attempts = db.prepare("SELECT count(*) AS n FROM loop_events WHERE task_id=? AND kind='leader_no_action'").get(current.id).n
        event(current.id, runId, 'leader_no_action')
        if (attempts >= 2) { updateTask(current, 'waiting', 'leading'); return }
        inbox(current, current.config.leader, { sourceRunId: runId, reason: 'leader_followup', key: `followup:${runId}`, assignment: 'Your previous turn ended without delegating, asking the user, or delivering. Inspect the user goal and choose one concrete next action through the room tools. Do not poll or repeat completed work.' })
      }
    } else {
      const parent=routing.parent_run_id ? run(routing.parent_run_id) : null
      const notified=new Set(db.prepare("SELECT member_id FROM loop_inbox WHERE source_run_id=? AND consumed_by IS NULL AND reason='agent_mention'").all(runId).map(row=>row.member_id))
      if(routing.reply_expected && parent && !notified.has(parent.member_id) && parent.member_id!==current.config.leader && members(current.room_id).some(member=>member.id===parent.member_id)) inbox(current,parent.member_id,{sourceRunId:runId,reason:'member_result',key:`result:${runId}:requester`,intent:'discuss',assignment:'Your delegated work has returned. Reconcile the result and continue your own assignment.'})
      if(!notified.has(current.config.leader))inbox(current, current.config.leader, { sourceRunId: runId, reason: 'member_result', key: `result:${runId}:leader` })
    }
    for (const member of members(current.room_id).filter(member=>member.id!==current.config.leader)) ensureRun(current, member.id)
    ensureRun(current,current.config.leader)
  }
  function resume(current) {
    const pending = db.prepare('SELECT id FROM loop_inbox WHERE task_id=? AND revision=? AND consumed_by IS NULL').get(current.id,current.revision)
    if (!pending) inbox(current, current.config.leader, { reason: 'user_resume', key: `resume:${current.id}:${current.generation}`, assignment: current.goal })
    updateTask(current, 'active', 'leading')
    for (const member of members(current.room_id).filter(member=>member.id!==current.config.leader)) ensureRun(current, member.id)
    ensureRun(current,current.config.leader)
  }
  function configureRoom(roomId, input) {
    const target = room(roomId)
    const changed=(input.leader_id!==undefined&&input.leader_id!==target.config.leader_id)||(input.workspace!==undefined&&input.workspace!==target.config.workspace)||(input.workspaces!==undefined&&JSON.stringify(input.workspaces)!==JSON.stringify(target.config.workspaces??[target.config.workspace]))||(input.instructions!==undefined&&input.instructions!==target.config.instructions)
    if(changed&&db.prepare("SELECT id FROM loop_tasks WHERE room_id=? AND status IN ('active','paused','waiting')").get(roomId))throw loopError('LOOP_ROOM_BUSY','有未结束工作时不能更换 Leader、项目或协作规则',409)
    const config = { ...target.config }
    if (input.leader_id !== undefined) {
      if (!members(roomId).some(member => member.id === input.leader_id)) throw loopError('LOOP_MEMBER_INVALID', 'leader须为团队成员')
      config.leader_id = input.leader_id
    }
    if (input.workspace !== undefined) config.workspace = input.workspace
    if (input.workspaces !== undefined) config.workspaces = input.workspaces
    if (input.memory_directory !== undefined) config.memory_directory = input.memory_directory
    if (input.instructions !== undefined) config.instructions = String(input.instructions).slice(0,8000)
    db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify(config),roomId)
    return { ...target, config }
  }
  function context(runId) {
    const candidate = run(runId), current = task(candidate.task_id)
    if (current.config.workflow !== 'conversation') return {}
    return { room: { id:current.room_id, ...room(current.room_id).config },
      roster: members(current.room_id).map(member => ({ id:member.id,name:member.name,runtime_id:member.runtime_id,can_write:member.runtime_id==='codex',description:parse(member.profile_json).description??member.instructions.slice(0,200),leader:member.id===current.config.leader })),
      inbox: db.prepare('SELECT * FROM loop_inbox WHERE consumed_by=? ORDER BY rowid').all(runId).map(row=>({...row,payload:parse(row.payload_json)})),
      blocked:db.prepare('SELECT id,member_id,payload_json FROM loop_inbox WHERE task_id=? AND revision=? AND consumed_by IS NULL').all(current.id,current.revision).filter(row=>(parse(row.payload_json).depends_on??[]).some(id=>run(id).status!=='succeeded')).map(row=>({id:row.id,member_id:row.member_id,...parse(row.payload_json)})),
      outstanding: openWorkers(current).map(row=>({id:row.id,member_id:row.member_id,status:row.status,assignment:parse(row.routing_json).assignment})),
      room_messages: db.prepare('SELECT sequence,id,author,text,created_at,mentions_json,attachments_json FROM loop_messages WHERE room_id=? ORDER BY sequence DESC LIMIT 40').all(current.room_id).reverse().map(row=>({...row,text:row.text.slice(-3000),mentions:parse(row.mentions_json),attachments:(Array.isArray(parse(row.attachments_json))?parse(row.attachments_json):[]).map(value=>({...value,text:value.text?.slice(0,8000)}))})),
    }
  }
  return Object.freeze({ start, continue:continueConversation, send, requestAction, afterRun, resume, configureRoom, context, consumeInbox })
}
