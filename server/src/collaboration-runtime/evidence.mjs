import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile,stat } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import { resolveCollaborationArtifact } from '../collaboration-artifacts.mjs'

const exec=promisify(execFile)
const digest=value=>createHash('sha256').update(value).digest('hex')
export async function captureProjectVersions(task) {
  return Promise.all((task.config.resources??[]).map(async(resource,index)=>{
    const git=async args=>(await exec('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:resource.workspace,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024})).stdout
    const started_at=new Date().toISOString()
    try{
      const head=(await git(['rev-parse','HEAD'])).trim()
      const [status,diff]=await Promise.all([git(['status','--porcelain=v1','--untracked-files=all']),git(['diff','HEAD','--binary','--no-ext-diff','--no-textconv'])])
      return{project:index+1,workspace:resource.workspace,started_at,finished_at:new Date().toISOString(),head,head_after:(await git(['rev-parse','HEAD'])).trim(),dirty:!!status.trim(),status_entries:status.split('\n').filter(Boolean).length,status_sha256:digest(status),tracked_diff_sha256:digest(diff),untracked_content_captured:false}
    }catch(error){return{project:index+1,workspace:resource.workspace,started_at,finished_at:new Date().toISOString(),unavailable:true,error_code:error.code??'GIT_SNAPSHOT_UNAVAILABLE'}}
  }))
}
export async function readEvidence(task,reference,{offset=0}={}) {
  if(typeof reference!=='string'||!reference||reference.length>2048)throw Object.assign(new Error('证据须引用任务内相对路径'),{code:'LOOP_INPUT_INVALID'})
  if(!Number.isSafeInteger(offset)||offset<0)throw Object.assign(new Error('证据读取位置无效'),{code:'LOOP_INPUT_INVALID'})
  const path=await resolveCollaborationArtifact(task,reference),before=await stat(path),read_started_at=new Date().toISOString()
  if(before.size>20*1024*1024)throw Object.assign(new Error('证据文本预览最多支持20MB，未声称已读取此文件'),{code:'LOOP_EVIDENCE_TOO_LARGE'})
  const content=await readFile(path),after=await stat(path),text=content.toString('utf8')
  return{id:randomUUID(),reference,sha256:digest(content),bytes:content.length,read_started_at,read_at:new Date().toISOString(),read_consistent:before.size===after.size&&before.mtimeMs===after.mtimeMs,text:text.slice(offset,offset+12000),offset,next_offset:offset+12000<text.length?offset+12000:null}
}
export async function checkEvidence(task,evidence) {
  try{
    const current=await readEvidence(task,evidence.reference)
    return{...evidence,checked_at:current.read_at,current_sha256:current.sha256,state:evidence.read_consistent&&current.read_consistent&&current.sha256===evidence.sha256?'unchanged_since_read':'needs_recheck'}
  }catch(error){return{...evidence,checked_at:new Date().toISOString(),state:'unavailable',error_code:error.code??'LOOP_EVIDENCE_UNAVAILABLE'}}
}
