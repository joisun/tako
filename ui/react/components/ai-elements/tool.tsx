// AI Elements Tool composition; protocol data uses Rillo's typed runtime parts.
import { Collapsible } from '@base-ui/react/collapsible'
import { Check, ChevronDown, LoaderCircle, Wrench, X } from 'lucide-react'
import type { ComponentProps } from 'react'
export function Tool(props:ComponentProps<typeof Collapsible.Root>){return <Collapsible.Root className="room-tool" {...props}/>}
export function ToolHeader({title,state}:{title:string;state:string}){const Icon=state==='completed'?Check:state==='failed'?X:LoaderCircle;return <Collapsible.Trigger><Wrench/><span>{title}</span><Icon className={state==='running'?'room-spinner':''}/><small>{state==='completed'?'已完成':state==='failed'?'失败':state==='running'?'执行中':'已中断'}</small><ChevronDown/></Collapsible.Trigger>}
export const ToolContent=Collapsible.Panel
export function ToolInput({input}:{input?:string}){return input?<div><small>输入</small><pre>{input}</pre></div>:null}
export function ToolOutput({output}:{output?:string}){return output?<div><small>结果</small><pre>{output}</pre></div>:null}
