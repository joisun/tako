import {mkdir,readFile,writeFile,rename,rm,lstat,realpath} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createMarketplaceStore} from './store.mjs'
import {createGithubSource,validateSource} from './github-source.mjs'
import {digest,marketError,sourcePath} from './definition.mjs'
import {agentSessionContext,marketplaceRuntimeAdapters} from './runtime-adapters.mjs'
const withoutContent=definition=>{const {content,instructions,responsibilities,workflow,license_text,...summary}=definition;return summary}
export function createAgentMarketplace({database,dataDirectory,adapter,clock=()=>new Date(),onChange=()=>{}}){
  const store=createMarketplaceStore(database),root=join(dataDirectory,'agents','installed'),sourceAdapter=adapter??createGithubSource({root:join(dataDirectory,'agents','catalog-cache')})
  let queue=Promise.resolve();const pending=new Map()
  function serial(action){const next=queue.then(action);queue=next.catch(()=>{});return next}
  const filePath=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw marketError('安装标识无效');return join(root,id,'definition.md')}
  async function ensureRoot(){await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink()||await realpath(root)!==join(await realpath(dataDirectory),'agents','installed'))throw marketError('托管定义目录不能是符号链接',409)}
  async function readLocal(id){
    const path=filePath(id);const parent=await lstat(dirname(path)).catch(error=>{if(error.code==='ENOENT')return null;throw error});if(parent?.isSymbolicLink())throw marketError('托管定义目录已改变',409)
    const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error});if(!info)return null
    if(!info.isFile()||info.size>256*1024)throw marketError('本地定义路径或大小无效',409)
    return readFile(path,'utf8')
  }
  async function recover(){
    await ensureRoot()
    for(const operation of store.operations()){
      try{
        const after=operation.after_json?JSON.parse(operation.after_json):null,path=filePath(operation.id),current=await readLocal(operation.id),hash=current===null?null:digest(current)
        if(operation.action==='uninstall'){
          if(hash!==null&&hash!==operation.before_digest)throw marketError('待卸载文件已改变，已保留本地修改',409)
          if(hash!==null)await rm(path)
        }else if(hash!==after.definition.digest){
          if(hash!==operation.before_digest)throw marketError('定义在操作期间发生变化，已保留本地修改',409)
          await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp'
          try{await writeFile(temp,after.definition.content,{flag:'wx',mode:0o600});const latest=await readLocal(operation.id);if((latest===null?null:digest(latest))!==operation.before_digest)throw marketError('写入前定义已改变，停止替换',409);await rename(temp,path)}finally{await rm(temp,{force:true})}
        }
        store.commit(operation.id,after)
      }catch(error){store.operationError(operation.id,error.message)}
    }
  }
  async function installed(){await recover();return Promise.all(store.installed().map(async row=>{const content=await readLocal(row.id);return {...row,definition:withoutContent(row.definition),local_path:filePath(row.id),local_digest:content===null?null:digest(content),is_modified:content!==null&&digest(content)!==row.definition.digest,is_missing:content===null,operation_error:store.operations().find(op=>op.id===row.id)?.error??null}}))}
  async function refresh(id,{force=false}={}){
    if(pending.has(id))return pending.get(id)
    const source=store.source(id),cached=store.cache(id)
    if(!source.enabled)throw marketError('目录来源已停用',409)
    if(!force&&cached&&Date.parse(cached.checked_at)+10*60*1000>new Date(clock()).getTime())return cached
    const request=(async()=>{
      try{const result=await sourceAdapter.fetchCatalog(source),checked_at=new Date(clock()).toISOString(),seen=new Map(cached?.definitions.map(row=>[row.id,row.first_seen_at])??[]);const value={...result,checked_at,definitions:result.definitions.map(definition=>({...definition,first_seen_at:seen.get(definition.id)??checked_at}))};store.saveCache(id,value,checked_at);return value}
      catch(error){store.error(id,error.message);throw error}
    })();pending.set(id,request);try{return await request}finally{pending.delete(id)}
  }
  async function catalog(id,options={}){
    try{const value=await refresh(id,options);return {...value,definitions:value.definitions.map(withoutContent),source:{...value.source,license_text:undefined},stale:false}}
    catch(error){const cached=store.cache(id);if(!cached)throw error;return {...cached,definitions:cached.definitions.map(withoutContent),source:{...cached.source,license_text:undefined},stale:true,error:error.message}}
  }
  async function definition(sourceId,path,version){
    const catalog=await refresh(sourceId),item=catalog.definitions.find(item=>item.path===path)
    if(!item)throw marketError('目录中没有此定义，请刷新',404)
    if(version&&item.version!==version)throw marketError('目录版本已改变，请重新查看后确认',409)
    return item
  }
  async function mutation(action,input){
    if(input.confirm!==true)throw marketError('请先审核并明确确认操作',400,'MARKETPLACE_CONFIRM_REQUIRED')
    if(action==='install'){if(typeof input.source_id!=='string'||!input.source_id)throw marketError('来源标识无效');sourcePath(input.path)}
    else if(typeof input.id!=='string'||!/^[a-f0-9]{64}$/.test(input.id))throw marketError('安装标识无效')
    if(action!=='uninstall'&&(!/^[a-f0-9]{40}$/.test(input.version??'')||!/^[a-f0-9]{64}$/.test(input.digest??'')))throw marketError('需要审核时的固定版本和内容摘要')
    if(action!=='install'&&input.expected_local_digest!==null&&!/^[a-f0-9]{64}$/.test(input.expected_local_digest??''))throw marketError('需要审核时的本地摘要')
    await recover()
    const previous=action==='install'?null:store.get(input.id),id=previous?.id??digest(input.source_id+':'+input.path)
    if(store.operations().some(op=>op.id===id))throw marketError('此定义存在待处理操作，请先检查本地文件',409)
    if(action==='install'&&store.installed().some(row=>row.id===id))throw marketError('此定义已安装',409)
    const local=await readLocal(id),localHash=local===null?null:digest(local)
    if(action==='install'&&local!==null)throw marketError('目标位置已有文件，不覆盖',409)
    if(previous&&localHash!==input.expected_local_digest)throw marketError('本地文件在审核后发生变化，请重新审核',409,'MARKETPLACE_LOCAL_MODIFIED')
    const modified=previous&&local!==null&&localHash!==previous.definition.digest
    if(modified&&input.preserve_modified!==true)throw marketError('本地定义已修改，请先审核并选择备份后继续',409,'MARKETPLACE_LOCAL_MODIFIED')
    let next=null
    if(action!=='uninstall'){
      const selected=await definition(previous?.source_id??input.source_id,previous?.definition.path??input.path,input.version)
      if(selected.digest!==input.digest)throw marketError('定义内容已改变，请重新审核',409)
      const at=new Date(clock()).toISOString()
      next={id,definition_id:selected.id,source_id:selected.source_id,definition:selected,installed_version:selected.version,installed_at:previous?.installed_at??at,updated_at:at}
    }
    if(modified){const backups=join(dataDirectory,'agents','backups',id);await mkdir(backups,{recursive:true,mode:0o700});const backupPath=join(backups,Date.now()+'-'+localHash+'.md');await writeFile(backupPath,local,{flag:'wx',mode:0o600});if(next)next.local_backup=backupPath}
    store.prepare(id,action,localHash,next);await recover()
    const pendingOperation=store.operations().find(op=>op.id===id);if(pendingOperation)throw marketError(pendingOperation.error??'操作未完成',409)
    onChange({kind:'marketplace'});return {id,action,completed:true}
  }
  async function updates({force=false}={}){
    const rows=await installed(),sources=new Map();await Promise.all([...new Set(rows.map(row=>row.source_id))].map(async id=>{try{sources.set(id,await refresh(id,{force}))}catch(error){sources.set(id,{error:error.message})}}))
    return {updates:rows.map(row=>{const source=sources.get(row.source_id),remote=source.definitions?.find(item=>item.path===row.definition.path);return {id:row.id,name:row.definition.name,source_id:row.source_id,installed_version:row.installed_version,remote_version:remote?.version??null,status:source.error?'unavailable':!remote?'removed':remote.digest!==row.definition.digest?'update_available':'current',is_modified:row.is_modified,is_missing:row.is_missing,error:source.error??null}})}
  }
  return {
    async close(){await Promise.allSettled([...pending.values()]);await queue},
    recover:()=>serial(recover),sources:()=>({sources:store.sources()}),catalog,definition,
    installed:()=>serial(async()=>({installed:await installed()})),
    localDefinition:id=>serial(async()=>{const row=store.get(id);return {installed:row,content:await readLocal(id),local_path:filePath(id)}}),
    install:input=>serial(()=>mutation('install',input)),update:input=>serial(()=>mutation('update',input)),uninstall:input=>serial(()=>mutation('uninstall',input)),
    updates:input=>serial(()=>updates(input)),
    review:id=>serial(async()=>{const row=store.get(id),local=await readLocal(id),remote=await definition(row.source_id,row.definition.path);return{installed:row,base:row.definition.content,local,remote,local_digest:local===null?null:digest(local),is_modified:local!==null&&local!==row.definition.content}}),
    sessionContext:id=>serial(async()=>{const row=store.get(id),local=await readLocal(id);if(local===null||digest(local)!==row.definition.digest)throw marketError('定义已修改或丢失，无法使用已安装快照',409);return agentSessionContext(row)}),
    compatibility:()=>({adapters:marketplaceRuntimeAdapters}),
    teamDefinitions:()=>serial(async()=>{
      const definitions=[],errors=[]
      for(const row of (await installed())){
        if(row.is_modified||row.is_missing||row.operation_error){errors.push({source:row.definition.name,message:'托管定义已修改、丢失或操作未完成，请在 Marketplace 检查'});continue}
        const saved=store.get(row.id),definition={name:row.definition.name,description:row.definition.description,instructions:saved.definition.instructions,model:null,tools:[],skills:[],source:{kind:'managed',label:'Rillo 托管 · '+row.definition.source_name,path:row.local_path,format:'instructions',digest:row.definition.digest,origin:{id:row.definition_id,revision:row.installed_version,url:row.definition.url,license:row.definition.license},license:row.definition.license,revision:row.installed_version}}
        definitions.push({id:'managed:'+row.id,slug:'marketplace-'+row.id,name:definition.name,description:definition.description,runtimes:['codex','claude'],variants:{codex:definition,claude:definition}})
      }
      return{definitions,errors}
    }),
    saveSource:input=>serial(async()=>{if(input.confirm!==true)throw marketError('请确认保存来源');const value=validateSource(input),id=input.id??'github-'+digest(value.repository+':'+value.ref).slice(0,16);if(!input.id&&store.sources().some(row=>row.repository===value.repository&&row.ref===value.ref))throw marketError('此仓库和分支已经添加',409);if(!/^[a-z0-9-]{1,80}$/.test(id))throw marketError('来源标识无效');const existing=store.sources().find(row=>row.id===id);if(existing&&(existing.repository!==value.repository||existing.ref!==value.ref))throw marketError('已有来源不能改为其他仓库，请新增来源',409);if(existing&&JSON.stringify(existing.directories??[])!==JSON.stringify(value.directories))store.clearCache(id);return {source:store.saveSource({...value,id,enabled:input.enabled!==false})}}),
    deleteSource:input=>serial(async()=>{if(input.confirm!==true)throw marketError('请确认移除来源');store.source(input.id);if(store.installed().some(row=>row.source_id===input.id))throw marketError('仍有已安装定义，请先停用来源或卸载相关定义',409);store.removeSource(input.id);return{deleted:true}}),
  }
}
