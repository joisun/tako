// AI Elements Attachments composition, for service-side file references rather than uploads.
import type { ComponentProps } from 'react'
import { FileText, ImageIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
export function Attachments(props:ComponentProps<'div'>){return <div className="room-attachments" {...props}/>}
export function Attachment(props:ComponentProps<'div'>){return <div className="room-attachment" {...props}/>}
export function AttachmentInfo({name,path,mediaType}:{name:string;path:string;mediaType:string}){const Icon=mediaType.startsWith('image/')?ImageIcon:FileText;return <><Icon/><span title={path}>{name}</span></>}
export function AttachmentRemove({onClick,name}:{onClick:()=>void;name:string}){return <Button size="xs" variant="quiet" isIconOnly aria-label={`移除 ${name}`} onClick={onClick}><X/></Button>}
