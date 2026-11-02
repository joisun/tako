import { realpath, stat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep, join } from 'node:path'

export async function resolveCollaborationArtifact(task,reference) {
  const match=/^project:([1-8])\/(.+)$/.exec(reference)
  const resources=task.config.resources??[{workspace:task.workspace}],index=match?Number(match[1])-1:0,path=match?match[2]:reference
  if(!path||isAbsolute(path)||path.includes('\0')||path.split(/[\\/]/).includes('..')||match&&!resources[index])throw Object.assign(new Error('产物项目或相对路径无效'),{code:'LOOP_ARTIFACT_INVALID',statusCode:400})
  const root=await realpath(match?resources[index].workspace:task.workspace),canonical=await realpath(resolve(root,path)),child=relative(root,canonical)
  if(!child||isAbsolute(child)||child==='..'||child.startsWith(`..${sep}`)||!(await stat(canonical)).isFile())throw Object.assign(new Error('产物必须位于对应项目 worktree 内'),{code:'LOOP_ARTIFACT_INVALID',statusCode:400})
  return canonical
}

import{createHash,randomUUID}from'node:crypto'
import{createReadStream,createWriteStream}from'node:fs'
import{Transform}from'node:stream'
import{pipeline}from'node:stream/promises'

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
    const task=data.loop_tasks.find(value=>value.id===run.task_id),submission=JSON.parse(run.submission_json??'null')
    for(const reference of submission?.artifacts??[]){
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
