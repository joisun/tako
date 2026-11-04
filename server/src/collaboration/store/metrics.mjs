export function executionMetrics(runs,events,asOf=new Date().toISOString()) {
  const elapsed=(start,end)=>start&&end?Math.max(0,Date.parse(end)-Date.parse(start)):null
  const byRun=new Map()
  for(const event of events){if(!byRun.has(event.run_id))byRun.set(event.run_id,new Map());const entries=byRun.get(event.run_id);if(!entries.has(event.kind))entries.set(event.kind,event)}
  const sessions=new Map(),timings={}
  for(const run of runs){
    const facts=byRun.get(run.id)??new Map(),claimed=facts.get('run_claimed')?.created_at,spawned=facts.get('run_spawned')?.created_at,response=facts.get('first_response'),accepted=facts.get('input_delivered')?.created_at
    timings[run.id]={queued_ms:elapsed(run.created_at,claimed??(run.status==='queued'?asOf:null)),resource_wait_ms:elapsed(facts.get('resource_waiting')?.created_at,claimed??(run.status==='queued'?asOf:null)),startup_ms:elapsed(spawned,accepted),model_wait_ms:elapsed(accepted,response?.payload.observed_at??response?.created_at??(['starting','running'].includes(run.status)?asOf:null)),processing_ms:elapsed(claimed,run.finished_at),claimed_at:claimed??null,spawned_at:spawned??null,first_response_at:response?.payload.observed_at??response?.created_at??null,waiting_for_resources:run.status==='queued'&&facts.has('resource_waiting')}
    const usage=run.parts?.find(part=>part.type==='usage')?.usage??run.result?.usage
    if(!run.session_id||!usage?.total)continue
    const native=run.input?.native_session,provider=native?.provider??run.member_snapshot?.runtime_id
    if(!provider)continue
    const key=JSON.stringify([provider,native?.store_id??'',run.session_id]),entry=sessions.get(key)??{provider,session_id:run.session_id,total:{}}
    for(const [name,count]of Object.entries(usage.total))if(Number.isFinite(count)&&count>=0)entry.total[name]=Math.max(entry.total[name]??0,count)
    sessions.set(key,entry)
  }
  const total={}
  for(const session of sessions.values())for(const [name,count]of Object.entries(session.total))total[name]=(total[name]??0)+count
  return{runs:timings,usage:{total,native_sessions:sessions.size,method:'max_per_provider_store_session',unattributed_runs:runs.filter(run=>!run.session_id&&(run.result?.usage||run.parts?.some(part=>part.type==='usage'))).length}}
}
