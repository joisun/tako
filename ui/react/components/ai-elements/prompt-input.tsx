// shadcn/ui Prompt Input composition. Tiptap is the custom Input Group control.
// File selection, clipboard and drop events are owned by the Teams composer.
import { forwardRef,type ComponentProps } from 'react'
import { ArrowUp,LoaderCircle } from 'lucide-react'
import {InputGroup,InputGroupAddon,InputGroupButton} from '@/components/ui/input-group'
export const PromptInput=forwardRef<HTMLFormElement,ComponentProps<'form'>>(function PromptInput({className,children,...props},ref){return <form ref={ref} className={className} {...props}><InputGroup className="ai-prompt-input">{children}</InputGroup></form>})
export function PromptInputBody(props:ComponentProps<'div'>){return <div className="ai-prompt-body" {...props}/>}
export function PromptInputHeader(props:ComponentProps<'div'>){return <InputGroupAddon align="block-start" className="ai-prompt-header" {...props}/>}
export function PromptInputFooter(props:ComponentProps<'div'>){return <InputGroupAddon align="block-end" className="ai-prompt-footer" {...props}/>}
export function PromptInputTools(props:ComponentProps<'div'>){return <div className="ai-prompt-tools" {...props}/>}
export function PromptInputButton(props:ComponentProps<typeof InputGroupButton>){return <InputGroupButton size="sm" variant="quiet" {...props}/>}
export function PromptInputSubmit({status='ready',disabled,...props}:ComponentProps<typeof InputGroupButton>&{status?:'ready'|'submitted'|'error'}){const waiting=status==='submitted';return <InputGroupButton type="submit" size="sm" variant="primary" disabled={disabled||waiting} aria-busy={waiting||undefined} {...props}>{waiting?<LoaderCircle className="room-spinner"/>:<ArrowUp/>}<span>{waiting?'发送中':'发送'}</span></InputGroupButton>}
