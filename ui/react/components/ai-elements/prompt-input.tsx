// AI Elements PromptInput structure, with a Tiptap editor slot and server-path references.
// Browser uploads/drop handling are omitted: the product references files on its server.
import { forwardRef,type ComponentProps } from 'react'
import { LoaderCircle,Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
export const PromptInput=forwardRef<HTMLFormElement,ComponentProps<'form'>>(function PromptInput({className,...props},ref){return <form ref={ref} className={cn('ai-prompt-input',className)} {...props}/>})
export function PromptInputBody(props:ComponentProps<'div'>){return <div className="ai-prompt-body" {...props}/>}
export function PromptInputHeader(props:ComponentProps<'div'>){return <div className="ai-prompt-header" {...props}/>}
export function PromptInputFooter(props:ComponentProps<'div'>){return <div className="ai-prompt-footer" {...props}/>}
export function PromptInputTools(props:ComponentProps<'div'>){return <div className="ai-prompt-tools" {...props}/>}
export function PromptInputButton(props:ComponentProps<typeof Button>){return <Button size="sm" variant="quiet" {...props}/>}
export function PromptInputSubmit({status='ready',disabled,...props}:ComponentProps<typeof Button>&{status?:'ready'|'submitted'|'error'}){const waiting=status==='submitted';return <Button type="submit" size="sm" variant="primary" disabled={disabled||waiting} aria-busy={waiting||undefined} {...props}>{waiting?<LoaderCircle className="room-spinner"/>:<Send/>}<span>{waiting?'发送中':'发送'}</span></Button>}
