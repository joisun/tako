import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Paperclip, RotateCcw } from 'lucide-react'
import { Extension, type Editor } from '@tiptap/core'
import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention'
import { ReactRenderer } from '@tiptap/react'
import { PromptInput,PromptInputBody,PromptInputHeader,PromptInputFooter,PromptInputTools,PromptInputButton,PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { EditorProvider } from '@/components/kibo-ui/editor'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Attachments,Attachment,AttachmentInfo,AttachmentRemove } from '@/components/ai-elements/attachments'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { LoopAttachment,LoopMember } from '@/lib/api/loop-types'

const MAX_ATTACHMENT_COUNT=8
const MAX_ATTACHMENT_BYTES=20*1024*1024
const ATTACHMENT_ACCEPT='image/png,image/jpeg,image/webp,image/gif,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.pdf'
const ATTACHMENT_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf'])
interface ComposerAttachment {id:string;file:File;preview?:string;attachment?:LoopAttachment;error?:string}

function MentionMenu({ items, command }: { items: LoopMember[]; command: (attrs: MentionNodeAttrs) => void }) {
  return <Command shouldFilter={false} loop label="选择团队 Agent" onKeyDown={event => event.stopPropagation()} onMouseDown={event => event.preventDefault()}>
    <CommandList aria-label="选择团队 Agent">
      <CommandEmpty>没有匹配的成员</CommandEmpty>
      <CommandGroup>{items.map(member => <CommandItem key={member.id} value={member.id} onSelect={() => command({ id:member.id, label:member.name })}>
        <span className="room-member-mark"><AgentAvatar id={member.id} name={member.name} avatar={member.avatar}/></span><span><strong>{member.name}</strong><small>{member.runtime_id==='claude'?'Claude Code':'Codex'}</small></span>
      </CommandItem>)}</CommandGroup>
    </CommandList>
  </Command>
}

export function RoomComposer({ api,roomId,members, disabled, pending, onSend, insertion }: { api:DashboardApi;roomId:string;members: LoopMember[]; disabled?: boolean; pending: boolean; onSend: (text: string, requestKey: string, mentions: string[],attachments:LoopAttachment[]) => Promise<boolean>; insertion?:{key:string;text?:string;member?:LoopMember} }) {
  const [attachments,setAttachments]=useState<ComposerAttachment[]>([]),[fileError,setFileError]=useState(''),[dragging,setDragging]=useState(false)
  const attachmentItems=useRef<ComposerAttachment[]>([]),uploads=useRef(new Map<string,AbortController>()),previews=useRef(new Set<string>())
  const fileInput=useRef<HTMLInputElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const editor = useRef<Editor | null>(null), form = useRef<HTMLFormElement>(null), requestKey = useRef(crypto.randomUUID())
  const roster = useRef(members); roster.current = members
  const sending = useRef(false), inserted = useRef('')
  function updateAttachments(items:ComposerAttachment[]){attachmentItems.current=items;setAttachments(items)}
  function releasePreview(item:ComposerAttachment){if(item.preview){URL.revokeObjectURL(item.preview);previews.current.delete(item.preview)}}
  useEffect(()=>()=>{for(const controller of uploads.current.values())controller.abort();for(const url of previews.current)URL.revokeObjectURL(url)},[])
  async function uploadFile(item:ComposerAttachment){
    const controller=new AbortController()
    uploads.current.set(item.id,controller)
    updateAttachments(attachmentItems.current.map(value=>value.id===item.id?{...value,error:undefined}:value))
    try{
      const {attachment}=await api.uploadRoomAttachment(roomId,item.file,controller.signal)
      if(!controller.signal.aborted)updateAttachments(attachmentItems.current.map(value=>value.id===item.id?{...value,attachment}:value))
    }catch(cause){
      if(!controller.signal.aborted)updateAttachments(attachmentItems.current.map(value=>value.id===item.id?{...value,error:cause instanceof Error?cause.message:'文件上传失败'}:value))
    }finally{uploads.current.delete(item.id)}
  }
  function addFiles(files:File[]){
    if(disabled||pending||sending.current)return
    setFileError('')
    for(const file of files){
      if(attachmentItems.current.length>=MAX_ATTACHMENT_COUNT){setFileError('每条消息最多添加 8 个文件');break}
      if(file.size>MAX_ATTACHMENT_BYTES){setFileError(`${file.name} 超过 20 MB`);continue}
      if(!ATTACHMENT_TYPES.has(file.type)&&!(file.type===''&&/\.(png|jpe?g|webp|gif|pdf)$/i.test(file.name))){setFileError('支持 PNG、JPEG、WebP、GIF 和 PDF 文件');continue}
      const preview=file.type.startsWith('image/')?URL.createObjectURL(file):undefined
      if(preview)previews.current.add(preview)
      const item={id:crypto.randomUUID(),file,preview}
      updateAttachments([...attachmentItems.current,item])
      requestKey.current=crypto.randomUUID()
      void uploadFile(item)
    }
  }
  function removeAttachment(item:ComposerAttachment){
    uploads.current.get(item.id)?.abort()
    releasePreview(item)
    updateAttachments(attachmentItems.current.filter(value=>value.id!==item.id))
    requestKey.current=crypto.randomUUID()
  }
  const [ready,setReady]=useState(false)
  useEffect(()=>{
    if(!insertion||!ready||inserted.current===insertion.key||!editor.current)return
    const current=editor.current
    current.commands.focus('end')
    if(!current.isEmpty)current.commands.insertContent({type:'hardBreak'})
    if(insertion.member)current.commands.insertContent([{type:'mention',attrs:{id:insertion.member.id,label:insertion.member.name}},{type:'text',text:' '}])
    if(insertion.text)current.commands.insertContent(insertion.text.split('\n').flatMap((text,index)=>[...(index?[{type:'hardBreak'}]:[]),...(text?[{type:'text',text}]:[])]))
    inserted.current=insertion.key
  },[insertion,ready])
  const extensions = useMemo(() => [
    Mention.configure({
      deleteTriggerWithBackspace:true,
      HTMLAttributes:{ class:'room-mention-token' },
      renderText:({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
      suggestion:{
        placement:'top-start', offset:{ mainAxis:10 },
        items:({ query }) => roster.current.filter(member => member.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,30),
        render:() => {
          let renderer: ReactRenderer | undefined, unmount: (() => void) | undefined
          return {
            onStart:props => {
              renderer = new ReactRenderer(MentionMenu, { props, editor:props.editor })
              renderer.element.classList.add('room-mention-menu')
              unmount = props.mount(renderer.element)
              props.editor.view.dom.setAttribute('aria-expanded','true')
            },
            onUpdate:props => renderer?.updateProps(props),
            onKeyDown:({ event, view }) => {
              if (view.composing || event.isComposing || !['ArrowUp','ArrowDown','Enter'].includes(event.key)) return false
              const command = renderer?.element.querySelector<HTMLElement>('[cmdk-root]')
              if (!command) return false
              command.dispatchEvent(new KeyboardEvent('keydown',{ key:event.key, bubbles:true, cancelable:true }))
              return true
            },
            onExit:props => { unmount?.(); renderer?.destroy(); props.editor.view.dom.setAttribute('aria-expanded','false') },
          }
        },
      },
    }),
    Extension.create({ name:'roomSubmit', addKeyboardShortcuts() { return { 'Mod-Enter':() => { if (this.editor.view.composing) return false; form.current?.requestSubmit(); return true } } } }),
  ],[])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const current = editor.current, text = current?.getText({ blockSeparator:'\n' }).trim()
    const files=attachmentItems.current
    if (!current || (!text&&!files.length) || files.some(item=>!item.attachment) || disabled || pending || sending.current) return
    const ids = new Set(roster.current.map(member => member.id)), mentions = new Set<string>()
    current.state.doc.descendants(node => { if (node.type.name === 'mention' && ids.has(node.attrs.id)) mentions.add(node.attrs.id) })
    sending.current = true; current.setEditable(false,false)
    try {
      if (await onSend(text??'',requestKey.current,[...mentions],files.map(item=>item.attachment!))) { current.commands.clearContent(); files.forEach(releasePreview); updateAttachments([]); requestKey.current = crypto.randomUUID() }
    } finally { sending.current = false; if (!current.isDestroyed) current.setEditable(!disabled,false) }
  }
  return <PromptInput ref={form} className="room-composer" data-dragging={dragging||undefined} onSubmit={submit}
    onPasteCapture={event=>{const data=event.clipboardData;if(!data.files.length||data.getData('text/plain'))return;event.preventDefault();event.stopPropagation();addFiles(Array.from(data.files))}}
    onDragOver={event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();if(!disabled&&!pending)setDragging(true)}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false)}}
    onDropCapture={event=>{setDragging(false);if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();addFiles(Array.from(event.dataTransfer.files))}}>
    <PromptInputBody><EditorProvider limit={20000} placeholder="说明你的任务，或 @ 一位成员…" extensions={extensions} editable={!disabled && !pending}
      editorProps={{ attributes:{ role:'textbox', 'data-slot':'input-group-control', 'aria-label':'发送团队消息', 'aria-multiline':'true', 'aria-autocomplete':'list', 'aria-haspopup':'listbox', 'aria-expanded':'false' } }}
      onCreate={({ editor:current }) => { editor.current = current; setReady(true) }}
      onUpdate={({ editor:current, transaction }) => { setHasContent(!!current.getText().trim()); if (transaction.docChanged) requestKey.current = crypto.randomUUID() }} /></PromptInputBody>
    {attachments.length?<PromptInputHeader><Attachments>{attachments.map(item=><Attachment key={item.id} data-state={item.error?'error':item.attachment?'ready':'uploading'}>
      {item.preview?<img src={item.preview} alt={item.file.name}/>:null}<AttachmentInfo name={item.file.name} path={item.attachment?.path??item.file.name} mediaType={item.attachment?.media_type??item.file.type}/>
      {!item.attachment&&!item.error?<span role="status"><LoaderCircle className="room-spinner"/>上传中</span>:null}
      {item.error?<><span role="alert">{item.error}</span><Button size="xs" variant="quiet" isIconOnly aria-label={`重试 ${item.file.name}`} disabled={disabled||pending} onClick={()=>{void uploadFile(item)}}><RotateCcw/></Button></>:null}
      <AttachmentRemove name={item.file.name} disabled={pending} onClick={()=>removeAttachment(item)}/>
    </Attachment>)}</Attachments></PromptInputHeader>:null}
    {fileError?<p className="room-attachment-error" role="alert">{fileError}</p>:null}
    <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="选择附件" accept={ATTACHMENT_ACCEPT} multiple disabled={disabled||pending} onChange={event=>{addFiles(Array.from(event.target.files??[]));event.target.value=''}}/>
    <PromptInputFooter className="room-composer__footer"><PromptInputTools><PromptInputButton isIconOnly aria-label="添加附件" title="添加图片或 PDF" disabled={disabled||pending||attachments.length>=MAX_ATTACHMENT_COUNT} onClick={()=>fileInput.current?.click()}><Paperclip/></PromptInputButton><span className="room-composer-shortcut"><kbd>⌘ / Ctrl ↵</kbd> 发送</span></PromptInputTools><PromptInputSubmit disabled={disabled||(!hasContent&&!attachments.length)||attachments.some(item=>!item.attachment)} status={pending?'submitted':'ready'}/></PromptInputFooter>
  </PromptInput>
}
