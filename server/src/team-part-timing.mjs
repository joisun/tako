import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {createCodexSessionInventory} from './codex/session-inventory.mjs'
import {createCodexRolloutTiming} from './runtime/codex-rollout-timing.mjs'

// Read native timestamps by exact item ID. Never infer event time from text or Run start.
export function createTeamPartTiming({dataRoot=process.env.CODEX_HOME??join(homedir(),'.codex')}={}){
  const root=resolve(dataRoot),storeId=createHash('sha256').update(root).digest('hex').slice(0,20)
  const inventories=['sessions','archived_sessions'].map(directory=>createCodexSessionInventory({sessionsRoot:join(root,directory)}))
  const timing=createCodexRolloutTiming({dataRoot:root,resolvePath:metadata=>metadata.path})
  return async run=>{
    if(!run.session_id||!run.parts?.some(part=>!Number.isFinite(Date.parse(part.created_at))||part.type==='text'&&(!part.phase||!part.origin)))return run
    const reference=run.input?.native_session
    if(run.member_snapshot?.runtime_id!=='codex'||reference&&(reference.provider!=='codex'||reference.store_id!==storeId||reference.session_id!==run.session_id))return run
    const paths=(await Promise.all(inventories.map(inventory=>inventory.path(run.session_id)))).filter(Boolean)
    if(paths.length!==1)return run
    const parts=await timing.hydrateParts({path:paths[0]},run.parts)
    const start=Date.parse(run.created_at),end=run.finished_at?Date.parse(run.finished_at):Infinity
    return {...run,parts:parts.map((part,index)=>part.created_at&&!(Date.parse(part.created_at)>=start&&Date.parse(part.created_at)<=end)?run.parts[index]:part)}
  }
}
