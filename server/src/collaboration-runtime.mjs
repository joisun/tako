import { homedir } from 'node:os'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { processExists } from './execution-resource-coordinator.mjs'
import { prepareCollaborationWorkspace, prepareConversationWorkspace } from './collaboration-workspace.mjs'
import { resolveCollaborationArtifact } from './collaboration-artifacts.mjs'
import { executionPrompt } from './collaboration/context.mjs'
import { memberConfiguration, memberAvatar } from './collaboration/member-configuration.mjs'
import { prepareRoomAttachments,readRoomAttachment } from './collaboration/attachments.mjs'
import { createRunParts } from './collaboration/run-parts.mjs'
import { loopError } from './collaboration/errors.mjs'

export function createCollaborationRuntime({ store, executeAgent, resources, registry, logs, onChange = () => {}, concurrency = 2, catalog = null, memoryRoot = null, workspaceRoot = null,
  toolServerPath = fileURLToPath(new URL('../vendor/loop-server.mjs', import.meta.url)) }) {
  const active = new Map()
  const messageQueues = new Map()
  let creationQueue = Promise.resolve()
  let copyQueue = Promise.resolve()
  let stopping = false, timer = null, baseUrl = null, pumping = false
  const changed = () => { try { onChange({ kind: 'rooms' }) } catch {} }

  function copyRoom(sourceId,input) {
    const operation=copyQueue.then(async()=>{
      if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120)throw loopError('LOOP_INPUT_INVALID','请输入团队名称')
      if(typeof input.request_key!=='string'||!input.request_key.trim()||input.request_key.length>128)throw loopError('LOOP_INPUT_INVALID','复制请求标识无效')
      const existing=store.roomForRequest(input.request_key)
      if(existing){
        if(existing.title!==input.title.trim()||existing.config?.copy_source_room_id!==sourceId)throw loopError('LOOP_IDEMPOTENCY_CONFLICT','复制请求标识已用于不同团队配置',409)
        return store.room(existing.id)
      }
      const source=store.room(sourceId)
      if(source.config?.deleted_at)throw loopError('LOOP_NOT_FOUND','来源团队不存在',404)
      if(!source.members.some(member=>member.id===source.config?.leader_id))throw loopError('LOOP_LEADER_REQUIRED','来源团队需要有效的 Leader')
      const id=randomUUID(),directory=memoryRoot?await store.memory.bind(join(memoryRoot,id),id):null
      const value=store.copyRoom(sourceId,{id,title:input.title.trim(),request_key:input.request_key,memory_directory:directory})
      changed();return value
    })
    copyQueue=operation.catch(()=>{})
    return operation
  }

  function backup(roomId){void store.memory.flush(roomId).catch(error=>{console.error('Rillo room backup pending:',error.code);changed()})}

  async function execute(candidate, controller) {
    const parts=createRunParts(value=>store.recordParts(candidate.id,value),changed)
    let lease = null, pid = null, handle = null, result = null, claimed = false
    try {
      const current = store.context(candidate.id)
      lease = await resources.wait({ owner: 'collaboration', runId: candidate.id, workspace: current.task.workspace, workspaces:[current.task.workspace,...(current.task.config.resources?.map(resource=>resource.workspace)??[])], signal: controller.signal, access:current.run.phase==='implementing'?'write':'read' })
      if (controller.signal.aborted) return
      const token = randomBytes(32).toString('hex')
      const context = store.claim(candidate.id, token)
      if (!context) return
      claimed = true
      backup(context.task.room_id)
      changed()
      const writing = context.run.phase === 'implementing'
      if (writing && registry.get(context.member.runtime_id).capabilities?.collaborationWrite === false) throw loopError('LOOP_WRITE_UNSUPPORTED', '所选 Agent 尚不支持受限实施')
      const executionEnv = { RILLO_LOOP_URL: baseUrl, RILLO_LOOP_RUN: candidate.id, RILLO_LOOP_TOKEN: token }
      const loopMcp = { command: process.execPath, args: [toolServerPath] }
      const executionConfig = {
        ...(writing && context.task.config.resources?.length ? {'sandbox_workspace_write.writable_roots':context.task.config.resources.map(resource=>resource.workspace)} : {}),
        'mcp_servers.rillo_loop': { ...loopMcp, env_vars: Object.keys(executionEnv), enabled: true, default_tools_approval_mode: 'approve', enabled_tools: ['read_context','submit_result','request_action','report_progress','send_message','remember'] },
      }
      handle = await logs.open({ scheduleId: context.task.id, runId: candidate.id })
      const attached=[]
      for(const message of store.room(context.task.room_id).messages)for(const attachment of message.attachments??[]) {
        if(!context.room_messages?.some(value=>value.id===message.id))continue
        await readRoomAttachment(attachment,{extract:false})
        attached.push(attachment)
      }
      let sequence = 0
      result = await executeAgent({
        runId: candidate.id, runtimeId: context.member.runtime_id, signal: controller.signal, logs: handle,
        spec: { workspace: context.task.workspace, resume_session_id: context.continuity.session_id, additional_workspaces:context.task.config.resources?.map(resource=>resource.workspace).filter(path=>path!==context.task.workspace)??[], images:attached.filter(item=>item.media_type.startsWith('image/')).map(item=>item.path), prompt: executionPrompt(context), sandbox_mode: writing ? 'workspace-write' : 'read-only',
          reasoning_effort:context.member.execution_config?.effort??null, reasoning_summary:'concise',
          timeout_seconds: context.task.config.timeout_seconds, model: context.member.execution_config ? context.member.execution_config.model : context.member.profile?.model ?? null,
          network_access: false, capabilities: { skills: 'disabled', integrations: 'disabled' },
          execution_config: executionConfig, execution_env: executionEnv, loop_mcp: loopMcp },
        nextSequence: () => ++sequence,
        onSpawn(value) { pid = value.pid; lease.spawned(pid); store.spawned(candidate.id, value); changed() },
        emit(event) { parts.emit(event); if (event.type === 'turn_started') store.inputDelivered(candidate.id); if (event.type === 'session') { store.recordSession(candidate.id, event.payload.session_id,context.member.runtime_id==='codex'?{provider:context.member.runtime_id,store_id:createHash('sha256').update(resolve(process.env.CODEX_HOME??join(homedir(),'.codex'))).digest('hex').slice(0,20),session_id:event.payload.session_id}:null); changed() } },
      })
    } catch (error) {
      result = { status: controller.signal.aborted ? 'canceled' : 'failed', error_code: error.code ?? 'LOOP_EXECUTION_FAILED', final_message: error.message }
      if(!claimed&&!controller.signal.aborted)store.failQueued(candidate.id,result)
    } finally {
      parts.flush()
      await handle?.close().catch(() => {})
      const exited = lease ? await lease.releaseWhenExited(pid) : true
      if (claimed) {
        try { store.complete(candidate.id, result ?? { status: 'failed', error_code: 'LOOP_EXECUTION_FAILED' }, { exited }) }
        catch (error) { console.error('Rillo collaboration result persistence failed:', error.code ?? error.message) }
      }
      backup(store.detail(candidate.task_id).room_id)
      active.delete(candidate.id)
      changed()
      wake()
    }
  }
  async function pump() {
    if (pumping || stopping || !baseUrl) return
    pumping = true
    try {
      for (const candidate of store.queued()) {
        if (active.size >= concurrency) break
        if (active.has(candidate.id)) continue
        const controller = new AbortController()
        const entry = { controller, promise: null, taskId:candidate.task_id }
        active.set(candidate.id, entry)
        entry.promise = execute(candidate, controller)
      }
    } finally { pumping = false }
  }
  function wake() { if (!stopping) void pump() }
  async function recoverDefinitionDeletions(roomId=null){
    const jobs=store.database.prepare('SELECT * FROM loop_definition_deletions WHERE (? IS NULL OR room_id=?)').all(roomId,roomId)
    for(const job of jobs){
      try{
        const exists=store.room(job.room_id).members.some(member=>member.id===job.member_id)
        await catalog.finishDeletion(JSON.parse(job.files_json),!exists)
        store.database.prepare('DELETE FROM loop_definition_deletions WHERE id=?').run(job.id)
      }catch(error){
        store.database.prepare("UPDATE loop_definition_deletions SET state='blocked' WHERE id=?").run(job.id)
        if(roomId)throw loopError('LOOP_DEFINITION_DELETE_PENDING','定义文件清理未完成，请检查文件权限或重建的同名文件后重试',409)
        console.error('Rillo definition cleanup pending:',job.id,error.code??'FILE_ACCESS_FAILED')
      }
    }
  }
  async function start(url) {
    store.recover()
    await recoverDefinitionDeletions()
    for(const room of store.rooms()) {
      try{if(memoryRoot&&!room.config.memory_directory){const path=await store.memory.bind(join(memoryRoot,room.id),room.id);store.configureMemory(room.id,path)};backup(room.id)}
      catch(error){console.error('Rillo room memory startup sync failed:',room.id,error.code)}
    }
    baseUrl = url
    timer = setInterval(wake, 1000); timer.unref?.()
    wake()
  }
  function createTask(roomId, input) {
    const operation = creationQueue.then(() => createTaskInWorktree(roomId, input))
    creationQueue = operation.catch(() => {})
    return operation
  }
  async function createTaskInWorktree(roomId, input) {
    if (!isAbsolute(input.workspace ?? '')) throw loopError('LOOP_WORKSPACE_INVALID', '请选择绝对路径的工作目录')
    const workspace = await realpath(input.workspace).catch(() => { throw loopError('LOOP_WORKSPACE_INVALID', '工作目录不存在') })
    if (!(await stat(workspace)).isDirectory()) throw loopError('LOOP_WORKSPACE_INVALID', '工作目录须为目录')
    const room = store.room(roomId)
    const ids = [input.coordinator, input.implementer, input.verifier, ...(input.participants ?? [])]
    const members = ids.map(id => room.members.find(member => member.id === id))
    if (members.some(member => !member)) throw loopError('LOOP_MEMBER_INVALID', '请选择团队成员')
    for (const member of members) await registry.resolve(member.runtime_id)
    const implementer = room.members.find(member => member.id === input.implementer)
    if (registry.get(implementer.runtime_id).capabilities?.collaborationWrite === false) throw loopError('LOOP_WRITE_UNSUPPORTED', 'Claude 可讨论和审阅；受限实施暂请选择 Codex')
    store.validateTaskInput(roomId, { ...input, workspace })
    const existing = store.taskForRequest(input.request_key)
    const prepared = existing
      ? { workspace: existing.workspace, source_workspace: workspace, branch: existing.config.branch }
      : await prepareCollaborationWorkspace({ workspace, requestKey: input.request_key })
    const value = store.createTask(roomId, { ...input, ...prepared })
    changed(); wake(); return value
  }
  function control(id, input) {
    const value = store.control(id, input)
    if (['pause','cancel','revise'].includes(input.action)) for (const [runId, entry] of active) {
      if (store.run(runId).task_id === id) entry.controller.abort()
    }
    changed(); wake(); return value
  }
  async function close() {
    stopping = true; clearInterval(timer)
    for (const entry of active.values()) entry.controller.abort()
    await Promise.allSettled([...active.values()].map(entry => entry.promise))
    try{await store.memory.close()}catch(error){console.error('Rillo room memory shutdown sync failed:',error.code)}
  }
  function reconcileRun(id, input) {
    if (input.confirmed_exited !== true || active.has(id)) throw loopError('LOOP_PROCESS_UNCONFIRMED', '须确认旧进程已退出，且执行不由当前服务管理', 409)
    const candidate = store.run(id)
    if (candidate.pid && processExists(candidate.pid)) throw loopError('LOOP_PROCESS_STILL_RUNNING', '原进程仍存在', 409)
    if (candidate.status !== 'unknown') throw loopError('LOOP_STATE_CONFLICT', '执行不处于未知状态', 409)
    resources.reconcile('collaboration', id)
    const value = store.resolveUnknown(id)
    changed(); return value
  }
  async function canonicalWorkspace(value) {
    if (!isAbsolute(value ?? '')) throw loopError('LOOP_WORKSPACE_REQUIRED', '请先在团队中设置项目目录')
    const path = await realpath(value).catch(() => { throw loopError('LOOP_WORKSPACE_INVALID', '项目目录不存在') })
    if (!(await stat(path)).isDirectory()) throw loopError('LOOP_WORKSPACE_INVALID', '项目路径须为目录')
    return path
  }
  async function canonicalWorkspaces(values) {
    if (!Array.isArray(values)||!values.length||values.length>8) throw loopError('LOOP_WORKSPACE_REQUIRED','请设置1–8个项目目录')
    return [...new Set(await Promise.all(values.map(canonicalWorkspace)))]
  }
  async function postConversationMessage(roomId, input) {
    const operation = (messageQueues.get(roomId) ?? Promise.resolve()).then(async () => {
      const room = store.room(roomId)
      if(room.config?.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散，只能查看历史',409)
      input={...input,attachments:await prepareRoomAttachments(input.attachments)}
      const selected = input.task_id ? room.tasks.find(task => task.id === input.task_id) : room.tasks.find(task => task.config.workflow === 'conversation' && !['completed','canceled'].includes(task.status))
      const sameConfiguration = selected?.config.leader === room.config?.leader_id && selected?.config.source_workspace === room.config?.workspace && (selected?.config.room_instructions ?? '') === (room.config?.instructions ?? '') && selected?.config.max_runs === room.config?.max_runs
      if (!selected?.config.imported && selected?.config.workflow === 'conversation' && sameConfiguration && !['completed','canceled'].includes(selected.status)) {
        const value = store.continueConversation(roomId, selected.id, input)
        changed(); wake(); return value
      }
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000 || typeof input.request_key !== 'string' || !input.request_key.trim()) throw loopError('LOOP_INPUT_INVALID', '消息或请求标识无效')
      if(selected?.config.imported&&store.unresolvedRoom(roomId).length)throw loopError('LOOP_RUN_UNRESOLVED','迁移的旧执行尚未核对，请先确认旧进程已退出',409)
      const leader = room.members.find(member => member.id === room.config?.leader_id)
      if (!leader) throw loopError('LOOP_LEADER_REQUIRED', '请先为团队指定leader')
      await registry.resolve(leader.runtime_id)
      const existing = room.tasks.find(task => task.request_key === `conversation:${input.request_key}`)
      let prepared
      if(existing)prepared={workspace:existing.workspace,branch:existing.config.branch,resources:existing.config.resources}
      else prepared=await prepareConversationWorkspace({workspaceRoot,roomId,requestKey:input.request_key})
      const value = store.startConversation(roomId, input, prepared)
      changed(); wake(); return value
    })
    const tail = operation.catch(() => {})
    messageQueues.set(roomId, tail)
    try { return await operation } finally { if (messageQueues.get(roomId) === tail) messageQueues.delete(roomId) }
  }
  async function requestAction(id,input) {
    if(input.action!=='prepare_projects'){const value=store.requestAction(id,input);changed();return value}
    const context=store.projectContext(id,input),current=context.task.config.resources??[{workspace:context.task.workspace,source_workspace:context.task.config.source_workspace,branch:context.task.config.branch}]
    const paths=await canonicalWorkspaces(input.workspaces.map(path=>{
      if(path.startsWith('~/'))return join(homedir(),path.slice(2))
      if(isAbsolute(path))return path
      const base=context.task.config.source_workspace??current[0]?.source_workspace
      if(!base)throw loopError('LOOP_PROJECT_PATH_REQUIRED','尚未指定项目，请在对话中给出绝对路径或 ~/ 路径')
      return resolve(base,path)
    }))
    const executionMode=input.execution_mode??(input.branch?'existing_branch':'isolated')
    for(const path of paths){
      const existing=current.find(resource=>resource.source_workspace===path)
      if(existing&&(((input.execution_mode!==undefined||input.branch!==undefined)&&(existing.execution_mode??'isolated')!==executionMode)||(input.branch!==undefined&&(existing.requested_branch??existing.branch)!==input.branch)))throw loopError('LOOP_PROJECT_BINDING_CONFLICT','当前任务已绑定该项目的其他分支或执行方式，请结束当前任务后再重新选择',409)
    }
    const additions=paths.filter(path=>!current.some(resource=>resource.source_workspace===path))
    if(current.length+additions.length>8)throw loopError('LOOP_INPUT_INVALID','同一任务最多使用8个项目')
    const prepared=[]
    for(const workspace of additions)prepared.push(await prepareCollaborationWorkspace({workspace,requestKey:context.task.id,executionMode,branch:input.branch??null}))
    const result=store.extendProjects(id,input,prepared);changed();return result
  }
  async function memberRuntime(runtimeId) {
    if (!['codex','claude'].includes(runtimeId)) throw loopError('LOOP_PROVIDER_INVALID','团队成员支持 Codex 或 Claude')
    try {
      await registry.resolve(runtimeId)
      const result = registry.models ? await registry.models(runtimeId) : {source:'unavailable',models:[]}
      return { id:runtimeId, state:'ready', source:result.source, models:result.source==='live' ? result.models : [],
        model_override_supported:result.source==='live', error_code:result.error_code??null }
    } catch (error) { return {id:runtimeId,state:'unavailable',source:'unavailable',models:[],model_override_supported:false,error_code:error.code??'RUNTIME_PROBE_FAILED'} }
  }
  async function dissolveRoom(id){
      const room=store.room(id)
      if(room.config?.dissolved_at)return room
      const tasks=store.database.prepare("SELECT id,revision FROM loop_tasks WHERE room_id=? AND status IN ('active','waiting','paused')").all(id)
      for(const task of tasks)control(task.id,{action:'cancel',expected_revision:task.revision})
      await Promise.all([...active.values()].filter(entry=>tasks.some(task=>task.id===entry.taskId)).map(entry=>entry.promise))
      const value=store.dissolveRoom(id);changed();return value
    }
  return Object.freeze({ ...store,
    reconcileRun,
    memberRuntime,
    importAgent: async input => {
      try { const result = await catalog.importLocal(input.definition_id,input.runtime_id??'codex'); changed(); return result }
      catch (error) { if(error.code==='AGENT_CATALOG_ERROR')throw error;throw loopError('AGENT_SAVE_FAILED','无法保存到本地 Agent 目录，请检查目录权限和磁盘空间',503) }
    },
    createWorkItem(id,input) { const value=store.createWorkItem(id,input);changed();return value },
    reorderWorkItems(id,input) { const value=store.reorderWorkItems(id,input);changed();return value },
    updateWorkItem(id,itemId,input) { const value=store.updateWorkItem(id,itemId,input);changed();return value },
    async memberDefinition(roomId,memberId) {
      const member=store.room(roomId).members.find(value=>value.id===memberId)
      if (!member) throw loopError('LOOP_NOT_FOUND','成员不属于当前团队',404)
      if (member.profile?.id && member.instructions) return {member,definition:{...member.profile,instructions:member.instructions},source:'snapshot'}
      if (member.profile?.id?.startsWith('local:')) {
        try { return {member,definition:await catalog.get(member.profile.id,member.runtime_id),source:'local'} }
        catch { return {member,definition:null,source:'missing',message:'无法读取关联的本地定义，文件可能已移动或删除'} }
      }
      return {member,definition:null,source:'missing',message:'此成员未关联可读取的 Agent 定义'}
    },
    async restoreRoom(input) {const workspaces=input.workspaces?.length?await canonicalWorkspaces(input.workspaces):[];const id=await store.memory.restore({...input,workspaces,default_root:memoryRoot});changed();return store.room(id)},
    async flushMemory(roomId){try{return await store.memory.flush(roomId)}finally{changed()}},
    readContext(id,input={}) {if(input.section==='attachment'){const room=store.context(id).task.room_id;const message=store.database.prepare('SELECT attachments_json FROM loop_messages WHERE id=? AND room_id=?').get(input.source_message_id??'',room);const attachment=JSON.parse(message?.attachments_json??'[]')[input.attachment_index??0];if(!attachment)throw loopError('LOOP_NOT_FOUND','文件引用不属于此团队',404);const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw loopError('LOOP_INPUT_INVALID','文件读取位置无效');return {...attachment,text:attachment.text?.slice(offset,offset+12000),next_offset:attachment.text?.length>offset+12000?offset+12000:null}};return input.section==='artifact'?store.memory.readArtifact(store.context(id).task.room_id,input):store.readContext(id,input)},
    catalogSources:()=>{if(!catalog)throw loopError('AGENT_CATALOG_UNAVAILABLE','Agent目录尚未初始化',503);return {sources:catalog.sources()}},
    catalog: async (source,options={}) => { if (!catalog) throw loopError('AGENT_CATALOG_UNAVAILABLE', 'Agent目录尚未初始化', 503); return source === 'local' ? catalog.local() : catalog.marketplace(source,options) },
    agentDefinition: (id, runtimeId) => catalog.get(id, runtimeId),
    async configureRoom(id, input) {
      const workspaces = input.workspaces!==undefined ? await canonicalWorkspaces(input.workspaces) : input.workspace!==undefined ? [await canonicalWorkspace(input.workspace)] : undefined
      const room=store.room(id),configuration=room.config
      if(configuration.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散',409)
      const changesExecution=(workspaces!==undefined&&JSON.stringify(workspaces)!==JSON.stringify(configuration.workspaces??[configuration.workspace]))||(input.leader_id!==undefined&&input.leader_id!==configuration.leader_id)||(input.instructions!==undefined&&input.instructions!==configuration.instructions)
      if(changesExecution&&room.tasks.some(task=>['active','paused','waiting'].includes(task.status)))throw loopError('LOOP_ROOM_BUSY','有未结束工作时不能更换 Leader 或项目',409)
      let memory_directory
      if(input.memory_directory!==undefined){
        const path=input.memory_directory||memoryRoot&&join(memoryRoot,id)
        memory_directory=path?await store.memory.bind(path,id):null
      }
      const value = store.configureRoom(id, { ...input, ...(memory_directory===undefined?{}:{memory_directory}), ...(workspaces===undefined?{}:{workspace:workspaces[0],workspaces}) })
      changed(); return store.room(value.id)
    },
    remember(id,input) { const value=store.remember(id,input);changed();return value },
    sendMessage(id, input) { const value = store.sendAgentMessage(id, input); changed(); wake(); return value },

    resourceClaims: resources.list,
    reconcileResource(input) {
      if (input.confirmed_exited !== true || !['schedule','collaboration'].includes(input.owner)) throw loopError('LOOP_PROCESS_UNCONFIRMED', '须明确确认旧执行已退出')
      if (input.owner === 'collaboration') return reconcileRun(input.run_id, input)
      resources.reconcile(input.owner, input.run_id)
      changed(); return { reconciled: true }
    },
    async submit(id, input) {
      const context = store.context(id)
      // Validate syntax before resolving paths, then validate again after the asynchronous reads.
      const artifacts = input.artifacts ?? []
      if (!Array.isArray(artifacts) || artifacts.length > 32 || artifacts.some(path => typeof path !== 'string' || !path.trim() || path.includes('\0') || path.length > 2048 || isAbsolute(path) || path.split(/[\\/]/).includes('..'))) throw loopError('LOOP_ARTIFACT_INVALID', '产物须为工作目录内的相对文件路径')
      for (const path of artifacts) await resolveCollaborationArtifact(context.task,path).catch(error=>{throw loopError(error.code==='ENOENT'?'LOOP_ARTIFACT_MISSING':error.code??'LOOP_ARTIFACT_INVALID',`无法读取产物：${path}`)})
      const value = store.submit(id, input); changed(); return value
    },
    progress(id, input) { const value = store.progress(id, input); changed(); return value },
    requestAction, createTask, control, start, close, copyRoom,
    async createRoom(input) {
      if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120)throw loopError('LOOP_INPUT_INVALID','请输入团队名称')
      const workspaces=input.workspaces!==undefined ? await canonicalWorkspaces(input.workspaces) : input.workspace ? [await canonicalWorkspace(input.workspace)] : []
      if(input.request_key!==undefined&&(typeof input.request_key!=='string'||!input.request_key.trim()||input.request_key.length>128))throw loopError('LOOP_INPUT_INVALID','创建请求标识无效')
      const existing=input.request_key?store.roomForRequest(input.request_key):null
      if(existing){
        const configured=existing.config
        if(existing.title!==input.title.trim()||JSON.stringify(configured.workspaces)!==JSON.stringify(workspaces)||input.memory_directory&&await realpath(input.memory_directory)!==configured.memory_directory)throw loopError('LOOP_IDEMPOTENCY_CONFLICT','创建请求标识已用于不同团队配置',409)
        return store.room(existing.id)
      }
      const id=randomUUID()
      const memory_directory=input.memory_directory||memoryRoot&&join(memoryRoot,id)||null
      const directory=memory_directory?await store.memory.bind(memory_directory,id):null

      const initial_member={ name: 'Leader', runtime_id: 'codex', instructions: 'Lead this room from the user’s request to a verified delivery. Delegate concrete work, reconcile results, identify blockers and communicate progress.', profile: { id:'builtin:leader', name:'Leader', source: { kind: 'builtin', label: 'Rillo Leader' }, description: '承接目标、分派成员、跟进进度与交付' } }
      const value=store.createRoom({...input,id,memory_directory:directory,workspace:workspaces[0]??null,workspaces,initial_member})
      changed();return store.room(value.id)
    },
    async deleteRoom(id){if(store.room(id).config?.deleted_at)return store.room(id);await dissolveRoom(id);const value=store.hideRoom(id);changed();return value},
    dissolveRoom,
    async updateMember(roomId,id,input){
      const member=store.room(roomId).members.find(value=>value.id===id)
      if(!member)throw loopError('LOOP_NOT_FOUND','成员不存在',404)
      const changedModel=input.model!==undefined&&input.model!==(member.execution_config?.model??null),changedEffort=input.effort!==undefined&&input.effort!==(member.execution_config?.effort??null)
      const configuration=changedModel||changedEffort?memberConfiguration({model:input.model===undefined?member.execution_config?.model:input.model,effort:input.effort===undefined?member.execution_config?.effort:input.effort},await memberRuntime(member.runtime_id)):member.execution_config
      const value=store.updateMember(roomId,id,{...input,execution_config:configuration,avatar:memberAvatar(input.avatar)})
      changed();return value
    },
    async attachment(roomId,input){store.room(roomId);return (await readRoomAttachment(input)).attachment},
    async attachmentContent(roomId,messageId,index){
      const message=store.room(roomId).messages.find(value=>value.id===messageId),attachment=message?.attachments?.[index]
      if(!attachment)throw loopError('LOOP_NOT_FOUND','附件不存在',404)
      return readRoomAttachment(attachment,{extract:false})
    },
    async retryDefinitionDeletion(roomId){await recoverDefinitionDeletions(roomId);changed();return store.room(roomId)},
    async memberDeletion(roomId,id){
      const room=store.room(roomId),member=room.members.find(value=>value.id===id)
      if(!member)throw loopError('LOOP_NOT_FOUND','成员不存在',404)
      const files=await catalog.deletionFiles(member.profile?.id)
      return {member_id:id,files,other_rooms:store.rooms().filter(value=>value.id!==roomId).filter(value=>store.room(value.id).members.some(other=>other.profile?.id===member.profile?.id)).length}
    },
    async deleteMember(roomId,id,input){
      if(input.confirm!==true)throw loopError('LOOP_DELETE_CONFIRM_REQUIRED','请确认删除成员及本地定义')
      const member=store.room(roomId).members.find(value=>value.id===id)
      if(!member)return {deleted:true,member_id:id}
      if(store.room(roomId).definition_deletions.length)throw loopError('LOOP_DEFINITION_DELETE_PENDING','请先重试当前团队未完成的定义清理',409)
      const files=await catalog.deletionFiles(member.profile?.id)
      if(JSON.stringify(files)!==JSON.stringify(input.files))throw loopError('LOOP_DEFINITION_CHANGED','定义文件已改变，请重新确认删除',409)
      const job=randomUUID(),staged=files.map(file=>({...file,staged:file.path+'.rillo-delete-'+job}))
      store.database.prepare("INSERT INTO loop_definition_deletions VALUES(?,?,?,?,'staging')").run(job,roomId,id,JSON.stringify(staged))
      let committed=false
      try{await catalog.stageDeletion(staged);const value=store.removeMember(roomId,id);committed=true;changed();return value}
      finally{try{await catalog.finishDeletion(staged,committed);store.database.prepare('DELETE FROM loop_definition_deletions WHERE id=?').run(job)}catch{store.database.prepare("UPDATE loop_definition_deletions SET state='blocked' WHERE id=?").run(job);throw loopError('LOOP_DEFINITION_DELETE_PENDING','定义文件清理未完成，请检查文件权限后在团队重试清理',409)}finally{changed()}}
    },
    async addMember(id, input) {
      if(store.room(id).config?.dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散',409)
      const status = await memberRuntime(input.runtime_id)
      if (status.state!=='ready') throw loopError('LOOP_RUNTIME_UNAVAILABLE','所选客户端不可用，请检查本机安装',503)
      const execution_config=memberConfiguration(input,status),avatar=memberAvatar(input.avatar)
      let value = {...input,execution_config,avatar}
      if (input.definition_id) {
        if (!input.definition_id.startsWith('local:')) throw loopError('AGENT_LOCAL_REQUIRED','请先将市场角色添加到本地')
        const profile = await catalog.get(input.definition_id, input.runtime_id)
        value = { name: input.name || profile.name, runtime_id: input.runtime_id, instructions: profile.instructions, profile, execution_config,avatar }
      }
      const member = store.addMember(id, value); changed(); return member
    },
    postMessage: postConversationMessage,
  })
}
