import { Avatar,Style } from '@dicebear/core'
import micah from '@dicebear/styles/micah.json'
import { useMemo } from 'react'
import type { LoopAvatar } from '@/lib/api/loop-types'
const style=new Style(micah)
export function AgentAvatar({id,avatar,name}:{id:string;avatar?:LoopAvatar|null;name:string}){
  const src=useMemo(()=>new Avatar(style,{seed:avatar?.seed??id,...Object.fromEntries(Object.entries(avatar??{}).filter(([key])=>!['seed','style','version'].includes(key)).map(([key,value])=>[key,[value]]))}).toDataUri(),[id,avatar])
  return <img className="agent-avatar-image size-full object-contain" src={src} alt={`${name}的头像`} width={32} height={32}/>
}
