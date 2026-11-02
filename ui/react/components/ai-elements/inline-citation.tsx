// AI Elements InlineCitation, adapted to Base UI PreviewCard for a single real source.
import { PreviewCard } from '@base-ui/react/preview-card'
import { ExternalLink } from 'lucide-react'
import type { ReactNode,ComponentProps } from 'react'
export function InlineCitation(props:ComponentProps<'span'>){return <span className="ai-inline-citation" {...props}/>}
export function InlineCitationText(props:ComponentProps<'span'>){return <span {...props}/>}
export function InlineCitationLink({href,children}:{href:string;children:ReactNode}){
  let source:URL
  try{source=new URL(href);if(!['https:','http:'].includes(source.protocol))return <span>{children}</span>}catch{return <span>{children}</span>}
  return <InlineCitation><PreviewCard.Root><PreviewCard.Trigger render={<a href={source.href} target="_blank" rel="noreferrer"/>}><InlineCitationText>{children}</InlineCitationText><ExternalLink/></PreviewCard.Trigger><PreviewCard.Portal><PreviewCard.Positioner sideOffset={6} className="ui-positioner"><PreviewCard.Popup className="ai-citation-card room-theme"><strong>{source.hostname}</strong><a href={source.href} target="_blank" rel="noreferrer">{source.href}</a></PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal></PreviewCard.Root></InlineCitation>
}
