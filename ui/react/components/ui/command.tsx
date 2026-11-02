// shadcn/ui Command composition, using cmdk for selection and keyboard navigation.
// Uses no Command.Dialog: application overlays remain Base UI.
import { Command as CommandPrimitive } from 'cmdk'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn('ui-command', className)} {...props} />
}
export const CommandList = CommandPrimitive.List
export const CommandGroup = CommandPrimitive.Group
export const CommandItem = CommandPrimitive.Item
export const CommandEmpty = CommandPrimitive.Empty
