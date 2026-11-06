import {queryKeys} from '@/lib/query/keys'
import {useQuery} from '@tanstack/react-query'
import {useMemo,useState} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogBody,DialogFooter} from '@/components/ui/dialog'
import type {DashboardApi} from '@/lib/api/dashboard-api'
import type {InstalledAgent,MarketDefinition,MarketplaceMutation} from '@/lib/api/marketplace-types'
import {contentDiff} from './content-diff'
export type MarketAction={kind:'install';definition:MarketDefinition}|{kind:'update'|'uninstall'|'session';installed:InstalledAgent}
export function MarketplaceActionDialog({api,action,onClose,onSaved}:{api:DashboardApi;action:MarketAction;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[backup,setBackup]=useState(false),[comparison,setComparison]=useState('local')
  const review=useQuery({queryKey:[...queryKeys.marketplace,'review',action.kind==='update'?action.installed.id:'',action.kind==='update'?action.installed.local_digest:''],queryFn:()=>api.marketReview(action.kind==='update'?action.installed.id:''),enabled:action.kind==='update',staleTime:0})
  const session=useQuery({queryKey:[...queryKeys.marketplace,'session',action.kind==='session'?action.installed.id:''],queryFn:()=>api.marketSessionContext(action.kind==='session'?action.installed.id:''),enabled:action.kind==='session'})
  const runtimes=useQuery({queryKey:[...queryKeys.marketplace,'runtimes'],queryFn:()=>api.runtimes(),enabled:action.kind==='session'}),[runtime,setRuntime]=useState('codex')
  const claude=useQuery({queryKey:['room-runtime','claude'],queryFn:()=>api.roomRuntime('claude'),enabled:action.kind==='session',staleTime:60000})
  const runtimeState=(id:string)=>id==='claude'?claude.data?.state:runtimes.data?.runtimes.find(item=>item.id===id)?.state
  const definition=action.kind==='install'?action.definition:action.installed.definition
  const title=action.kind==='install'?'安装 Agent':action.kind==='update'?'审核更新':action.kind==='uninstall'?'卸载 Agent':'创建会话'
  const modified=action.kind==='update'?review.data?.is_modified:action.kind==='uninstall'?action.installed.is_modified:false
  const diff=useMemo(()=>review.data?contentDiff(comparison==='local'?review.data.local??'':review.data.base,review.data.remote.content??''):null,[review.data,comparison])
  async function confirm(){
    if(pending||action.kind==='session')return
    setPending(true);setError('')
    try{
      let input:MarketplaceMutation={confirm:true}
      if(action.kind==='install')input={...input,source_id:definition.source_id,path:definition.path,version:definition.version,digest:definition.digest}
      else if(action.kind==='update'){
        if(!review.data)throw new Error('更新内容尚未载入')
        input={...input,id:action.installed.id,version:review.data.remote.version,digest:review.data.remote.digest,expected_local_digest:review.data.local_digest,preserve_modified:backup}
      }else input={...input,id:action.installed.id,expected_local_digest:action.installed.local_digest,preserve_modified:backup}
      await api.marketMutate(action.kind,input);await onSaved();onClose()
    }catch(cause){setError(cause instanceof Error?cause.message:'操作失败');if(action.kind==='update')void review.refetch()}finally{setPending(false)}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className={`market-dialog ${action.kind==='update'?'market-dialog--wide':''}`} showCloseButton={!pending}><DialogHeader><DialogTitle>{title} · {definition.name}</DialogTitle><DialogDescription>{action.kind==='install'?'保存定义原文与版本，不启动客户端或修改全局配置。':action.kind==='uninstall'?'仅卸载 TAKO 托管文件，保留团队已保存的角色快照。':action.kind==='update'?'核对内容差异后再更新。':'选择运行客户端，查看当前可用能力。'}</DialogDescription></DialogHeader><DialogBody>
    {action.kind==='install'?<dl className="market-metadata"><dt>来源</dt><dd>{definition.repository}</dd><dt>版本</dt><dd><code>{definition.version}</code></dd><dt>许可</dt><dd>{definition.license??'来源未提供许可证，请确认使用权限'}</dd><dt>保存到</dt><dd>TAKO 数据目录 / agents / installed</dd></dl>:null}
    {action.kind==='update'?<>{review.isFetching?<p role="status">正在读取本地与远端定义…</p>:review.data&&diff?<><div className="market-review-meta"><code>{review.data.installed.installed_version.slice(0,8)} → {review.data.remote.version.slice(0,8)}</code><label>对比基准 <select aria-label="对比基准" value={comparison} onChange={event=>setComparison(event.target.value)}><option value="local">当前本地文件</option><option value="base">上次安装的原版</option></select></label><span>+{diff.lines.filter(line=>line.kind==='added').length} / −{diff.lines.filter(line=>line.kind==='removed').length}</span></div>{diff.simplified?<p>文件较长，改用整段对比，最多展示 6000 行；完整内容见定义详情。</p>:null}<pre className="market-diff" aria-label="定义内容差异">{diff.lines.map((line,index)=><span key={index} data-kind={line.kind}>{line.kind==='added'?'+':line.kind==='removed'?'−':' '} {line.text}{'\n'}</span>)}</pre></>:null}{review.error?<p role="alert" className="market-error">{review.error.message}</p>:null}</>:null}
    {action.kind==='uninstall'?<><code className="market-local-path">{action.installed.local_path}</code>{action.installed.is_missing?<p>文件已丢失，本次仅移除安装登记。</p>:null}</>:null}
    {modified?<label className="market-backup-option"><input type="checkbox" checked={backup} onChange={event=>setBackup(event.target.checked)}/>已检测到本地修改。先保存独立备份，再{action.kind==='uninstall'?'卸载':'更新'}。</label>:null}
    {action.kind==='session'?<><label className="market-field">运行客户端<select aria-label="运行客户端" value={runtime} onChange={event=>setRuntime(event.target.value)}>{(session.data?.adapters??[]).map(adapter=><option key={adapter.id} value={adapter.id}>{adapter.name} · {runtimeState(adapter.id)==='ready'?'客户端可用':'客户端不可用'}{adapter.instructions_supported?'':' · 定义未接入'}</option>)}</select></label>{session.isPending?<p role="status">正在读取定义快照…</p>:session.data?<>{runtimeState(runtime)!=='ready'?<p className="market-error">所选客户端当前不可用。</p>:null}<p className="market-capability">{session.data.adapters.find(item=>item.id===runtime)?.instructions_supported?'已具备 Run 指令注入能力':'此 Runtime 的 Marketplace 适配尚未接入'}</p><p>{session.data.reason}</p><p>当前可在 <a href="/?view=teams">Teams</a> 的本地 Agent 目录加入此角色，沿用现有协作执行。</p><dl className="market-metadata"><dt>定义</dt><dd>{session.data.definition_id}</dd><dt>版本</dt><dd><code>{session.data.version.slice(0,12)}</code></dd></dl></>:null}{session.error||runtimes.error?<p role="alert" className="market-error">{session.error?.message??runtimes.error?.message}</p>:null}</>:null}
    {error?<p role="alert" className="market-error">{error}</p>:null}
  </DialogBody><DialogFooter><Button disabled={pending} onClick={onClose}>{action.kind==='session'?'关闭':'取消'}</Button>{action.kind==='session'?<Button variant="primary" disabled title="尚无独立 Session 创建接口">创建会话 · 尚未接入</Button>:<Button variant={action.kind==='uninstall'?'danger':'primary'} isPending={pending} disabled={!!modified&&!backup||action.kind==='update'&&(!review.data||review.isFetching||!!review.error)} onClick={()=>{void confirm()}}>{action.kind==='install'?'确认安装':action.kind==='update'?'确认更新':'确认卸载'}</Button>}</DialogFooter></DialogContent></Dialog>
}
