// shadcn/ui Reasoning pattern. Only client-provided public reasoning text is rendered.
import {Collapsible} from '@base-ui/react/collapsible'
import {Brain} from 'lucide-react'
import {createContext,useContext,useState,type ComponentProps} from 'react'
import {Trace,TraceCollapsible,TraceCollapsibleTrigger,TraceCollapsibleContent,TraceLine,TraceIcon,TraceTitle} from '@/components/ui/trace'
import {MessageResponse} from './message'

const ReasoningContext=createContext(false)
export function Reasoning({isStreaming=false,open,defaultOpen,onOpenChange,...props}:ComponentProps<typeof Collapsible.Root>&{isStreaming?:boolean}){
  const [selected,setSelected]=useState<boolean|undefined>(defaultOpen)
  const change:NonNullable<ComponentProps<typeof Collapsible.Root>['onOpenChange']>=(value,details)=>{setSelected(value);onOpenChange?.(value,details)}
  return <ReasoningContext.Provider value={isStreaming}><Trace><TraceCollapsible data-streaming={isStreaming} open={open??selected??isStreaming} onOpenChange={change} {...props}/></Trace></ReasoningContext.Provider>
}
export function ReasoningTrigger({children,...props}:ComponentProps<typeof TraceCollapsibleTrigger>){
  const streaming=useContext(ReasoningContext)
  return <TraceCollapsibleTrigger {...props}><TraceLine status={streaming?'running':undefined}><TraceIcon><Brain/></TraceIcon><TraceTitle>{children??(streaming?'正在思考':'思考过程')}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
}
export function ReasoningContent({children,...props}:Omit<ComponentProps<typeof MessageResponse>,'children'|'isAnimating'>&{children:string}){
  const isStreaming=useContext(ReasoningContext)
  return <TraceCollapsibleContent keepMounted><MessageResponse {...props} isAnimating={isStreaming}>{children}</MessageResponse></TraceCollapsibleContent>
}
