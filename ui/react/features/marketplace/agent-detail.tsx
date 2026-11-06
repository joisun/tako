import {queryKeys} from '@/lib/query/keys'
import {useQuery} from '@tanstack/react-query'
import {useState} from 'react'
import {Copy,ExternalLink,X} from 'lucide-react'
import {Sheet,SheetContent} from '@/components/ui/sheet'
import {DialogTitle,DialogDescription} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'
import {SegmentedControl} from '@/components/ui/segmented-control'
import type {DashboardApi} from '@/lib/api/dashboard-api'
import type {MarketDefinition,InstalledAgent} from '@/lib/api/marketplace-types'
import {DefinitionPreview} from './definition-preview'
import type {MarketAction} from './marketplace-dialogs'
export type MarketSelection={kind:'remote';definition:MarketDefinition}|{kind:'installed';installed:InstalledAgent}
export function AgentDetail({api,selection,installed,onClose,onAction}:{api:DashboardApi;selection:MarketSelection;installed:InstalledAgent[];onClose:()=>void;onAction:(action:MarketAction)=>void}){
  const [view,setView]=useState('overview'),[copied,setCopied]=useState(false),[error,setError]=useState('')
  const summary=selection.kind==='remote'?selection.definition:selection.installed.definition
  const detail=useQuery({queryKey:[...queryKeys.marketplace,'detail',selection.kind,summary.id,summary.version],queryFn:async()=>selection.kind==='remote'?(await api.marketDefinition(summary.source_id,summary.path,summary.version)).definition:(await api.marketLocal(selection.installed.id)).installed.definition})
  const local=useQuery({queryKey:[...queryKeys.marketplace,'local',selection.kind==='installed'?selection.installed.id:''],queryFn:()=>api.marketLocal(selection.kind==='installed'?selection.installed.id:''),enabled:selection.kind==='installed'})
  const compatibility=useQuery({queryKey:[...queryKeys.marketplace,'compatibility'],queryFn:()=>api.marketCompatibility()})
  const definition=detail.data??summary,record=installed.find(row=>row.definition_id===summary.id)
  async function copy(){if(!detail.data?.content)return;try{await navigator.clipboard.writeText(detail.data.content);setCopied(true);setError('')}catch{setError('无法写入剪贴板，请从原文中复制。')}}
  return <Sheet open onOpenChange={open=>{if(!open)onClose()}}><SheetContent className="market-detail"><header className="market-detail-header"><div><span className="market-eyebrow">{definition.category} · {definition.source_name}</span><DialogTitle>{definition.name}</DialogTitle></div><Button variant="quiet" size="sm" isIconOnly aria-label="关闭 Agent 详情" onClick={onClose}><X/></Button></header><div className="market-detail-content"><DialogDescription>{definition.description||'来源未提供简介'}</DialogDescription><div className="market-tags">{definition.tags.map(tag=><span key={tag}>{tag}</span>)}</div><SegmentedControl label="定义详情" value={view} onValueChange={setView} options={[{value:'overview',label:'概览'},{value:'definition',label:'完整定义'},{value:'raw',label:'原文'},{value:'license',label:'许可'}]}/>
    {detail.isPending?<p role="status">正在读取完整定义…</p>:detail.error?<div role="alert" className="market-error">{detail.error.message}<Button size="xs" onClick={()=>{void detail.refetch()}}>重试</Button></div>:view==='definition'?<DefinitionPreview content={definition.instructions??''}/>:view==='raw'?<pre className="market-raw">{definition.content}</pre>:view==='license'?<pre className="market-raw">{definition.license_text??'来源未提供许可证。安装不代表取得额外使用权限。'}</pre>:<>
      <dl className="market-metadata"><dt>来源仓库</dt><dd><a href={'https://github.com/'+definition.repository} target="_blank" rel="noreferrer">{definition.repository}</a></dd><dt>定义文件</dt><dd><code>{definition.path}</code></dd><dt>固定版本</dt><dd><code>{definition.version.slice(0,12)}</code></dd><dt>许可</dt><dd>{definition.license??'未提供'}</dd>{record?<><dt>安装位置</dt><dd><code>{record.local_path}</code></dd><dt>安装时间</dt><dd>{new Date(record.installed_at).toLocaleString()}</dd><dt>最近更新</dt><dd>{new Date(record.updated_at).toLocaleString()}</dd><dt>本地状态</dt><dd>{record.is_missing?'文件丢失':record.is_modified?'存在本地修改':'与安装原文一致'}</dd></>:null}</dl>
      <section className="market-compatibility"><h3>Runtime 兼容性</h3>{compatibility.data?.adapters.map(adapter=><div key={adapter.id}><strong>{adapter.name}</strong><span>{adapter.instructions_supported?'TAKO 指令注入':'尚未接入'}</span></div>)}{compatibility.error?<p className="market-error" role="alert">{compatibility.error.message}</p>:null}<p>定义声明的工具与技能不会自动安装或获得权限。</p></section>
      {definition.responsibilities?.length?definition.responsibilities.map((section,index)=><section key={'responsibility'+index}><h3>{section.title}</h3><DefinitionPreview content={section.text}/></section>):null}{definition.workflow?.map((section,index)=><section key={'workflow'+index}><h3>{section.title}</h3><DefinitionPreview content={section.text}/></section>)}
    </>}
    {selection.kind==='installed'?<details className="market-local-definition"><summary>查看本地定义</summary>{local.isPending?<p role="status">正在读取本地文件…</p>:local.error?<p role="alert" className="market-error">{local.error.message}</p>:<pre className="market-raw">{local.data?.content??'本地文件已丢失'}</pre>}</details>:null}{error?<p role="alert" className="market-error">{error}</p>:null}
  </div><footer className="market-detail-footer"><Button size="sm" variant="quiet" disabled={!detail.data} onClick={()=>{void copy()}}><Copy/>{copied?'已复制':'复制定义'}</Button><a href={definition.url} target="_blank" rel="noreferrer" aria-label="查看源定义"><ExternalLink/>来源</a>{record?<><Button size="sm" variant="danger" onClick={()=>onAction({kind:'uninstall',installed:record})}>卸载</Button><Button size="sm" onClick={()=>onAction({kind:'update',installed:record})}>审核更新</Button><Button size="sm" variant="primary" onClick={()=>onAction({kind:'session',installed:record})}>创建会话</Button></>:<Button size="sm" variant="primary" disabled={!detail.data} onClick={()=>{if(detail.data)onAction({kind:'install',definition:detail.data})}}>安装 Agent</Button>}</footer></SheetContent></Sheet>
}
