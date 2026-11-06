import type { LoopAvatar } from './loop-types'
export interface GuidedMember {
  id:string; name:string; candidate_id:string|null; responsibilities:string; reason:string
  runtime_id:'codex'|'claude'; model:string|null; effort:string|null; leader:boolean; avatar:LoopAvatar
}
export interface GuidedDraft {title:string;summary:string;acceptance:string;members:GuidedMember[];message?:string}
export interface GuidedMessage {role:'user'|'assistant';content:string;revision:number}
export interface GuidedActivity {id:string;kind:'search'|'definition';state:'running'|'succeeded'|'failed';query:string;name?:string;total?:number;matches?:{name:string;source_name:string}[];sources?:string[];error?:string;revision:number}
export interface GuidedCandidate {id:string;name:string;description:string;source_name:string;kind:'local'|'market';license:string|null;url:string|null;instructions:string}
export interface GuidedPlan {
  id:string; status:'queued'|'running'|'ready'|'failed'|'canceled'|'interrupted'|'created'
  phase:'queued'|'catalog'|'starting'|'generating'|'review'
  requirements:string;workspace:string|null;planner:{runtime_id:'codex'|'claude';model:string|null;effort:string|null}
  draft:GuidedDraft|null;candidates:GuidedCandidate[];warnings:string[];error:string|null
  session_id:string|null;created_room_id:string|null;created_at:string;finished_at:string|null
  parent_id:string|null;revision:number;messages:GuidedMessage[];activities:GuidedActivity[]
}
export interface GuidedRequest {request_key:string;requirements:string;workspace?:string|null;runtime_id:'codex'|'claude';model:string|null;effort:string|null}
export interface GuidedCreation extends GuidedDraft {confirm:true;start:boolean}
export interface GuidedRefinement {request_key:string;feedback:string;draft:GuidedDraft}
