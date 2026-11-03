import {createRunEventHub} from '../runs/run-event-hub.mjs'

// The store remains authoritative. Every connection starts from a durable snapshot;
// only normalized public part updates follow, never raw provider frames.
export function createTeamLiveStream(store){
  const hub=createRunEventHub(),sequences=new Map(),subscribers=new Map(),listeners=new Set()
  const snapshot=id=>{const task=store.detail(id);return {task,room:store.room(task.room_id)}}
  function publish(id,type,payload,terminal=false){
    const sequence=(sequences.get(id)??0)+1;sequences.set(id,sequence)
    hub.publish({runId:id,sequence,type:terminal?'done':'update',payload:{type,...payload}})
  }
  function refresh(){for(const id of subscribers.keys())publish(id,'snapshot',snapshot(id))}
  function subscribe(id,listener){
    const value=snapshot(id),sequence=sequences.get(id)??0
    const deliver=event=>{try{listener(event)}catch{}}
    deliver({type:'snapshot',sequence,...value})
    listeners.add(deliver)
    subscribers.set(id,(subscribers.get(id)??0)+1)
    const unsubscribe=hub.subscribe(id,event=>deliver({sequence:event.sequence,...event.payload}),{afterSequence:sequence})
    return ()=>{unsubscribe();listeners.delete(deliver);const count=(subscribers.get(id)??1)-1;if(count)subscribers.set(id,count);else subscribers.delete(id)}
  }
  return {
    subscribe,refresh,
    parts(taskId,runId,parts){if(parts.length)publish(taskId,'parts',{run_id:runId,parts})},
    finished(taskId){publish(taskId,'snapshot',snapshot(taskId),true)},
    close(){for(const listener of listeners)listener({type:'closed'});hub.close();listeners.clear();subscribers.clear();sequences.clear()},
  }
}
