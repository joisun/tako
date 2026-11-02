import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AtSign, Paperclip } from 'lucide-react'
import { Extension, type Editor } from '@tiptap/core'
import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention'
import { ReactRenderer } from '@tiptap/react'
import { PromptInput,PromptInputBody,PromptInputHeader,PromptInputFooter,PromptInputTools,PromptInputButton,PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { EditorProvider } from '@/components/kibo-ui/editor'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogBody,DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Attachments,Attachment,AttachmentInfo,AttachmentRemove } from '@/components/ai-elements/attachments'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { LoopAttachment,LoopMember } from '@/lib/api/loop-types'

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
  const [attachments,setAttachments]=useState<LoopAttachment[]>([]),[fileDialog,setFileDialog]=useState(false),[path,setPath]=useState(''),[filePending,setFilePending]=useState(false),[fileError,setFileError]=useState('')
  async function referenceFile(){setFilePending(true);setFileError('');try{const {attachment}=await api.roomAttachment(roomId,path);setAttachments(value=>[...value.filter(item=>item.path!==attachment.path),attachment]);requestKey.current=crypto.randomUUID();setFileDialog(false);setPath('')}catch(cause){setFileError(cause instanceof Error?cause.message:'无法读取文件')}finally{setFilePending(false)}}
  const [hasContent, setHasContent] = useState(false)
  const editor = useRef<Editor | null>(null), form = useRef<HTMLFormElement>(null), requestKey = useRef(crypto.randomUUID())
  const roster = useRef(members); roster.current = members
  const sending = useRef(false), inserted = useRef('')
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
    if (!current || !text || disabled || pending || sending.current) return
    const ids = new Set(roster.current.map(member => member.id)), mentions = new Set<string>()
    current.state.doc.descendants(node => { if (node.type.name === 'mention' && ids.has(node.attrs.id)) mentions.add(node.attrs.id) })
    sending.current = true; current.setEditable(false,false)
    try {
      if (await onSend(text,requestKey.current,[...mentions],attachments)) { current.commands.clearContent(); setAttachments([]); requestKey.current = crypto.randomUUID() }
    } finally { sending.current = false; if (!current.isDestroyed) current.setEditable(!disabled,false) }
  }
  return <PromptInput ref={form} className="room-composer" onSubmit={submit}>
    <PromptInputBody><EditorProvider limit={20000} placeholder="说明你的任务，或 @ 一位成员…" extensions={extensions} editable={!disabled && !pending}
      editorProps={{ attributes:{ role:'textbox', 'aria-label':'发送团队消息', 'aria-multiline':'true', 'aria-autocomplete':'list', 'aria-haspopup':'listbox', 'aria-expanded':'false' } }}
      onCreate={({ editor:current }) => { editor.current = current; setReady(true) }}
      onUpdate={({ editor:current, transaction }) => { setHasContent(!!current.getText().trim()); if (transaction.docChanged) requestKey.current = crypto.randomUUID() }} /></PromptInputBody>
    {attachments.length?<PromptInputHeader><Attachments>{attachments.map(item=><Attachment key={item.path}><AttachmentInfo name={item.name} path={item.path} mediaType={item.media_type}/><AttachmentRemove name={item.name} onClick={()=>{setAttachments(value=>value.filter(file=>file.path!==item.path));requestKey.current=crypto.randomUUID()}}/></Attachment>)}</Attachments></PromptInputHeader>:null}
    <PromptInputFooter className="room-composer__footer"><PromptInputTools><PromptInputButton isIconOnly aria-label="引用图片或 PDF 路径" disabled={disabled||pending||attachments.length>=8} onClick={()=>setFileDialog(true)}><Paperclip/></PromptInputButton><span><AtSign/>成员协作 <kbd>⌘ / Ctrl ↵</kbd> 发送</span></PromptInputTools><PromptInputSubmit disabled={disabled||!hasContent} status={pending?'submitted':'ready'}/></PromptInputFooter>
    <Dialog open={fileDialog} onOpenChange={value=>{if(!filePending)setFileDialog(value)}}><DialogContent className="room-dialog room-theme" showCloseButton={!filePending}><DialogHeader><DialogTitle>引用文件</DialogTitle><DialogDescription>填写运行 Rillo 的机器上的图片或 PDF 路径。</DialogDescription></DialogHeader><DialogBody><Input autoFocus aria-label="文件绝对路径" placeholder="/path/to/file.png" value={path} disabled={filePending} onChange={event=>setPath(event.target.value)}/>{fileError?<p className="room-error" role="alert">{fileError}</p>:null}</DialogBody><DialogFooter><Button disabled={filePending} onClick={()=>setFileDialog(false)}>取消</Button><Button variant="primary" isPending={filePending} disabled={!path.trim()} onClick={()=>{void referenceFile()}}>添加引用</Button></DialogFooter></DialogContent></Dialog>
  </PromptInput>
}
