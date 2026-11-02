// AI Elements Agent composition. Configuration display never grants runtime capabilities.
import type { ComponentProps,ReactNode } from 'react'
import { Bot } from 'lucide-react'
import { Collapsible } from '@base-ui/react/collapsible'
import { MessageResponse } from './message'
import { cn } from '@/lib/cn'
export function Agent({className,...props}:ComponentProps<'div'>){return <div className={cn('ai-agent',className)} {...props}/>}
export function AgentHeader({name,model,children}:{name:string;model?:string;children?:ReactNode}){return <div className="ai-agent-header"><Bot/><strong>{name}</strong>{model?<code>{model}</code>:null}{children}</div>}
export function AgentContent(props:ComponentProps<'div'>){return <div className="ai-agent-content" {...props}/>}
export function AgentInstructions({children}:{children:string}){return <section className="ai-agent-instructions"><h4>角色指令</h4><MessageResponse className="room-markdown">{children}</MessageResponse></section>}
export function AgentTools({children}:{children:ReactNode}){return <section className="ai-agent-tools"><h4>定义中声明的工具</h4>{children}</section>}
export function AgentTool({name,description}:{name:string;description:string}){return <Collapsible.Root><Collapsible.Trigger>{name}</Collapsible.Trigger><Collapsible.Panel>{description}</Collapsible.Panel></Collapsible.Root>}
