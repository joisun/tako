// Persist only provider-visible message parts. Raw protocol frames and credentials are excluded.
const MAX_PARTS=160,MAX_TEXT=24000
const trim=value=>String(value??'').slice(-MAX_TEXT)
function publicValue(value){
  if(value==null)return undefined
  if(typeof value==='string')return trim(value)
  return trim(JSON.stringify(value,(key,nested)=>/token|authorization|password|secret|api.?key/i.test(key)?'[redacted]':nested))
}
export function createRunParts(record,changed,{clock=()=>new Date()}={}){
  const parts=[],dirty=new Set()
  let timer=null
  function flush(){if(timer)clearTimeout(timer);timer=null;record(parts);const updates=parts.filter(part=>dirty.has(part.id));dirty.clear();changed(updates)}
  function emit(event){
    const payload=event.payload??{},type=event.type
    if(!['thinking','assistant_delta','activity_started','activity_completed','tool_result','usage_updated'].includes(type))return
    if(type==='thinking'&&!payload.text&&!payload.state)return
    const kind=type==='usage_updated'?'usage':type==='thinking'?'reasoning':type==='assistant_delta'?'text':'tool',id=String(payload.item_id??kind).slice(0,200)
    let part=parts.find(value=>value.id===id&&value.type===kind)
    const at=event.observedAt??new Date(clock()).toISOString()
    if(!part){if(parts.length>=MAX_PARTS)return;part={id,type:kind,text:'',state:'running',created_at:at,sequence:event.sequence??parts.length+1,timing_source:'observed'};parts.push(part)}
    part.updated_at=at;dirty.add(part.id)
    if(payload.truncated)part.truncated=true
    if(kind==='text'){if(['commentary','partial_answer','final_answer'].includes(payload.phase))part.phase=payload.phase;if(['agent','hook'].includes(payload.origin))part.origin=payload.origin}
    if(kind==='usage'){part.usage=payload.usage;part.state='completed'}
    else if(kind==='tool'){
      if(payload.label)part.label=trim(payload.label)
      if(Array.isArray(payload.files))part.files=payload.files.slice(0,64).map(file=>({path:String(file.path).slice(0,2048),kind:file.kind}))
      if(payload.input!==undefined)part.input=publicValue(payload.input)
      if(payload.output!==undefined)part.output=publicValue(payload.output)
      if(type==='tool_result')part.output=trim((part.output??'')+(payload.text??''))
      if(type==='activity_completed')part.state=payload.state==='failed'?'failed':'completed'
    }else if(kind==='reasoning'&&(Array.isArray(payload.summary)||Number.isSafeInteger(payload.summary_index))){
      if(Array.isArray(payload.summary))part.summary=payload.summary.slice(0,64).map((text,index)=>({index,text:trim(text)}))
      else{
        part.summary??=[]
        let section=part.summary.find(value=>value.index===payload.summary_index)
        if(!section&&part.summary.length<64){section={index:payload.summary_index,text:''};part.summary.push(section)}
        if(section)section.text=trim(section.text+(payload.text??''))
      }
      part.summary.sort((a,b)=>a.index-b.index)
      const combined=part.summary.map(value=>value.text).join('\n\n');if(combined.length>MAX_TEXT)part.truncated=true
      part.text=trim(combined)
    }else{const text=payload.delta===false?payload.text:part.text+(typeof payload.delta==='string'?payload.delta:payload.text??'');if(String(text??'').length>MAX_TEXT)part.truncated=true;part.text=trim(text)}
    if(kind!=='tool'&&payload.state==='completed')part.state='completed'
    if(JSON.stringify(parts).length>256000)for(const value of parts){dirty.add(value.id);if(value.summary)value.summary=value.summary.map(section=>({...section,text:section.text.slice(-256)}));for(const key of ['text','input','output'])if(value[key]?.length>1024){value[key]=value[key].slice(-1024);value.truncated=true}}
    if(!timer){timer=setTimeout(flush,180);timer.unref?.()}
  }
  return {emit,flush}
}
