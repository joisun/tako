import { realpath, stat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep, join, basename } from 'node:path'
import { constants } from 'node:fs'
import { attachmentMediaType } from './collaboration/attachments.mjs'

const PREVIEW_BYTES=128*1024
const artifactError=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode})
function artifactText(bytes,truncated){
  for(let trim=0;trim<=(truncated?3:0)&&trim<=bytes.length;trim++){
    try{
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytes.length-trim))
      return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)?null:text
    }catch{}
  }
  return null
}

export async function resolveCollaborationArtifact(task,reference) {
  if(typeof reference!=='string'||reference.length>2048||!reference.trim())throw artifactError('LOOP_ARTIFACT_INVALID','产物引用无效')
  const match=/^project:([1-8])\/(.+)$/.exec(reference)
  const resources=task.config.resources??[{workspace:task.workspace}],index=match?Number(match[1])-1:0,path=match?match[2]:reference
  if(!path||isAbsolute(path)||path.includes('\0')||path.split(/[\\/]/).includes('..')||reference.startsWith('project:')&&!match||match&&!resources[index])throw Object.assign(new Error('产物项目或相对路径无效'),{code:'LOOP_ARTIFACT_INVALID',statusCode:400})
  const root=await realpath(match?resources[index].workspace:task.workspace),canonical=await realpath(resolve(root,path)),child=relative(root,canonical)
  if(!child||isAbsolute(child)||child==='..'||child.startsWith(`..${sep}`)||!(await stat(canonical)).isFile())throw Object.assign(new Error('产物必须位于对应项目 worktree 内'),{code:'LOOP_ARTIFACT_INVALID',statusCode:400})
  return canonical
}
export async function validateCollaborationArtifacts(task,references){
  if(!Array.isArray(references)||references.length>32||references.some(path=>typeof path!=='string'||!path.trim()||path.length>2048||path.includes('\0')||isAbsolute(path)||path.split(/[\\/]/).includes('..')))throw artifactError('LOOP_ARTIFACT_INVALID','产物须为工作目录内的相对文件路径')
  for(const reference of references)await resolveCollaborationArtifact(task,reference).catch(error=>{throw artifactError(error.code==='ENOENT'?'LOOP_ARTIFACT_MISSING':error.code??'LOOP_ARTIFACT_INVALID',`无法读取产物：${reference}`)})
}

import{createHash,randomUUID}from'node:crypto'
import{createReadStream,createWriteStream}from'node:fs'
import{Transform}from'node:stream'
import{pipeline}from'node:stream/promises'

async function archivedArtifact(directory,task,run,reference){
  if(!directory)return null
  const root=await realpath(directory)
  let file
  try{file=await open(join(root,'room.json'),constants.O_RDONLY|constants.O_NOFOLLOW)}
  catch(error){if(error.code==='ENOENT')return null;if(error.code==='ELOOP')throw artifactError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料索引不能是符号链接',409);throw error}
  let archive
  try{
    const chunks=[];let size=0
    for await(const chunk of file.createReadStream({autoClose:false})){
      size+=chunk.length
      if(size>256*1024*1024)throw artifactError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料超过读取限制',409)
      chunks.push(chunk)
    }
    try{archive=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw artifactError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料索引无法读取',409)}
  }finally{await file.close()}
  if(archive?.data?.loop_rooms?.[0]?.id!==task.room_id||createHash('sha256').update(JSON.stringify(archive.data)).digest('hex')!==archive.sha256)throw artifactError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料归属或校验值无效',409)
  const item=archive.data.artifacts?.find(value=>value.run_id===run.id&&value.task_id===task.id&&value.reference===reference&&value.status==='saved')
  if(!item)return null
  if(!/^[a-f0-9]{64}$/.test(item.sha256))throw artifactError('LOOP_ARTIFACT_CHECKSUM_INVALID','产物快照标识无效',409)
  const path=join(root,'artifacts',item.sha256)
  if(await realpath(path)!==path)throw artifactError('LOOP_ARTIFACT_INVALID','产物快照不能指向其他位置')
  return{path,sha256:item.sha256,size:item.bytes}
}
export async function openCollaborationArtifact(task,run,reference,memoryDirectory){
  let file
  try{
    const snapshot=await archivedArtifact(memoryDirectory,task,run,reference)
    const path=snapshot?.path??await resolveCollaborationArtifact(task,reference)
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    const info=await file.stat()
    if(!info.isFile())throw artifactError('LOOP_ARTIFACT_INVALID','产物须为普通文件')
    if(snapshot){
      const hash=createHash('sha256');let size=0
      for await(const chunk of file.createReadStream({autoClose:false,start:0})){hash.update(chunk);size+=chunk.length}
      if(size!==snapshot.size||hash.digest('hex')!==snapshot.sha256)throw artifactError('LOOP_ARTIFACT_CHECKSUM_INVALID','产物快照已改变，无法读取',409)
    }
    const sample=Buffer.alloc(Math.min(512,info.size)),{bytesRead}=await file.read(sample,0,sample.length,0)
    const bytes=sample.subarray(0,bytesRead)
    const media_type=attachmentMediaType(bytes)??(artifactText(bytes,info.size>bytesRead)===null?'application/octet-stream':'text/plain; charset=utf-8')
    return{handle:file,name:basename(reference),media_type,size:info.size}
  }catch(error){
    await file?.close().catch(()=>{})
    if(error.code==='ENOENT')throw artifactError('LOOP_ARTIFACT_MISSING','产物文件不存在或快照已丢失',404)
    throw error
  }
}
export async function previewCollaborationArtifact(resource){
  const artifact={name:resource.name,media_type:resource.media_type,size:resource.size}
  if(!resource.media_type.startsWith('text/'))return artifact
  const chunk=Buffer.alloc(Math.min(PREVIEW_BYTES,resource.size)),{bytesRead}=await resource.handle.read(chunk,0,chunk.length,0)
  if(bytesRead!==chunk.length)throw artifactError('LOOP_ARTIFACT_CHANGED','产物读取时已改变，请重试',409)
  const text=artifactText(chunk.subarray(0,bytesRead),resource.size>bytesRead)
  return text===null?{...artifact,media_type:'application/octet-stream'}:{...artifact,text,truncated:resource.size>bytesRead}
}

async function save(source,directory,expected=null){
  await mkdir(directory,{recursive:true,mode:0o700})
  const temporary=join(directory,`.${randomUUID()}.tmp`),hash=createHash('sha256');let bytes=0
  try{
    await pipeline(createReadStream(source),new Transform({transform(chunk,encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk)}}),createWriteStream(temporary,{flags:'wx',mode:0o600}))
    const sha256=hash.digest('hex');if(expected&&sha256!==expected)throw Object.assign(new Error('Artifact checksum mismatch'),{code:'LOOP_ARTIFACT_CHECKSUM_INVALID'})
    const file=await open(temporary,'r');try{await file.sync()}finally{await file.close()}
    await rename(temporary,join(directory,sha256));const parent=await open(directory,'r');try{await parent.sync()}finally{await parent.close()}
    return{sha256,bytes}
  }finally{await rm(temporary,{force:true})}
}
export async function archiveRoomArtifacts(data,path){
  const previous=await readFile(join(path,'room.json'),'utf8').then(value=>JSON.parse(value).data.artifacts??[]).catch(()=>[]),artifacts=[]
  for(const run of data.loop_runs){
    const task=data.loop_tasks.find(value=>value.id===run.task_id),submission=JSON.parse(run.submission_json??'null'),action=JSON.parse(run.action_json??'null')
    for(const reference of new Set([...(submission?.artifacts??[]),...(action?.artifacts??[])])){
      const identity={run_id:run.id,task_id:task.id,reference},saved=previous.find(value=>value.run_id===run.id&&value.reference===reference&&value.status==='saved')
      if(saved){artifacts.push(saved);continue}
      try{const source=await resolveCollaborationArtifact({...task,config:JSON.parse(task.config_json)},reference);artifacts.push({...identity,status:'saved',...await save(source,join(path,'artifacts'))})}
      catch(error){artifacts.push({...identity,status:'unavailable',error_code:error.code??'LOOP_ARTIFACT_READ_FAILED'})}
    }
  }
  return artifacts
}
export async function restoreRoomArtifacts(artifacts,source,target){
  for(const item of artifacts??[]){
    if(item.status!=='saved')continue
    if(!/^[a-f0-9]{64}$/.test(item.sha256))throw Object.assign(new Error('产物校验标识无效'),{code:'LOOP_MEMORY_ARCHIVE_INVALID'})
    await save(join(source,'artifacts',item.sha256),join(target,'artifacts'),item.sha256)
  }
}
