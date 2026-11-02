// AI Elements ChainOfThought composition: explicit activity steps, not invented reasoning.
import { Collapsible } from '@base-ui/react/collapsible'
import { Brain,ChevronDown,Dot,type LucideIcon } from 'lucide-react'
import type { ComponentProps,ReactNode } from 'react'
import { cn } from '@/lib/cn'
export function ChainOfThought({className,...props}:ComponentProps<typeof Collapsible.Root>){return <Collapsible.Root className={cn('ai-chain',className)} {...props}/>}
export function ChainOfThoughtHeader({children,...props}:ComponentProps<typeof Collapsible.Trigger>){return <Collapsible.Trigger className="ai-chain-header" {...props}><Brain/><span>{children??'执行过程'}</span><ChevronDown/></Collapsible.Trigger>}
export function ChainOfThoughtContent(props:ComponentProps<typeof Collapsible.Panel>){return <Collapsible.Panel className="ai-chain-content" {...props}/>}
export function ChainOfThoughtStep({icon:Icon=Dot,label,children,status='complete'}:{icon?:LucideIcon;label?:ReactNode;children?:ReactNode;status?:'complete'|'active'|'pending'}){return <div className="ai-chain-step" data-status={status}><div className="ai-chain-step-icon"><Icon/></div><div className="ai-chain-step-content">{label?<div>{label}</div>:null}{children}</div></div>}
