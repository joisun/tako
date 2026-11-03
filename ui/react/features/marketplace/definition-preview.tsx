import {defaultRehypePlugins} from 'streamdown'
import {MessageResponse} from '@/components/ai-elements/message'
import type {ComponentProps} from 'react'
const components={
  img:({alt}:ComponentProps<'img'>)=><span className="market-image-label">[图片：{alt||'来源插图'}]</span>,
  a:({href,children}:ComponentProps<'a'>)=><a href={href&&/^https:\/\//i.test(href)?href:undefined} target="_blank" rel="noreferrer noopener">{children}</a>,
}
export function DefinitionPreview({content}:{content:string}){
  return <MessageResponse mode="static" className="market-markdown" components={components} rehypePlugins={[defaultRehypePlugins.sanitize]}>{content}</MessageResponse>
}
