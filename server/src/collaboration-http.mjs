import { readJson, sendJson } from './http-utils.mjs'

export async function handleCollaborationRequest({ request, response, url, collaboration, guidedTeams }) {
  if (!collaboration) return false
  const pathname = url.pathname.replace(/^\/api\/v1\/teams(?=\/|$|-runtime)/,'/api/v1/rooms')
  if (!pathname.startsWith('/api/v1/rooms') && !pathname.startsWith('/api/v1/loop-') && !pathname.startsWith('/api/v1/execution-resources') && !pathname.startsWith('/api/v1/agent-catalog')) return false
  const send = async value => {
    if(request.method!=='GET'&&collaboration.flushMemory){
      const roomPath=pathname.match(/^\/api\/v1\/rooms\/([a-f0-9-]{36})(?:\/|$)/),runPath=pathname.match(/^\/api\/v1\/loop-runs\/([a-f0-9-]{36})(?:\/|$)/)
      const roomId=value?.room?.id??value?.task?.room_id??value?.member?.room_id??roomPath?.[1]??(runPath?collaboration.detail(collaboration.run(runPath[1]).task_id).room_id:null)
      if(roomId){
        void collaboration.flushMemory(roomId).catch(error=>{console.error('TAKO room backup pending:',error.code)})
        if(value?.room)value={...value,room:collaboration.room(roomId)}
      }
    }
    sendJson(response,200,value);return true
  }
  const body = async (limit = 48 * 1024) => {
    if (!String(request.headers['content-type']).toLowerCase().startsWith('application/json')) throw Object.assign(new Error('需要 JSON 请求'), { code: 'CONTENT_TYPE_REQUIRED', statusCode: 415 })
    const input = await readJson(request, { limit })
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('请求内容须为对象'), { code: 'LOOP_INPUT_INVALID', statusCode: 400 })
    return input
  }
  const plannerTool=pathname.match(/^\/api\/v1\/rooms\/guided-plans\/([a-f0-9-]{36})\/tools\/(search_agents|get_agent_definition)$/)
  if(plannerTool&&request.method==='POST'&&guidedTeams)return send(await guidedTeams.tool(plannerTool[1],plannerTool[2],await body(),String(request.headers.authorization??'').replace(/^Bearer /,'')))
  const guided=pathname.match(/^\/api\/v1\/rooms\/guided-plans(?:\/([a-f0-9-]{36})(?:\/(cancel|create|refine))?)?$/)
  if(guided){
    if(!guidedTeams)throw Object.assign(new Error('引导式创建尚未就绪'),{code:'GUIDED_UNAVAILABLE',statusCode:503})
    if(!guided[1]&&request.method==='POST')return send({plan:guidedTeams.start(await body())})
    if(guided[1]&&!guided[2]&&request.method==='GET')return send({plan:guidedTeams.get(guided[1])})
    if(guided[2]==='cancel'&&request.method==='POST'){await body();return send({plan:guidedTeams.cancel(guided[1])})}
    if(guided[2]==='create'&&request.method==='POST')return send(await guidedTeams.create(guided[1],await body(1024*1024)))
    if(guided[2]==='refine'&&request.method==='POST')return send({plan:guidedTeams.refine(guided[1],await body(1024*1024))})
  }
  if(pathname==='/api/v1/agent-catalog/sources'&&request.method==='GET')return send(collaboration.catalogSources())
  if (pathname === '/api/v1/agent-catalog' && request.method === 'GET') return send(await collaboration.catalog(url.searchParams.get('source') ?? 'local',{refresh:url.searchParams.get('refresh')==='1'}))
  if (pathname === '/api/v1/agent-catalog/definition' && request.method === 'GET') return send({ definition: await collaboration.agentDefinition(url.searchParams.get('id') ?? '', url.searchParams.get('runtime') ?? 'codex') })
  if (pathname === '/api/v1/agent-catalog/import' && request.method === 'POST') return send(await collaboration.importAgent(await body()))
  if(pathname==='/api/v1/agent-catalog/deletion'&&request.method==='GET')return send(await collaboration.agentDeletion(url.searchParams.get('id')??''))
  if(pathname==='/api/v1/agent-catalog/definition'&&request.method==='DELETE')return send(await collaboration.deleteAgentDefinition(url.searchParams.get('id')??'',await body()))
  const memberRuntime = pathname.match(/^\/api\/v1\/rooms-runtime\/(codex|claude)$/)
  if (memberRuntime && request.method === 'GET') return send(await collaboration.memberRuntime(memberRuntime[1]))
  const remove=pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/delete$/)
  if(remove&&request.method==='POST'){const input=await body();if(input.confirm!==true)throw Object.assign(new Error('请确认从列表删除团队并保留历史'),{code:'LOOP_DELETE_CONFIRM_REQUIRED',statusCode:400});return send({room:await collaboration.deleteRoom(remove[1])})}
  const cleanup=pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/definition-cleanup$/)
  if(cleanup&&request.method==='POST'){await body();return send({room:await collaboration.retryDefinitionDeletion(cleanup[1])})}
  const memory=pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/memory-sync$/)
  if(memory&&request.method==='POST'){await body();await collaboration.flushMemory(memory[1]);return send({room:collaboration.room(memory[1])})}
  const attachment=pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/attachments(?:\/([a-zA-Z0-9-]+)\/(\d+))?$/)
  if(attachment){
    if(!attachment[2]&&request.method==='POST')return send({attachment:await collaboration.attachment(attachment[1],await body())})
    if(attachment[2]&&request.method==='GET'){
      const {attachment:meta,bytes}=await collaboration.attachmentContent(attachment[1],attachment[2],Number(attachment[3]))
      response.writeHead(200,{'Content-Type':meta.media_type,'Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`});response.end(bytes);return true
    }
  }
  const membership=pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/members\/([a-zA-Z0-9-]+)$/)
  if(membership){
    if(request.method==='PATCH')return send({member:await collaboration.updateMember(membership[1],membership[2],await body())})
    if(request.method==='DELETE')return send(await collaboration.removeMember(membership[1],membership[2],await body()))
  }
  const definition = pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/members\/([a-zA-Z0-9-]+)\/definition$/)
  if (definition && request.method === 'GET') return send(await collaboration.memberDefinition(definition[1],definition[2]))
  const board = pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/(board|work-items)(?:\/([a-zA-Z0-9-]+))?$/)
  if (board) {
    if (board[2]==='board' && !board[3] && request.method==='GET') return send({board:collaboration.board(board[1])})
    if (board[2]==='board' && !board[3] && request.method==='PUT') return send({board:collaboration.reorderWorkItems(board[1],await body())})
    if (board[2]==='work-items' && !board[3] && request.method==='POST') return send({board:collaboration.createWorkItem(board[1],await body())})
    if (board[2]==='work-items' && board[3] && request.method==='PATCH') return send({board:collaboration.updateWorkItem(board[1],board[3],await body())})
  }
  if (pathname === '/api/v1/execution-resources' && request.method === 'GET') return send({ resources: collaboration.resourceClaims() })
  if (pathname === '/api/v1/execution-resources/reconcile' && request.method === 'POST') return send(collaboration.reconcileResource(await body()))
  if(pathname==='/api/v1/rooms/restore'&&request.method==='POST')return send({room:await collaboration.restoreRoom(await body())})
  if (pathname === '/api/v1/rooms') {
    if (request.method === 'GET') return send({ rooms: collaboration.rooms() })
    if (request.method === 'POST') return send({ room: await collaboration.createRoom(await body()) })
  }
  const copy = pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)\/copy$/)
  if(copy&&request.method==='POST')return send({room:await collaboration.copyRoom(copy[1],await body())})
  const room = pathname.match(/^\/api\/v1\/rooms\/([a-zA-Z0-9-]+)(?:\/(members|messages|tasks))?$/)
  if (room) {
    if(request.method==='DELETE'&&!room[2]){await body();return send({room:await collaboration.dissolveRoom(room[1])})}
    if (request.method === 'PATCH' && !room[2]) return send({ room: await collaboration.configureRoom(room[1], await body()) })
    if (request.method === 'GET' && !room[2]) return send({ room: collaboration.room(room[1]) })
    if (request.method === 'POST' && room[2] === 'members') return send({ member: await collaboration.addMember(room[1], await body()) })
    if (request.method === 'POST' && room[2] === 'messages') return send({ message: await collaboration.postMessage(room[1], await body()) })
    if (request.method === 'POST' && room[2] === 'tasks') return send({ task: await collaboration.createTask(room[1], await body()) })
  }
  const stream=pathname.match(/^\/api\/v1\/loop-tasks\/([a-zA-Z0-9-]+)\/events$/)
  if(stream&&request.method==='GET'){
    collaboration.detail(stream[1])
    response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'})
    response.flushHeaders?.()
    const unsubscribe=collaboration.subscribeTask(stream[1],event=>{
      if(event.type==='closed'){response.end();return}
      if(response.destroyed||response.writableEnded)return
      if(response.writableLength>512*1024){response.end();return}
      response.write(`id: ${event.sequence}\nevent: team\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat=setInterval(()=>{if(!response.destroyed)response.write(': keepalive\n\n')},15000);heartbeat.unref?.()
    response.once('close',()=>{clearInterval(heartbeat);unsubscribe()})
    return true
  }
  const task = pathname.match(/^\/api\/v1\/loop-tasks\/([a-zA-Z0-9-]+)(?:\/(control|timeline))?$/)
  if (task) {
    if(request.method==='GET'&&task[2]==='timeline')return send({task:await collaboration.taskTimeline(task[1])})
    if (request.method === 'GET' && !task[2]) return send({ task: collaboration.detail(task[1]) })
    if (request.method === 'POST' && task[2]==='control') return send({ task: collaboration.control(task[1], await body()) })
  }
  const reconcile = pathname.match(/^\/api\/v1\/loop-runs\/([a-zA-Z0-9-]+)\/reconcile$/)
  if (reconcile && request.method === 'POST') return send({ run: collaboration.reconcileRun(reconcile[1], await body()) })
  const tool = pathname.match(/^\/api\/v1\/loop-runs\/([a-zA-Z0-9-]+)\/tools\/(read_context|submit_result|request_action|report_progress|send_message|remember)$/)
  if (tool && request.method === 'POST') {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
    collaboration.authenticate(tool[1], token)
    const input = await body()
    // Reading the body can yield; a pause or revision invalidates the credential meanwhile.
    collaboration.authenticate(tool[1], token)
    if (tool[2] === 'remember') return send(collaboration.remember(tool[1],input))
    if (tool[2] === 'send_message') return send(collaboration.sendMessage(tool[1], input))
    if (tool[2] === 'read_context') return send(await collaboration.readContext(tool[1],input))
    if (tool[2] === 'submit_result') return send(await collaboration.submit(tool[1], input))
    if (tool[2] === 'request_action') return send(await collaboration.requestAction(tool[1], input))
    return send(collaboration.progress(tool[1], input.text))
  }
  return false
}
