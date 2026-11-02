// Persist only provider-visible message parts. Raw protocol frames and credentials are excluded.
const MAX_PARTS=160,MAX_TEXT=24000
const trim=value=>String(value??'').slice(-MAX_TEXT)
function publicValue(value){
  if(value==null)return undefined
  if(typeof value==='string')return trim(value)
  return trim(JSON.stringify(value,(key,nested)=>/token|authorization|password|secret|api.?key/i.test(key)?'[redacted]':nested))
}
export function createRunParts(record,changed){
  const parts=[]
  let timer=null
  function flush(){if(timer)clearTimeout(timer);timer=null;record(parts);changed()}
  function emit(event){
    const payload=event.payload??{},type=event.type
    if(!['thinking','assistant_delta','activity_started','activity_completed','tool_result'].includes(type))return
    if(type==='thinking'&&!payload.text)return
    const kind=type==='thinking'?'reasoning':type==='assistant_delta'?'text':'tool',id=String(payload.item_id??kind).slice(0,200)
    let part=parts.find(value=>value.id===id&&value.type===kind)
    if(!part){if(parts.length>=MAX_PARTS)return;part={id,type:kind,text:'',state:'running'};parts.push(part)}
    if(kind==='tool'){
      if(payload.label)part.label=trim(payload.label)
      if(payload.input!==undefined)part.input=publicValue(payload.input)
      if(payload.output!==undefined)part.output=publicValue(payload.output)
      if(type==='tool_result')part.output=trim((part.output??'')+(payload.text??''))
      if(type==='activity_completed')part.state=payload.state==='failed'?'failed':'completed'
    }else part.text=trim(payload.delta===false?payload.text:part.text+(typeof payload.delta==='string'?payload.delta:payload.text??''))
    if(JSON.stringify(parts).length>256000)for(const value of parts){for(const key of ['text','input','output'])if(value[key]?.length>1024){value[key]=value[key].slice(-1024);value.truncated=true}}
    if(!timer){timer=setTimeout(flush,180);timer.unref?.()}
  }
  return {emit,flush}
}
