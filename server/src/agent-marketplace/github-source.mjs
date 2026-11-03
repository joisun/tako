import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {digest,marketError,parseDefinition,sourcePath,MAX_DEFINITION_BYTES} from './definition.mjs'
const execute=promisify(execFile)
const options={timeout:60000,maxBuffer:32*1024*1024,encoding:'buffer',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}
export function validateSource(input){
  const repository=String(input.repository??'').replace(/^https:\/\/github\.com\//,'').replace(/\/$/,'').replace(/\.git$/,'')
  const ref=input.ref??'main'
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)||repository.split('/').some(part=>part==='..'))throw marketError('请输入 GitHub 的 owner/repository')
  if(typeof ref!=='string'||!ref||ref.length>150||ref.startsWith('-')||ref.includes('..')||!/^[-A-Za-z0-9_./]+$/.test(ref))throw marketError('来源分支无效')
  const name=typeof input.name==='string'&&input.name.trim()?input.name.trim():repository
  if(name.length>100)throw marketError('来源名称过长')
  const directories=Array.isArray(input.directories)?input.directories:[]
  if(directories.length>20||directories.some(path=>typeof path!=='string'))throw marketError('最多设置 20 个角色目录')
  for(const path of directories)sourcePath(path)
  return {repository,ref,name,type:'github',directories}
}
export function createGithubSource({root,run=execute}={}){
  const queues=new Map()
  const git=async(directory,args,input)=>{
    try{return (await run('git',['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','core.fsmonitor=false','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','--git-dir='+directory,...args],{...options,...(input?{input}:{})})).stdout}
    catch(error){throw marketError(error.code==='ENOENT'?'本机缺少 Git，无法读取来源':'无法读取 GitHub 来源，请检查网络、仓库或分支后重试',503,'MARKETPLACE_SOURCE_UNAVAILABLE')}
  }
  const directory=source=>join(root,digest(source.id))
  async function fetchCatalog(source){
    if(queues.has(source.id))return queues.get(source.id)
    const operation=(async()=>{
      const dir=directory(source);await mkdir(dir,{recursive:true,mode:0o700})
      await git(dir,['init','--bare','--template='])
      await git(dir,['fetch','--no-tags','--depth=1','--filter=blob:limit=262145','https://github.com/'+source.repository+'.git','refs/heads/'+source.ref])
      const version=(await git(dir,['rev-parse','FETCH_HEAD'])).toString().trim()
      if(!/^[a-f0-9]{40}$/.test(version))throw marketError('来源版本无效',503)
      const updated_at=(await git(dir,['show','-s','--format=%cI',version])).toString().trim()
      const entries=(await git(dir,['ls-tree','-rlz',version])).toString().split('\0').filter(Boolean).map(line=>{const [info,path]=line.split('\t');const [mode,type,oid,size]=info.trim().split(/\s+/);return{mode,type,oid,size:Number(size),path}})
      const licenseFile=entries.find(entry=>entry.type==='blob'&&/^(?:LICENSE|LICENCE)(?:\.md|\.txt)?$/i.test(entry.path)&&entry.size<64000)
      const license_text=licenseFile?(await git(dir,['cat-file','blob',licenseFile.oid])).toString():null
      const license=license_text&&/MIT License|Permission is hereby granted, free of charge/.test(license_text)?'MIT':license_text&&/Apache License/.test(license_text)?'Apache-2.0':license_text?'见来源许可证':null
      const resolved={...source,license,license_text}
      const candidates=entries.filter(entry=>entry.mode==='100644'&&entry.type==='blob'&&/\.md$/i.test(entry.path)&&entry.size>0&&entry.size<=MAX_DEFINITION_BYTES&&!entry.path.split('/').some(part=>['.git','.github','node_modules'].includes(part))&&(!source.directories?.length||source.directories.some(directory=>entry.path.startsWith(directory+'/')))&&!/^(?:(?:readme|contributing)(?:[._-].*)?|agents|skill|changelog|license|security|code_of_conduct)\.md$/i.test(entry.path.split('/').at(-1))&&!/^(?:docs|examples|integrations|scripts|node_modules)\//.test(entry.path))
      if(candidates.reduce((sum,item)=>sum+item.size,0)>32*1024*1024)throw marketError('来源定义总量超过 32MB',400)
      if(candidates.length>1500)throw marketError('来源 Markdown 数量超过 1500，请使用更专注的定义仓库',400)
      const definitions=[],errors=[];let cursor=0
      await Promise.all(Array.from({length:6},async()=>{while(cursor<candidates.length){const entry=candidates[cursor++];try{sourcePath(entry.path);const content=new TextDecoder('utf-8',{fatal:true}).decode(await git(dir,['cat-file','blob',entry.oid]));const definition=parseDefinition(content,{source:resolved,version,path:entry.path,updated_at});if(definition.is_agent_definition)definitions.push(definition)}catch(error){errors.push({path:entry.path,message:error.message})}}}))
      return {source:resolved,version,updated_at,definitions:definitions.sort((a,b)=>a.name.localeCompare(b.name)),errors}
    })()
    queues.set(source.id,operation);try{return await operation}finally{queues.delete(source.id)}
  }
  return {fetchCatalog}
}
