import {useState,type ComponentProps} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Download,FileText,LoaderCircle} from 'lucide-react'
import {Attachments,Attachment} from '@/components/ai-elements/attachments'
import {MessageResponse} from '@/components/ai-elements/message'
import {InlineCitationLink} from '@/components/ai-elements/inline-citation'
import {Button} from '@/components/ui/button'
import {CodeBlock,CodeBlockHeader,CodeBlockContent,CodeBlockCopyButton,MarkdownCodeBlock} from '@/components/ui/code-block'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogBody} from '@/components/ui/dialog'
import type {DashboardApi} from '@/lib/api/dashboard-api'
import type {LoopRun} from '@/lib/api/loop-types'

const markdownComponents={pre:MarkdownCodeBlock,a:({href,children}:ComponentProps<'a'>)=><InlineCitationLink href={href??''}>{children}</InlineCitationLink>}
function filename(reference:string){return reference.split('/').at(-1)||reference}

export function RoomArtifacts({api,roomId,run}:{api:DashboardApi;roomId:string;run:LoopRun}){
  const references=[...new Set([...(run.submission?.artifacts??run.result?.submission?.artifacts??[]),...(run.action?.artifacts??[])])]
  const [selected,setSelected]=useState<string|null>(null)
  const preview=useQuery({queryKey:['team-artifact',roomId,run.id,selected],queryFn:()=>api.roomArtifactPreview(roomId,run.id,selected!),enabled:!!selected,retry:false})
  const artifact=preview.data?.artifact
  if(!references.length)return null
  return <>
    <Attachments className="room-attachments team-artifacts" role="list" aria-label="交付文件">{references.map(reference=><Attachment key={reference} role="listitem">
      <Button className="team-artifact-open" variant="quiet" size="sm" title={reference} aria-label={`预览 ${filename(reference)}`} onClick={()=>setSelected(reference)}><FileText/><span>{filename(reference)}</span></Button>
      <a className="team-artifact-download" href={api.roomArtifactUrl(roomId,run.id,reference,true)} download={filename(reference)} aria-label={`下载 ${filename(reference)}`} title="下载"><Download/></a>
    </Attachment>)}</Attachments>
    {selected?<Dialog open onOpenChange={open=>{if(!open)setSelected(null)}}><DialogContent className="team-artifact-dialog room-theme" showCloseButton>
      <DialogHeader><DialogTitle>{artifact?.name??filename(selected)}</DialogTitle><a className="team-artifact-download" href={api.roomArtifactUrl(roomId,run.id,selected,true)} download={filename(selected)} aria-label={`下载 ${filename(selected)}`} title="下载"><Download/></a></DialogHeader>
      <DialogBody>
        {preview.isPending?<p className="team-artifact-loading" role="status"><LoaderCircle className="room-spinner"/>正在读取文件…</p>:null}
        {preview.error?<div className="team-artifact-error"><p role="alert">{preview.error.message}</p><Button size="sm" variant="quiet" aria-label="重新读取文件" onClick={()=>{void preview.refetch()}}>重试</Button></div>:null}
        {artifact?.media_type.startsWith('image/')?<img className="team-artifact-image" src={api.roomArtifactUrl(roomId,run.id,selected)} alt={artifact.name}/>:null}
        {artifact?.media_type==='application/pdf'?<iframe className="team-artifact-pdf" title={`预览 ${artifact.name}`} src={api.roomArtifactUrl(roomId,run.id,selected)}/>:null}
        {artifact?.text!==undefined?(/\.(md|markdown)$/i.test(artifact.name)?<MessageResponse className="room-markdown team-artifact-markdown" components={markdownComponents}>{artifact.text}</MessageResponse>:<CodeBlock><CodeBlockHeader><span>源码</span><CodeBlockCopyButton code={artifact.text}/></CodeBlockHeader><CodeBlockContent>{artifact.text}</CodeBlockContent></CodeBlock>):null}
        {artifact&&artifact.text===undefined&&!artifact.media_type.startsWith('image/')&&artifact.media_type!=='application/pdf'?<p>此文件可通过上方按钮下载。</p>:null}
        {artifact?.truncated?<p className="team-artifact-note">预览已截断，下载可获取完整文件。</p>:null}
      </DialogBody>
    </DialogContent></Dialog>:null}
  </>
}
