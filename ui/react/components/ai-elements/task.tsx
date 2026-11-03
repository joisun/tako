// shadcn/ui Task pattern. Existing application props and full report text are retained.
import {Collapsible} from '@base-ui/react/collapsible'
import {ListChecks} from 'lucide-react'
import type {ComponentProps,ReactNode} from 'react'
import {cn} from '@/lib/cn'
import {Trace,TraceLine,TraceIcon,TraceTitle,TraceCollapsible,TraceCollapsibleTrigger,TraceCollapsibleContent} from '@/components/ui/trace'
export function Task({className,...props}:ComponentProps<typeof Collapsible.Root>){return <Trace><TraceCollapsible className={cn('ai-task',className)} {...props}/></Trace>}
export function TaskTrigger({title,children,className,...props}:Omit<ComponentProps<typeof Collapsible.Trigger>,'title'>&{title:ReactNode}){return <TraceCollapsibleTrigger className={cn('ai-task-trigger',className)} {...props}><TraceLine><TraceIcon><ListChecks/></TraceIcon><TraceTitle>{title}</TraceTitle>{children}</TraceLine></TraceCollapsibleTrigger>}
export function TaskContent({className,children,...props}:ComponentProps<typeof Collapsible.Panel>){return <TraceCollapsibleContent keepMounted className={cn('ai-task-content',className)} {...props}><Trace>{children}</Trace></TraceCollapsibleContent>}
export function TaskItem({children,className,...props}:ComponentProps<'div'>){return <div className={cn('ai-task-item',className)} {...props}><TraceLine className="items-start"><TraceTitle className="whitespace-pre-wrap overflow-visible text-clip">{children}</TraceTitle></TraceLine></div>}
export function TaskItemFile(props:ComponentProps<'span'>){return <span className="ai-task-file" {...props}/>}
