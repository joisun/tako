// AI Elements ModelSelector uses the existing cmdk and Base UI Dialog composition.
import { Command as CommandPrimitive } from 'cmdk'
import { Command,CommandList,CommandItem,CommandEmpty,CommandGroup } from '@/components/ui/command'
import { Dialog,DialogContent,DialogHeader,DialogTitle } from '@/components/ui/dialog'
import type { ComponentProps,ReactNode } from 'react'
export const ModelSelector=Dialog
export function ModelSelectorContent({children,...props}:ComponentProps<typeof DialogContent>){return <DialogContent className="room-dialog room-theme room-model-selector" showCloseButton {...props}><DialogHeader><DialogTitle>选择模型</DialogTitle></DialogHeader><Command>{children}</Command></DialogContent>}
export function ModelSelectorInput(props:ComponentProps<typeof CommandPrimitive.Input>){return <CommandPrimitive.Input className="ui-input" placeholder="搜索模型…" {...props}/>}
export const ModelSelectorList=CommandList
export const ModelSelectorItem=CommandItem
export const ModelSelectorGroup=CommandGroup
export function ModelSelectorEmpty({children}:{children?:ReactNode}){return <CommandEmpty>{children??'没有匹配的模型'}</CommandEmpty>}
