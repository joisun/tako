// These are the instruction transport paths already used by Rillo, not global CLI installers.
export const marketplaceRuntimeAdapters=Object.freeze([
  {id:'codex',name:'Codex',instructions_supported:true,transport:'Rillo Run.prompt → Codex turn/start text input',native_install:false,session_creation_supported:false},
  {id:'claude',name:'Claude Code',instructions_supported:true,transport:'Rillo Run.prompt → Claude stdin',native_install:false,session_creation_supported:false},
  {id:'opencode',name:'OpenCode',instructions_supported:false,transport:null,native_install:false,session_creation_supported:false},
])
export function agentSessionContext(installed){
  return {definition_id:installed.definition_id,installed_id:installed.id,source_id:installed.source_id,version:installed.installed_version,digest:installed.definition.digest,instructions:installed.definition.instructions,session_creation_supported:false,reason:'现有 Sessions API 支持浏览、恢复和投递到已有会话，尚未提供带角色定义创建独立会话的接口。此操作不会启动 Agent。',adapters:marketplaceRuntimeAdapters}
}
