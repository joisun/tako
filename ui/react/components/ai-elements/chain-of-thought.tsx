// shadcn/ui Chain of Thought pattern. Groups only the caller's actual activity steps.
import {Collapsible} from '@base-ui/react/collapsible'
import {Brain,Dot,type LucideIcon} from 'lucide-react'
import type {ComponentProps,ReactNode} from 'react'
import {cn} from '@/lib/cn'
import {Trace,TraceLine,TraceIcon,TraceTitle,TraceCollapsible,TraceCollapsibleTrigger,TraceCollapsibleContent} from '@/components/ui/trace'
export function ChainOfThought({className,...props}:ComponentProps<typeof Collapsible.Root>){return <Trace><TraceCollapsible className={cn('ai-chain',className)} {...props}/></Trace>}
export function ChainOfThoughtHeader({children,className,icon:Icon=Brain,status,...props}:ComponentProps<typeof Collapsible.Trigger>&{icon?:LucideIcon;status?:ComponentProps<typeof TraceLine>['status']}){return <TraceCollapsibleTrigger className={cn('ai-chain-header',className)} {...props}><TraceLine status={status}><TraceIcon><Icon/></TraceIcon><TraceTitle>{children??'执行过程'}</TraceTitle></TraceLine></TraceCollapsibleTrigger>}
export function ChainOfThoughtContent({children,className,...props}:ComponentProps<typeof Collapsible.Panel>){return <TraceCollapsibleContent keepMounted className={cn('ai-chain-content',className)} {...props}><Trace>{children}</Trace></TraceCollapsibleContent>}
export function ChainOfThoughtStep({icon:Icon=Dot,label,children,status='complete'}:{icon?:LucideIcon;label?:ReactNode;children?:ReactNode;status?:'complete'|'active'|'pending'}){return <Trace className="ai-chain-step"><TraceLine status={status==='active'?'running':status==='pending'?'pending':undefined}><TraceIcon><Icon/></TraceIcon><TraceTitle>{label}</TraceTitle></TraceLine>{children?<div className="ai-chain-step-content">{children}</div>:null}</Trace>}
