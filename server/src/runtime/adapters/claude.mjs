import { runtimeEvent } from '../runtime-event.mjs'
import { runtimeError } from '../runtime-errors.mjs'

// Claude discussion uses an actual built-in tool allowlist, not a prompt-only restriction.
export function createClaudeRuntimeDefinition() {
  return Object.freeze({
    id: 'claude', displayName: 'Claude Code',
    launch: { overrideEnv: 'CLAUDE_BIN', executableNames: ['claude'], packagedCandidates: [], platformResolvers: [] },
    versionProbe: { args: ['--version'], timeout_ms: 5000 },
    capabilities: { modelSelection: true, sandbox: false, sessionResume: true, collaboration: true, scheduledExecution: false, collaborationWrite: false },
    fallbackModels: [{ id: 'default', displayName: 'Default (CLI config)', reasoningLevels: [] }],
    async buildExecutionInvocation({ launch, spec }) {
      if (spec.sandbox_mode !== 'read-only') throw runtimeError('LOOP_WRITE_UNSUPPORTED', 'Claude 实施权限尚未通过验证；请选择 Codex 实施，Claude 可参与讨论与审阅')
      const toolServer = spec.planner_mcp ? 'tako_team_planner' : 'tako_loop'
      const mcp = spec.planner_mcp ?? spec.loop_mcp
      const allowedTools = spec.planner_mcp ? ['search_agents','get_agent_definition'] : ['read_context','submit_result','request_action','report_progress','send_message','remember']
      const args = ['--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk',
        '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}',
        '--mcp-config', JSON.stringify({ mcpServers: mcp ? { [toolServer]: { ...mcp, env: Object.fromEntries(Object.keys(spec.execution_env ?? {}).map(key => [key, '${' + key + '}'])) } } : {} }),
        '--allowedTools', ['Read','Glob','Grep',...allowedTools.map(name=>'mcp__'+toolServer+'__'+name)].join(',')]
      for (const workspace of spec.additional_workspaces??[]) args.push('--add-dir',workspace)
      if (spec.model) args.push('--model', spec.model)
      if (spec.resume_session_id) args.push('--resume', spec.resume_session_id)
      return { command: launch.executable, args, cwd: spec.workspace, stdin: spec.prompt,
        timeout_ms: spec.timeout_seconds == null ? null : spec.timeout_seconds * 1000, env: spec.execution_env ?? {} }
    },
    normalizeResult(result) {
      if (result.status !== 'succeeded' || result.usage?.is_error !== true) return result
      return { ...result, status: 'failed', error_code: 'RUNTIME_PROVIDER_ERROR' }
    },
    parseEvent(line, context) {
      let value
      try { value = JSON.parse(line) } catch { return [] }
      const event = (type, payload) => runtimeEvent({ runId: context.runId, sequence: context.sequence, observedAt: context.observedAt, type, payload })
      if (value.type === 'system' && value.subtype === 'init' && value.session_id) return [event('session', { session_id: value.session_id })]
      if(value.type==='assistant' && Array.isArray(value.message?.content))return value.message.content.flatMap((part,index)=>{
        const item_id=`${value.message.id??value.uuid}:${index}`
        if(part.type==='thinking' && typeof part.thinking==='string')return [event('thinking',{item_id,text:part.thinking,delta:false,state:'completed'})]
        if(part.type==='text')return [event('assistant_delta',{item_id,text:part.text,delta:false,state:'completed'})]
        if(part.type==='tool_use')return [event('activity_started',{item_id:part.id,label:part.name,input:part.input})]
        return []
      })
      if(value.type==='user' && Array.isArray(value.message?.content))return value.message.content.filter(part=>part.type==='tool_result').map(part=>event('activity_completed',{item_id:part.tool_use_id,label:'工具调用',state:part.is_error?'failed':'completed',output:part.content}))
      if (value.type === 'result') return [
        ...(typeof value.result === 'string' || Array.isArray(value.errors) ? [event('text_delta', { text: (value.result ?? value.errors.join('\n')).slice(-12000) })] : []),
        event('usage', { ...(value.usage ?? {}), cost_usd: value.total_cost_usd ?? null, is_error: value.is_error === true }),
      ]
      return []
    },
  })
}
