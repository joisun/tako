// AI Elements Task composition, using the existing Base UI Collapsible.
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronDown, ListChecks } from 'lucide-react'
import type { ComponentProps,ReactNode } from 'react'
import { cn } from '@/lib/cn'
export function Task({className,...props}:ComponentProps<typeof Collapsible.Root>){return <Collapsible.Root className={cn('ai-task',className)} {...props}/>}
export function TaskTrigger({title,children,...props}:Omit<ComponentProps<typeof Collapsible.Trigger>,'title'> & {title:ReactNode}){return <Collapsible.Trigger {...props}><ListChecks/><span>{title}</span>{children}<ChevronDown/></Collapsible.Trigger>}
export function TaskContent({className,...props}:ComponentProps<typeof Collapsible.Panel>){return <Collapsible.Panel className={cn('ai-task-content',className)} {...props}/>}
export function TaskItem(props:ComponentProps<'div'>){return <div className="ai-task-item" {...props}/>}
export function TaskItemFile(props:ComponentProps<'span'>){return <span className="ai-task-file" {...props}/>}
