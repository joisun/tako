import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

const exec = promisify(execFile)
export async function prepareCollaborationWorkspace({workspace,requestKey,executionMode='isolated',branch:requestedBranch=null}) {
  workspace=await realpath(workspace)
  const git=async(args,cwd=workspace)=>(await exec('git',args,{cwd,timeout:15000,maxBuffer:1024*1024,encoding:'utf8',shell:false})).stdout.trim()
  const invalid=(code,message)=>Object.assign(new Error(message),{code,statusCode:409})
  let root
  try{root=await realpath(await git(['rev-parse','--show-toplevel']))}catch{
    if(executionMode!=='in_place'||requestedBranch)throw invalid('LOOP_GIT_REQUIRED','此执行方式需要 Git 项目；非 Git 目录须明确使用原目录执行')
    return{workspace,source_workspace:workspace,branch:null,execution_mode:executionMode,requested_branch:null,base_commit:null,dirty:null}
  }
  if(requestedBranch&&(typeof requestedBranch!=='string'||requestedBranch.length>255||requestedBranch.startsWith('-')||/[\0\r\n]/.test(requestedBranch)))throw invalid('LOOP_BRANCH_INVALID','分支或起点引用无效')
  const common=await realpath(await git(['rev-parse','--path-format=absolute','--git-common-dir']))
  async function result(directory,branch) {
    const actual=await realpath(directory).catch(()=>{throw invalid('LOOP_WORKSPACE_UNAVAILABLE','已登记的工作区不存在或无法访问，不会强制重建')}),target=join(actual,relative(root,workspace))
    if(await realpath(await git(['rev-parse','--path-format=absolute','--git-common-dir'],actual))!==common)throw invalid('LOOP_WORKTREE_CONFLICT','所选目录不再属于原 Git 仓库')
    const checkedOut=await git(['symbolic-ref','--quiet','--short','HEAD'],actual).catch(()=>null)
    if(checkedOut!==branch)throw invalid('LOOP_BRANCH_MISMATCH','目录当前分支已改变，请重新核对')
    if(!(await stat(target).catch(()=>null))?.isDirectory())throw invalid('LOOP_WORKSPACE_UNAVAILABLE','项目子目录不在所选工作区，请选择该分支中存在的项目目录')
    return{workspace:target,source_workspace:workspace,branch,execution_mode:executionMode,requested_branch:requestedBranch,
      git_directory:await realpath(await git(['rev-parse','--absolute-git-dir'],actual)),project_relative_path:relative(root,workspace),
      base_commit:await git(['rev-parse','HEAD'],actual),dirty:!!await git(['status','--porcelain=v1','--untracked-files=all'],actual)}
  }
  if(executionMode==='in_place') {
    const branch=await git(['symbolic-ref','--quiet','--short','HEAD']).catch(()=>null)
    if(requestedBranch&&branch!==requestedBranch)throw invalid('LOOP_BRANCH_MISMATCH','原目录当前分支与指定分支不同；不会自动切换分支')
    return result(root,branch)
  }
  const inventory=(await git(['worktree','list','--porcelain'])).split('\n\n').map(block=>Object.fromEntries(block.split('\n').map(line=>{const i=line.indexOf(' ');return i<0?[line,true]:[line.slice(0,i),line.slice(i+1)]})))
  const suffix=createHash('sha256').update(requestKey).digest('hex').slice(0,16)
  const worktree=join(root,'.worktree',`tako-loop-${suffix}`)
  async function ensureParent(){
    await mkdir(join(root,'.worktree'),{recursive:true})
    if(await realpath(join(root,'.worktree'))!==resolve(root,'.worktree'))throw invalid('LOOP_WORKTREE_UNSAFE','worktree 父目录不能是符号链接')
  }
  if(executionMode==='existing_branch') {
    if(!requestedBranch)throw invalid('LOOP_BRANCH_REQUIRED','继续已有分支时须指定本地分支')
    await git(['check-ref-format','--branch',requestedBranch]).catch(()=>{throw invalid('LOOP_BRANCH_INVALID','本地分支名无效')})
    await git(['show-ref','--verify',`refs/heads/${requestedBranch}`]).catch(()=>{throw invalid('LOOP_BRANCH_NOT_FOUND','指定本地分支不存在；不会改用 HEAD 或自动拉取远端')})
    const assigned=inventory.find(item=>item.branch===`refs/heads/${requestedBranch}`)
    if(assigned)return result(assigned.worktree,requestedBranch)
    if(inventory.some(item=>item.worktree===worktree))throw invalid('LOOP_WORKTREE_CONFLICT','目标 worktree 已属于其他分支')
    await ensureParent();await git(['worktree','add',worktree,requestedBranch])
    return result(worktree,requestedBranch)
  }
  if(executionMode!=='isolated')throw invalid('LOOP_EXECUTION_MODE_INVALID','项目执行方式无效')
  const branch=`tako/loop-${suffix}`,assigned=inventory.find(item=>item.worktree===worktree||item.branch===`refs/heads/${branch}`)
  if(assigned&&(assigned.worktree!==worktree||assigned.branch!==`refs/heads/${branch}`))throw invalid('LOOP_WORKTREE_CONFLICT','协作分支或 worktree 已分配给其他路径')
  const start=requestedBranch??'HEAD'
  const commit=await git(['rev-parse','--verify','--end-of-options',`${start}^{commit}`]).catch(()=>{throw invalid('LOOP_BRANCH_NOT_FOUND','所选起点引用不存在；不会改用 HEAD')})
  if(!assigned){await ensureParent();await git(['worktree','add','-b',branch,worktree,commit])}
  return result(worktree,branch)
}

export async function refreshCollaborationWorkspace(resource) {
  const git=async(args,cwd)=>(await exec('git',args,{cwd,timeout:15000,maxBuffer:1024*1024,encoding:'utf8',shell:false})).stdout.trim()
  let directory=resource.workspace
  if(resource.git_directory){
    const pointer=await readFile(join(resource.git_directory,'gitdir'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
    if(pointer)directory=dirname(pointer.trim())
  }
  let root
  try{root=await realpath(await git(['rev-parse','--show-toplevel'],directory))}catch(error){
    if(resource.git_directory)throw error
    return resource
  }
  const gitDirectory=await realpath(await git(['rev-parse','--absolute-git-dir'],root))
  if(resource.git_directory&&gitDirectory!==resource.git_directory)throw Object.assign(new Error('工作区已不再属于原 Git worktree'),{code:'LOOP_WORKTREE_CONFLICT',statusCode:409})
  const projectPath=resource.project_relative_path??relative(root,directory)
  const workspace=await realpath(join(root,projectPath))
  const branch=await git(['symbolic-ref','--quiet','--short','HEAD'],root).catch(()=>null)
  return{...resource,workspace,branch,git_directory:gitDirectory,project_relative_path:projectPath,
    ...(resource.execution_mode==='existing_branch'?{requested_branch:branch}:{})}
}

export async function prepareConversationWorkspace({workspaceRoot,roomId,requestKey}) {
  if(!isAbsolute(workspaceRoot??''))throw Object.assign(new Error('服务内部执行目录尚未初始化'),{code:'LOOP_INTERNAL_WORKSPACE_UNAVAILABLE',statusCode:503})
  await mkdir(workspaceRoot,{recursive:true,mode:0o700})
  const root=await realpath(workspaceRoot),name=createHash('sha256').update(`${roomId}:${requestKey}`).digest('hex').slice(0,32),workspace=join(root,name)
  await mkdir(workspace,{recursive:true,mode:0o700})
  if(await realpath(workspace)!==workspace)throw Object.assign(new Error('内部执行目录不能指向其他位置'),{code:'LOOP_WORKSPACE_UNSAFE',statusCode:400})
  return{workspace,resources:[],branch:null}
}
