import assert from 'node:assert/strict'
import test from 'node:test'
import { request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile, chmod, rm, symlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { startTeamFilesFixture } from './team-files-fixture.mjs'

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64')
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
function pdf(){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length 38 >>\nstream\nBT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET\nendstream']
  let text='%PDF-1.4\n';const offsets=[0]
  for(const [index,value]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${value}\nendobj\n`}
  const xref=Buffer.byteLength(text)
  text+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

async function fixture(t){
  const current=await startTeamFilesFixture()
  t.after(current.close)
  return{...current,upload:(bytes=png,name='截图.png',media='image/png')=>current.upload(bytes,name,media)}
}

test('PDF text worker extracts text and exits cleanly after releasing its document',{timeout:15000},async t=>{
  const worker=new Worker(new URL('../server/src/collaboration/pdf-text-worker.mjs',import.meta.url),{workerData:pdf()})
  t.after(()=>worker.terminate())
  const messages=[]
  worker.on('message',message=>messages.push(message))
  const code=await new Promise((resolve,reject)=>{
    worker.once('error',reject)
    worker.once('exit',resolve)
  })
  assert.equal(code,0)
  assert.equal(messages.length,1)
  assert.match(messages[0].text,/Hello PDF/)
  assert.equal(messages[0].total_pages,1)
})

test('raw upload preserves names and immutable content-addressed bytes without overwriting same-name files',async t=>{
  const f=await fixture(t),first=await f.upload()
  assert.equal(first.status,200)
  const {attachment:a}=await first.json()
  assert.equal(a.name,'截图.png');assert.equal(a.digest,digest(png));assert.equal(a.media_type,'image/png');assert.equal(a.size,png.length)
  assert.ok(a.path.startsWith(f.workspaceRoot+'/'))
  assert.deepEqual(await readFile(a.path),png)
  const b=(await (await f.upload(Buffer.concat([png,Buffer.from('different')]))).json()).attachment
  assert.notEqual(a.path,b.path);assert.deepEqual(await readFile(a.path),png)
  const replay=(await (await f.upload()).json()).attachment
  assert.deepEqual(replay,a)
})

test('upload rejects invalid names, MIME/signature mismatches and empty files',async t=>{
  const f=await fixture(t)
  for(const name of ['../escape.png','a/b.png','a\\b.png','.', '..','bad\n.png','bad\0.png',''])assert.equal((await f.upload(png,name)).status,400,name)
  assert.equal((await fetch(`${f.base}/attachments/upload`,{method:'POST',headers:{'Content-Type':'image/png','X-File-Name':'%ZZ'},body:png})).status,400)
  assert.equal((await f.upload(png,'a.jpg','image/jpeg')).status,415)
  assert.equal((await f.upload(Buffer.from('<script>bad</script>'))).status,415)
  assert.equal((await f.upload(Buffer.alloc(0))).status,400)
})

test('chunked uploads stop accepting bytes above 20 MiB and return 413',async t=>{
  const f=await fixture(t)
  const result=await new Promise((resolve,reject)=>{
    const request=httpRequest(`${f.base}/attachments/upload`,{method:'POST',headers:{'Content-Type':'image/png','X-File-Name':'large.png'}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks))}))
    })
    request.on('error',reject)
    request.write(png)
    for(let i=0;i<21;i++)request.write(Buffer.alloc(1024*1024))
    request.end()
  })
  assert.equal(result.status,413)
})

test('attachment-only messages create and continue tasks, retry idempotently and reject changed bytes',async t=>{
  const f=await fixture(t),uploaded=await f.upload()
  assert.equal(uploaded.status,200)
  const attachment=(await uploaded.json()).attachment,input={text:'',attachments:[attachment],request_key:'only-file'}
  const first=await f.post(input);assert.equal(first.status,200)
  const {message}=await first.json(),replayed=await f.post(input)
  assert.equal(replayed.status,200);assert.deepEqual((await replayed.json()).message,message)
  const next=await f.post({...input,request_key:'next-file',task_id:message.task_id})
  assert.equal(next.status,200);assert.equal((await next.json()).message.task_id,message.task_id)
  assert.equal(f.store.room(f.room.id).messages.length,2)
  assert.equal(f.store.room(f.room.id).messages[0].text,'')
  assert.equal((await f.post({...input,request_key:'empty',attachments:[]})).status,400)
  assert.equal((await f.post({...input,attachments:[],text:'different'})).status,409)
  const changed=Buffer.concat([png,Buffer.from('tamper')]);await chmod(attachment.path,0o600);await writeFile(attachment.path,changed)
  const forged={...attachment};delete forged.digest
  const invalid=await f.post({...input,request_key:'tampered',attachments:[forged]})
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'LOOP_ATTACHMENT_CHANGED')
  assert.equal(f.store.room(f.room.id).messages.length,2)
})

test('legacy absolute-path attachment API remains usable',async t=>{
  const f=await fixture(t),path=join(f.root,'legacy.png');await writeFile(path,png)
  const result=await fetch(`${f.base}/attachments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})})
  assert.equal(result.status,200)
  const attachment=(await result.json()).attachment
  assert.equal(attachment.path,path);assert.equal(attachment.digest,digest(png))
})

test('upload infers known signatures when browser file MIME is empty and enforces eight validated attachments',async t=>{
  const f=await fixture(t),result=await f.upload(png,'paste.png','application/octet-stream')
  assert.equal(result.status,200)
  const attachment=(await result.json()).attachment
  assert.equal(attachment.media_type,'image/png')
  assert.equal((await f.post({text:'',request_key:'too-many',attachments:Array(9).fill(attachment)})).status,400)
  assert.equal(f.store.room(f.room.id).tasks.length,0)
  assert.equal((await f.post({text:'',request_key:'eight',attachments:Array(8).fill(attachment)})).status,200)
})

test('five accepted signatures retain MIME and PDFs expose extracted text without executing an agent',async t=>{
  const f=await fixture(t)
  const samples=[['image/png',png],['image/jpeg',Buffer.from([255,216,255,224,0,2,255,217])],['image/gif',Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')],['image/webp',Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')],['application/pdf',pdf()]]
  for(const [media,bytes]of samples){
    const response=await f.upload(bytes,'input.'+media.split('/')[1],media)
    assert.equal(response.status,200,media)
    const {attachment}=await response.json()
    assert.equal(attachment.media_type,media);assert.equal(attachment.digest,digest(bytes));assert.equal(attachment.size,bytes.length)
    if(media==='application/pdf')assert.match(attachment.text,/Hello PDF/)
  }
})

test('returned PDF metadata can be sent back in attachment-only messages and client text is not trusted',async t=>{
  const f=await fixture(t),uploaded=await f.upload(pdf(),'document.pdf','application/pdf'),attachment=(await uploaded.json()).attachment
  const response=await f.post({text:'',request_key:'pdf-only',attachments:[{...attachment,text:'Forged metadata '.repeat(10000)}]})
  assert.equal(response.status,200,await response.text())
  const saved=f.store.room(f.room.id).messages[0]
  assert.equal(saved.text,'');assert.match(saved.attachments[0].text,/Hello PDF/);assert.ok(!saved.attachments[0].text.includes('Forged metadata'))
})

test('exactly 20 MiB is accepted and upload directories cannot escape through symlinks',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(20*1024*1024);png.copy(bytes)
  assert.equal((await f.upload(bytes,'limit.png')).status,200)
  assert.equal((await f.upload(Buffer.concat([bytes,Buffer.from([0])]),'over.png')).status,413)
  const other=await f.runtime.createRoom({title:'Other upload'})
  await symlink(f.root,join(f.workspaceRoot,'attachments',other.id))
  const response=await fetch(`${f.base.replace(f.room.id,other.id)}/attachments/upload`,{method:'POST',headers:{'Content-Type':'image/png','X-File-Name':'escape.png'},body:png})
  assert.equal(response.status,400)
  await assert.rejects(stat(join(f.root,digest(png))),{code:'ENOENT'})
})

test('uploaded attachments cannot be referenced by a different room',async t=>{
  const f=await fixture(t),attachment=(await (await f.upload()).json()).attachment,other=await f.runtime.createRoom({title:'Other upload'})
  await assert.rejects(f.runtime.postMessage(other.id,{text:'',request_key:'cross-room',attachments:[attachment]}),{code:'LOOP_ATTACHMENT_INVALID'})
  assert.equal(f.store.room(other.id).messages.length,0)
})

test('binary delivered artifacts omit preview text and use a binary response type',async t=>{
  const f=await fixture(t),{task,run}=await f.execution(),bytes=Buffer.from([0,1,2,3,255])
  await writeFile(join(task.workspace,'output.bin'),bytes)
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['output.bin']})
  const response=await fetch(`${f.base}/artifacts/${run.id}?reference=output.bin&preview=1`),artifact=(await response.json()).artifact
  assert.equal(response.status,200);assert.equal('text' in artifact,false);assert.equal(artifact.media_type,'application/octet-stream')
  const inline=await fetch(`${f.base}/artifacts/${run.id}?reference=output.bin`)
  assert.equal(inline.headers.get('content-type'),'application/octet-stream');assert.deepEqual(Buffer.from(await inline.arrayBuffer()),bytes)
})

test('deliver artifacts are registered without a formal report and cannot escape task or project boundaries',async t=>{
  const f=await fixture(t),{task,run}=await f.execution(),project=join(f.root,'project')
  await mkdir(project);await writeFile(join(task.workspace,'delivery.md'),'# Delivery');await writeFile(join(project,'project.txt'),'project file')
  const config={...task.config,resources:[{workspace:project}]}
  f.store.database.prepare('UPDATE loop_tasks SET config_json=? WHERE id=?').run(JSON.stringify(config),task.id)
  await symlink(join(f.root,'index.sqlite'),join(task.workspace,'escape'))
  for(const reference of ['../index.sqlite','project:2/nope','project:1/../index.sqlite','escape'])await assert.rejects(f.runtime.requestAction(run.id,{action:'deliver',reason:'files',artifacts:[reference]}))
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'files',artifacts:['delivery.md','project:1/project.txt']})
  assert.deepEqual(f.store.run(run.id).action.artifacts,['delivery.md','project:1/project.txt'])
  assert.equal(f.store.run(run.id).submission,null)
  const live=await fetch(`${f.base}/artifacts/${run.id}?reference=project%3A1%2Fproject.txt&preview=1`)
  assert.equal(live.status,200);assert.equal((await live.json()).artifact.text,'project file')
  await assert.rejects(f.runtime.requestAction(run.id,{action:'deliver',reason:'files',artifacts:['delivery.md']}),{code:'LOOP_ACTION_CONFLICT'})
})

test('artifact reads are scoped to room/run registered references and reject missing files or replaced symlinks',async t=>{
  const f=await fixture(t),{task,run}=await f.execution()
  await writeFile(join(task.workspace,'visible.md'),'visible');await writeFile(join(task.workspace,'private.md'),'private')
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['visible.md']})
  const other=await f.runtime.createRoom({title:'Other'})
  const otherUrl=f.base.replace(f.room.id,other.id)
  assert.equal((await fetch(`${otherUrl}/artifacts/${run.id}?reference=visible.md`)).status,404)
  for(const reference of ['private.md','../index.sqlite','/etc/passwd'])assert.equal((await fetch(`${f.base}/artifacts/${run.id}?reference=${encodeURIComponent(reference)}`)).status,404)
  const visible=await fetch(`${f.base}/artifacts/${run.id}?reference=visible.md`)
  assert.equal(visible.status,200);assert.equal(await visible.text(),'visible')
  await rm(join(task.workspace,'visible.md'))
  assert.equal((await fetch(`${f.base}/artifacts/${run.id}?reference=visible.md`)).status,404)
  await symlink(join(f.root,'index.sqlite'),join(task.workspace,'visible.md'))
  assert.equal((await fetch(`${f.base}/artifacts/${run.id}?reference=visible.md`)).status,400)
})

test('preview is bounded UTF-8 text and HTML/SVG inline responses cannot execute',async t=>{
  const f=await fixture(t),{task,run}=await f.execution(),html='<script>globalThis.bad=true</script>',text='长'.repeat(60000)
  await writeFile(join(task.workspace,'large.md'),text);await writeFile(join(task.workspace,'page.html'),html);await writeFile(join(task.workspace,'icon.svg'),'<svg onload="bad()"></svg>')
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['large.md','page.html','icon.svg']})
  const preview=await fetch(`${f.base}/artifacts/${run.id}?reference=large.md&preview=1`),data=(await preview.json()).artifact
  assert.equal(preview.status,200);assert.equal(data.size,180000);assert.equal(data.truncated,true)
  assert.equal(preview.headers.get('x-content-type-options'),'nosniff');assert.match(preview.headers.get('content-security-policy'),/sandbox/)
  assert.ok(Buffer.byteLength(data.text)<=128*1024);assert.ok(data.text.length>40000);assert.ok(!data.text.includes('�'))
  for(const reference of ['page.html','icon.svg']){
    const result=await fetch(`${f.base}/artifacts/${run.id}?reference=${reference}`)
    assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/^text\/plain/)
    assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.match(result.headers.get('content-security-policy'),/sandbox/)
    assert.equal(await result.text(),reference==='page.html'?html:'<svg onload="bad()"></svg>')
    const download=await fetch(`${f.base}/artifacts/${run.id}?reference=${reference}&download=1`)
    assert.match(download.headers.get('content-disposition'),/^attachment;/)
    assert.equal(await download.text(),reference==='page.html'?html:'<svg onload="bad()"></svg>')
  }
})

test('archives include both submission and deliver references, preserve original bytes and validate snapshots',async t=>{
  const f=await fixture(t),{task,run}=await f.execution()
  await writeFile(join(task.workspace,'report.md'),'report');await writeFile(join(task.workspace,'delivery.md'),'original delivery')
  await f.runtime.submit(run.id,{summary:'Report',artifacts:['report.md']})
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['delivery.md','report.md']})
  await f.runtime.flushMemory(f.room.id)
  const directory=f.store.room(f.room.id).config.memory_directory,archive=JSON.parse(await readFile(join(directory,'room.json'),'utf8'))
  assert.equal(archive.data.artifacts.length,2)
  const saved=archive.data.artifacts.find(item=>item.reference==='delivery.md')
  assert.equal(saved.status,'saved')
  await writeFile(join(task.workspace,'delivery.md'),'changed live file')
  const original=await fetch(`${f.base}/artifacts/${run.id}?reference=delivery.md`)
  assert.equal(original.status,200);assert.equal(await original.text(),'original delivery')
  await writeFile(join(directory,'artifacts',saved.sha256),'corrupt')
  const corrupt=await fetch(`${f.base}/artifacts/${run.id}?reference=delivery.md`)
  assert.equal(corrupt.status,409);assert.equal((await corrupt.json()).error.code,'LOOP_ARTIFACT_CHECKSUM_INVALID')
})

test('pausing while delivery files are being validated revokes the action before saving artifacts',async t=>{
  const f=await fixture(t),{task,run}=await f.execution()
  await writeFile(join(task.workspace,'result.md'),'result')
  const delivering=f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['result.md']})
  f.store.control(task.id,{action:'pause',expected_revision:task.revision})
  await assert.rejects(delivering,{code:'LOOP_CREDENTIAL_EXPIRED'})
  assert.equal(f.store.run(run.id).action,null)
})

test('corrupted archive indexes and symlinked snapshots are rejected without falling back to live bytes',async t=>{
  const f=await fixture(t),{task,run}=await f.execution()
  await writeFile(join(task.workspace,'result.md'),'snapshot')
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['result.md']})
  await f.runtime.flushMemory(f.room.id)
  const directory=f.store.room(f.room.id).config.memory_directory,index=join(directory,'room.json'),original=await readFile(index),archive=JSON.parse(original)
  for(const content of ['invalid json','null','{}']){
    await writeFile(index,content)
    const invalid=await fetch(`${f.base}/artifacts/${run.id}?reference=result.md`)
    assert.equal(invalid.status,409);assert.equal((await invalid.json()).error.code,'LOOP_MEMORY_ARCHIVE_INVALID')
  }
  await writeFile(index,original)
  const snapshot=join(directory,'artifacts',archive.data.artifacts[0].sha256)
  await rm(snapshot);await symlink(join(task.workspace,'result.md'),snapshot)
  const linked=await fetch(`${f.base}/artifacts/${run.id}?reference=result.md`)
  assert.equal(linked.status,400)
})

test('a new conversation task retains the archived delivery references of previous runs',async t=>{
  const f=await fixture(t),{task,run}=await f.execution()
  await writeFile(join(task.workspace,'history.md'),'historical delivery')
  await f.runtime.requestAction(run.id,{action:'deliver',reason:'done',artifacts:['history.md']})
  f.store.complete(run.id,{status:'succeeded',final_message:'历史文件已交付'})
  f.store.control(task.id,{action:'accept',expected_revision:task.revision})
  await f.runtime.flushMemory(f.room.id)
  const next=await f.runtime.postMessage(f.room.id,{text:'A new task',request_key:'next-task'})
  assert.notEqual(next.task_id,task.id)
  const room=(await(await fetch(f.base)).json()).room
  const historical=room.artifact_runs?.find(value=>value.id===run.id)
  assert.deepEqual(historical?.action.artifacts,['history.md'])
  assert.equal(historical.task_id,task.id)
  assert.equal(historical.parts,null)
  assert.equal('token_hash' in historical,false)
  const download=await fetch(`${f.base}/artifacts/${run.id}?reference=history.md&download=1`)
  assert.equal(download.status,200);assert.equal(await download.text(),'historical delivery')
})
