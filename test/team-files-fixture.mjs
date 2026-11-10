import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutionDatabase } from '../server/src/execution-database.mjs'
import { createCollaborationStore } from '../server/src/collaboration/store.mjs'
import { createCollaborationRuntime } from '../server/src/collaboration-runtime.mjs'
import { handleCollaborationRequest } from '../server/src/collaboration-http.mjs'
import { sendError } from '../server/src/http-utils.mjs'

export async function startTeamFilesFixture({seedDelivery=false}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'tako-team-files-'))),workspaceRoot=join(root,'workspaces'),memoryRoot=join(root,'memory')
  const database=createExecutionDatabase(join(root,'index.sqlite')),store=createCollaborationStore({database})
  // Do not start the execution pump. Queued work stays in this temporary database.
  const runtime=createCollaborationRuntime({store,workspaceRoot,memoryRoot,resources:{list:()=>[]},registry:{resolve:async()=>({})},executeAgent:async()=>{throw new Error('No model execution is permitted')},logs:{}})
  const server=createServer(async(request,response)=>{
    try{if(!await handleCollaborationRequest({request,response,url:new URL(request.url,'http://localhost'),collaboration:runtime}))throw Object.assign(new Error('not found'),{statusCode:404,code:'NOT_FOUND'})}
    catch(error){if(response.headersSent)response.destroy(error);else sendError(response,error)}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const room=await runtime.createRoom({title:'隔离文件联调团队'}),origin=`http://127.0.0.1:${server.address().port}`,base=`${origin}/api/v1/teams/${room.id}`
  const upload=(bytes,name='截图.png',media='image/png')=>fetch(`${base}/attachments/upload`,{method:'POST',headers:{'Content-Type':media,'X-File-Name':encodeURIComponent(name)},body:bytes})
  const post=input=>fetch(`${base}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})
  async function execution(){
    const message=await runtime.postMessage(room.id,{text:'Create files',request_key:'start'}),task=store.detail(message.task_id),run=task.runs[0]
    store.claim(run.id,'test-token')
    return{task:store.detail(task.id),run:store.run(run.id)}
  }
  let seeded=null,closed=false
  if(seedDelivery){
    seeded=await execution()
    const project=join(root,'project');await mkdir(project)
    const files={'交付说明.md':'# 文件交付验证\n\n这是隔离临时数据。\n\n- 可预览\n- 可下载\n','源码.html':'<h1>Source only</h1><script>globalThis.fixtureExecuted=true</script>','长文.md':'文件预览内容\n'.repeat(20000)}
    for(const [name,content]of Object.entries(files))await writeFile(join(seeded.task.workspace,name),content)
    await writeFile(join(project,'资源.md'),'# Prepared project output')
    store.database.prepare('UPDATE loop_tasks SET config_json=? WHERE id=?').run(JSON.stringify({...seeded.task.config,resources:[{workspace:project}]}),seeded.task.id)
    await runtime.requestAction(seeded.run.id,{action:'deliver',reason:'临时夹具交付',artifacts:[...Object.keys(files),'project:1/资源.md']})
    store.complete(seeded.run.id,{status:'succeeded',final_message:'文件已交付，可在附件中预览或下载。'})
    await runtime.flushMemory(room.id)
  }
  return{root,workspaceRoot,memoryRoot,room,origin,base,store,runtime,upload,post,execution,seeded,
    async close(){if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();database.close();await rm(root,{recursive:true,force:true})},
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const fixture=await startTeamFilesFixture({seedDelivery:true})
  console.log(JSON.stringify({origin:fixture.origin,room_id:fixture.room.id,task_id:fixture.seeded.task.id,run_id:fixture.seeded.run.id,root:fixture.root}))
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void fixture.close().then(()=>process.exit(0))})
}
