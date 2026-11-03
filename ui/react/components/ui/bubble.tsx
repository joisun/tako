// Retained non-interactive exports from shadcn/ui base-nova Bubble (MIT).
import type {ComponentProps} from 'react'
import {cn} from '@/lib/cn'
export function Bubble({variant='muted',className,...props}:ComponentProps<'div'>&{variant?:'muted'|'ghost'}){return <div data-slot="bubble" data-variant={variant} className={cn('group/bubble relative flex min-w-0 max-w-full flex-col',className)} {...props}/>}
export function BubbleContent({className,...props}:ComponentProps<'div'>){return <div data-slot="bubble-content" className={cn('min-w-0 max-w-full text-sm leading-relaxed wrap-break-word',className)} {...props}/>}
