export type LoopTaskStatus = 'active' | 'paused' | 'waiting' | 'review' | 'completed' | 'failed' | 'canceled'
export type LoopPhase = 'leading' | 'planning' | 'discussing' | 'converging' | 'implementing' | 'verifying' | 'delivery'
export interface AgentDefinition {
  id: string; name: string; slug?: string; description: string; instructions?: string; model?: string | null
  tools?: string[]; skills?: string[]; runtimes?: string[]
  variants?: Record<string, AgentDefinition>
  source?: { kind: string; label: string; path?: string; url?: string; revision?: string; digest?: string; license?: string; origin?:{id:string;label?:string;url?:string;revision?:string;license?:string;digest?:string} }
}
export interface AgentCatalogSource {id:string;name:string;repository?:string;ref?:string;license?:string;url?:string;revision?:string}
export interface AgentCatalog { definitions: AgentDefinition[]; errors: { source: string; message: string }[]; source?:AgentCatalogSource; fetched_at?:string }
export interface LoopAvatar {seed:string;style?:string;version?:number;hairVariant?:string;eyesVariant?:string;baseColor?:string;hairColor?:string;shirtColor?:string}
export interface LoopUsage {total:Partial<Record<'inputTokens'|'cachedInputTokens'|'cacheWriteInputTokens'|'outputTokens'|'reasoningOutputTokens'|'totalTokens',number>>;last:LoopUsage['total'];modelContextWindow:number|null}
export interface LoopPart {created_at?:string;updated_at?:string;sequence?:number;timing_source?:'observed'|'native';id:string;type:'reasoning'|'text'|'tool'|'usage';phase?:'commentary'|'partial_answer'|'final_answer';origin?:'agent'|'hook';text:string;state:string;truncated?:boolean;label?:string;input?:string;output?:string;summary?:{index:number;text:string}[];files?:{path:string;kind:'add'|'update'|'delete'}[];usage?:LoopUsage}
export interface LoopMember { id: string; room_id: string; name: string; runtime_id: 'codex' | 'claude'; instructions: string; profile?: AgentDefinition | null; avatar?:LoopAvatar|null; execution_config?: {model:string|null;effort?:string|null} | null }
export interface LoopSubmission {summary:string;verdict:string;artifacts:string[]}
export interface LoopRun {
  id: string; task_id: string; member_id: string; phase: LoopPhase; stage: number; status: string
  revision: number; generation: number; attempt: number; pid: number | null; session_id: string | null
  error_code: string | null; created_at: string; finished_at: string | null
  routing?: { intent: string; write_access: boolean; assignment?: string; reply_expected?:boolean; parent_run_id?: string | null } | null
  submission?:LoopSubmission|null;parts?:LoopPart[]|null;member_snapshot?:LoopMember|null
  result: { final_message?: string | null; submission?: LoopSubmission | null;usage?:LoopUsage|null;file_changes?:{path:string;kind:string}[] } | null
}
export interface LoopTask {
  id: string; room_id: string; title: string; goal: string; acceptance: string; workspace: string
  status: LoopTaskStatus; phase: LoopPhase; revision: number; generation: number
  config: { workflow?: string; leader?: string; source_workspace: string|null; resources?:{source_workspace:string;workspace:string;branch:string|null;execution_mode?:'isolated'|'existing_branch'|'in_place';requested_branch?:string|null;base_commit?:string|null;dirty?:boolean|null}[]; imported?:boolean; branch: string | null; coordinator: string; implementer?: string; verifier?: string; participants: string[]; max_runs?: number; timeout_seconds?: number }
  created_at: string; updated_at: string
}
export interface LoopTaskDetail extends LoopTask {
  runs: LoopRun[]
  events: { sequence: number; kind: string; run_id: string | null; payload: Record<string, unknown>; created_at: string }[]
}
export type LoopMessageIntent = 'delegate' | 'verify' | 'reply' | 'announce'
export interface LoopMessage { id: string; sequence: number; task_id: string | null; run_id: string | null; author: string; text: string; created_at: string; intent?:LoopMessageIntent|null; mentions?: string[] | null;author_snapshot?:LoopMember|null;attachments?:LoopAttachment[]|null }
export interface LoopAttachment {path:string;name:string;media_type:string;size:number;digest:string;text?:string;truncated?:boolean}
export interface LoopRoom { id: string; title: string; created_at: string; config?: { dissolved_at?:string|null;deleted_at?:string|null;leader_id: string | null; workspace: string | null; workspaces?:string[]; memory_directory?:string|null; instructions?: string } | null }
export interface LoopRoomDetail extends LoopRoom { definition_deletions?:{member_id:string;state:string}[]; memory_sync?:{revision:number;exported_revision:number;last_error:string|null}; members: LoopMember[]; tasks: LoopTask[]; messages: LoopMessage[] }
export interface LoopTaskInput {
  title: string; goal: string; acceptance: string; workspace: string; coordinator: string; implementer: string; verifier: string
  participants: string[]; request_key: string; timeout_seconds?: number; max_runs?: number
}

export interface RoomRuntime { id:string; state:'ready'|'unavailable'; source:string; models:{id:string;displayName?:string;reasoningLevels?:(string|{reasoningEffort?:string;reasoning_effort?:string})[];defaultReasoningLevel?:string}[]; model_override_supported:boolean; error_code?:string|null }
export type WorkItemColumn = 'backlog'|'working'|'review'|'done'
export interface RoomWorkItem { id:string; room_id:string; number:number; name:string; column:WorkItemColumn; owner_id:string|null; type:'task'|'bug'|'review'|'note'; details:string; position:number; created_at:string; updated_at:string; [key:string]:unknown }
export interface RoomBoard {revision:number;items:RoomWorkItem[]}
export interface RoomMemberDefinition {member:LoopMember;definition:AgentDefinition|null;source:'snapshot'|'local'|'missing';message?:string}
