import {useEffect,useRef,useState} from 'react'
import type {LoopPart,LoopRoomDetail,LoopTaskDetail} from '@/lib/api/loop-types'

type Snapshot={type:'snapshot';sequence:number;task:LoopTaskDetail;room:LoopRoomDetail}
type Update={type:'parts';sequence:number;run_id:string;parts:LoopPart[]}
type LiveState={task?:LoopTaskDetail;room?:LoopRoomDetail;connected:boolean}
function keepNativeTiming(incoming:LoopPart[],previous:LoopPart[]|null|undefined=[]){
  const known=new Map((previous??[]).map(part=>[part.id,part]))
  return incoming.map(part=>{
    const old=known.get(part.id)
    if(old?.updated_at&&part.updated_at&&old.updated_at>part.updated_at)return old
    return old?{...part,phase:part.phase??old.phase,origin:part.origin??old.origin,created_at:old.created_at??part.created_at,sequence:old.sequence??part.sequence,timing_source:old.timing_source??part.timing_source}:part
  })
}
export function applyTeamUpdate(current:LoopTaskDetail,event:Update){
  return {...current,runs:current.runs.map(run=>{
    if(run.id!==event.run_id)return run
    const updates=new Map(event.parts.map(part=>[part.id,part]))
    const parts=(run.parts??[]).map(part=>{const update=updates.get(part.id);updates.delete(part.id);return update?keepNativeTiming([update],[part])[0]:part})
    return {...run,parts:[...parts,...updates.values()]}
  })}
}
export function useTeamStream(base:LoopTaskDetail|undefined,roomId:string,baseRoom?:LoopRoomDetail){
  const [live,setLive]=useState<LiveState>({connected:false})
  const baseline=useRef(base);baseline.current=base
  const id=base?.id,ready=!!base
  useEffect(()=>{
    setLive({connected:false})
    if(!id||!ready||typeof EventSource!=='function')return
    let closed=false,sequence=-1,awaitingSnapshot=true
    const source=new EventSource(`/api/v1/loop-tasks/${encodeURIComponent(id)}/events`)
    source.addEventListener('team',event=>{
      if(closed)return
      let update:Snapshot|Update
      try{update=JSON.parse((event as MessageEvent).data)}catch{return}
      if(!Number.isSafeInteger(update.sequence))return
      if(update.type==='snapshot'){
        if(update.task?.id!==id||update.room?.id!==roomId||!Array.isArray(update.task.runs))return
        if(!awaitingSnapshot&&update.sequence<=sequence)return
        awaitingSnapshot=false;sequence=update.sequence
        setLive(current=>{
          const previous=current.task?.id===id?current.task:baseline.current
          const runs=update.task.runs.map(run=>({...run,parts:keepNativeTiming(run.parts??[],previous?.runs.find(value=>value.id===run.id)?.parts)}))
          return {connected:true,task:{...update.task,runs},room:update.room}
        })
      }else if(update.type==='parts'&&update.sequence>sequence&&Array.isArray(update.parts)){
        sequence=update.sequence
        setLive(current=>current.connected&&current.task?.id===id?{...current,task:applyTeamUpdate(current.task!,update)}:current)
      }
    })
    source.addEventListener('error',()=>{awaitingSnapshot=true;if(!closed)setLive(current=>({...current,connected:false}))})
    return ()=>{closed=true;source.close()}
  },[id,ready,roomId])
  useEffect(()=>{
    if(!base)return
    setLive(current=>{
      if(current.connected||current.task?.id!==base.id)return current
      const runs=base.runs.map(run=>{
        const old=current.task!.runs.find(value=>value.id===run.id)
        if(!old)return run
        const ids=new Set((run.parts??[]).map(part=>part.id))
        return {...(old.finished_at&&!run.finished_at?old:run),parts:[...keepNativeTiming(run.parts??[],old.parts),...(old.parts??[]).filter(part=>!ids.has(part.id))]}
      })
      const ids=new Set(runs.map(run=>run.id))
      let room=current.room
      if(baseRoom?.id===roomId){
        const messages=new Map((room?.messages??[]).map(message=>[message.id,message]))
        for(const message of baseRoom.messages)messages.set(message.id,message)
        room={...baseRoom,messages:[...messages.values()].sort((a,b)=>a.sequence-b.sequence).slice(-200)}
      }
      return {...current,room,task:{...base,runs:[...runs,...current.task!.runs.filter(run=>!ids.has(run.id))]}}
    })
  },[base,baseRoom,roomId])
  return live.task?.id===id&&live.room?.id===roomId?live:{connected:false}
}
