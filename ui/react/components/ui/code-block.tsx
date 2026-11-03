// Retained plain-text composition from shadcn/ui base-nova Code Block (MIT).
import {Children,isValidElement,useState,type ComponentProps,type ReactNode} from 'react'
import {Check,Copy} from 'lucide-react'
import {Button} from './button'
import {cn} from '@/lib/cn'
export function CodeBlock({className,...props}:ComponentProps<'div'>){return <div data-slot="code-block" className={cn('group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg text-sm',className)} {...props}/>}
export function CodeBlockHeader(props:ComponentProps<'div'>){return <div data-slot="code-block-header" {...props}/>}
export function CodeBlockContent({children,...props}:ComponentProps<'pre'>){return <pre data-slot="code-block-content" dir="ltr" tabIndex={0} {...props}><code data-slot="code-block-code">{children}</code></pre>}
export function CodeBlockCopyButton({code}:{code:string}){
  const [copied,setCopied]=useState(false),[error,setError]=useState(false)
  return <Button variant="quiet" size="xs" isIconOnly aria-label={copied?'已复制代码':error?'复制失败，重试':'复制代码'} title={copied?'已复制':error?'复制失败，重试':'复制'} onClick={()=>{void navigator.clipboard.writeText(code).then(()=>{setCopied(true);setError(false)},()=>{setCopied(false);setError(true)})}} onBlur={()=>setCopied(false)}>{copied?<Check/>:<Copy/>}</Button>
}

export function MarkdownCodeBlock(input:unknown){
  const {children}=input as {children?:ReactNode}
  const element=Children.toArray(children).find(isValidElement)
  const props=element?.props as {children?:ReactNode;className?:string}|undefined
  const code=Children.toArray(props?.children??children).filter(value=>typeof value==='string'||typeof value==='number').join('')
  const language=props?.className?.match(/language-([^ ]+)/)?.[1]
  return <CodeBlock><CodeBlockHeader><span>{language&&language!=='text'?language:'代码'}</span><CodeBlockCopyButton code={code}/></CodeBlockHeader><CodeBlockContent>{code}</CodeBlockContent></CodeBlock>
}

