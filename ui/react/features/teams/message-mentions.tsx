import { useMemo, useRef, type ComponentProps } from 'react'
import { defaultRemarkPlugins } from 'streamdown'
import { MessageResponse } from '@/components/ai-elements/message'
import { InlineCitationLink } from '@/components/ai-elements/inline-citation'
import {MarkdownCodeBlock} from '@/components/ui/code-block'
import { Button } from '@/components/ui/button'

interface Recipient { id:string; name:string; available:boolean }
interface MarkdownNode { type:string; value?:string; url?:string; children?:MarkdownNode[] }
const INLINE_PREFIX='#tako-mention-'
const RECIPIENT_PREFIX='#tako-recipient-'
const EXCLUDED=new Set(['link','linkReference','code','inlineCode','html','image','imageReference'])

// Only persisted routing IDs authorize a visual mention; text never changes routing.
function mentionPlugin({recipients,prependRecipients}:{recipients:Recipient[];prependRecipients:boolean}) {
  const names=new Map<string,Recipient[]>()
  for(const recipient of recipients)names.set(recipient.name,[...(names.get(recipient.name)??[]),recipient])
  const candidates=recipients.filter(recipient=>names.get(recipient.name)?.length===1).sort((a,b)=>b.name.length-a.name.length)
  return (tree:MarkdownNode) => {
    const matched=new Set<string>()
    function split(value:string):MarkdownNode[] {
      const result:MarkdownNode[]=[]
      let start=0,cursor=0
      while(cursor<value.length){
        if(value[cursor]!=='@'||cursor>0&&/[A-Za-z0-9_@.+-]/.test(value[cursor-1])){cursor++;continue}
        const recipient=candidates.find(item=>value.startsWith(`@${item.name}`,cursor)&&!/[A-Za-z0-9_-]/.test(value[cursor+item.name.length+1]??''))
        if(!recipient){cursor++;continue}
        if(cursor>start)result.push({type:'text',value:value.slice(start,cursor)})
        result.push({type:'link',url:INLINE_PREFIX+encodeURIComponent(recipient.id),children:[{type:'text',value:`@${recipient.name}`}]})
        matched.add(recipient.id);cursor+=recipient.name.length+1;start=cursor
      }
      if(start<value.length)result.push({type:'text',value:value.slice(start)})
      return result
    }
    function visit(node:MarkdownNode){
      if(EXCLUDED.has(node.type)||!node.children)return
      node.children=node.children.flatMap(child=>{
        if(child.type==='text')return split(child.value??'')
        visit(child);return [child]
      })
    }
    visit(tree)
    const remaining=recipients.filter(recipient=>!matched.has(recipient.id))
    if(!prependRecipients||!remaining.length||!tree.children)return
    const children:MarkdownNode[]=[]
    for(const recipient of remaining){
      if(children.length)children.push({type:'text',value:' '})
      children.push({type:'link',url:RECIPIENT_PREFIX+encodeURIComponent(recipient.id),children:[{type:'text',value:`@${recipient.name}`}]})
    }
    children.push({type:'text',value:' '})
    const first=tree.children[0]
    if(first?.type==='paragraph'&&first.children)first.children.unshift(...children)
    else tree.children.unshift({type:'paragraph',children})
  }
}

export function MentionMessage({text,recipients,onInspect,prependRecipients=true}:{text:string;recipients:Recipient[];onInspect:(id:string)=>void;prependRecipients?:boolean}){
  const inspect=useRef(onInspect);inspect.current=onInspect
  const identity=JSON.stringify({recipients,prependRecipients})
  const rendering=useMemo(()=>{
    const {recipients:members,prependRecipients:prepend}:{recipients:Recipient[];prependRecipients:boolean}=JSON.parse(identity)
    const targets=new Map(members.flatMap(member=>[[INLINE_PREFIX+encodeURIComponent(member.id),member],[RECIPIENT_PREFIX+encodeURIComponent(member.id),member]] as const))
    function Link({href,children}:ComponentProps<'a'>){
      const member=targets.get(href??'')
      if(!member)return <InlineCitationLink href={href??''}>{children}</InlineCitationLink>
      const className=href?.startsWith(RECIPIENT_PREFIX)?'team-message-mention team-message-recipient':'team-message-mention'
      if(!member.available)return <span className={className} title="成员已移除">{children}</span>
      return <Button variant="link" size="xs" className={className} aria-label={`查看 ${member.name} 的 Agent 定义`} onClick={()=>inspect.current(member.id)}>{children}</Button>
    }
    const plugins:NonNullable<ComponentProps<typeof MessageResponse>['remarkPlugins']>=[...Object.values(defaultRemarkPlugins),[mentionPlugin,{recipients:members,prependRecipients:prepend}]]
    return {components:{a:Link,pre:MarkdownCodeBlock},plugins}
  },[identity])
  // Streamdown memoizes Markdown by text; remount when persisted recipient identity changes.
  return <MessageResponse key={identity} mode="static" className="room-markdown" remarkPlugins={rendering.plugins} components={rendering.components}>{text}</MessageResponse>
}
