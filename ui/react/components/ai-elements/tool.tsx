// shadcn/ui AI Elements Tool pattern, built on the shared Trace primitive.
import { Check, LoaderCircle, X, type LucideIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import {Trace,TraceLine,TraceIcon,TraceTitle,TraceDescription,TraceCollapsible,TraceCollapsibleTrigger,TraceCollapsibleContent} from '@/components/ui/trace'
export function Tool({className,...props}:ComponentProps<typeof TraceCollapsible>){return <Trace className={cn('room-tool',className)}><TraceCollapsible {...props}/></Trace>}
export function ToolHeader({title,state,icon}:{title:string;state:string;icon?:LucideIcon}){
  const Icon=state==='running'?LoaderCircle:icon??(state==='completed'?Check:X)
  const status=state==='completed'?'已完成':state==='failed'?'失败':state==='running'?'执行中':state==='unknown'?'待核对':'已中断'
  return <TraceCollapsibleTrigger><TraceLine status={state==='running'?'running':state==='failed'?'error':undefined}><TraceIcon><Icon className={state==='running'?'room-spinner':''}/></TraceIcon><TraceTitle title={title}>{title}</TraceTitle><TraceDescription className={state==='completed'?'sr-only':undefined}>{status}</TraceDescription></TraceLine></TraceCollapsibleTrigger>
}
export const ToolContent=TraceCollapsibleContent
export function ToolInput({input}:{input?:string}){return input?<div><small>输入</small><pre>{input}</pre></div>:null}
export function ToolOutput({output}:{output?:string}){return output?<div><small>结果</small><pre>{output}</pre></div>:null}
