// Retained exports from shadcn/ui base-nova Input Group (MIT).
import type {ComponentProps} from 'react'
import {cn} from '@/lib/cn'
import {Button} from './button'
export function InputGroup({className,...props}:ComponentProps<'div'>){return <div data-slot="input-group" role="group" className={cn('group/input-group relative flex w-full min-w-0 flex-col rounded-lg border border-input transition-colors outline-none focus-within:border-ring',className)} {...props}/>}
export function InputGroupAddon({className,align='inline-start',...props}:ComponentProps<'div'>&{align?:'inline-start'|'inline-end'|'block-start'|'block-end'}){
  return <div role="group" data-slot="input-group-addon" data-align={align} className={cn('flex w-full items-center gap-2 text-sm text-muted-foreground',align==='block-start'?'order-first':'order-last',className)} onClick={event=>{if((event.target as HTMLElement).closest('button'))return;event.currentTarget.parentElement?.querySelector<HTMLElement>('[data-slot=input-group-control]')?.focus()}} {...props}/>
}
export function InputGroupButton({type='button',size='sm',variant='quiet',...props}:ComponentProps<typeof Button>){return <Button type={type} size={size} variant={variant} {...props}/>}
