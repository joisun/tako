import type { TeamSessionIdentity } from '@/lib/api/types'
import { AgentAvatar } from './agent-avatar'
export function SessionAgent({team}:{team:TeamSessionIdentity}){return <span className="session-team-agent"><span className="session-team-avatar"><AgentAvatar id={team.member_id} name={team.alias} avatar={team.avatar}/></span><span title={team.alias}>{team.alias}</span>{team.leader&&team.alias!=='Leader'?<small>Leader</small>:null}</span>}
