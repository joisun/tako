import { runtimeEvent } from '../runtime-event.mjs'
import { runtimeError } from '../runtime-errors.mjs'

export function createClaudeRuntimeDefinition() {
  return Object.freeze({
    id: 'claude', displayName: 'Claude Code',
    launch: { overrideEnv: 'CLAUDE_BIN', executableNames: ['claude'], packagedCandidates: [], platformResolvers: [] },
    versionProbe: { args: ['--version'], timeout_ms: 5000 },
    capabilities: { modelSelection: true, sandbox: false, sessionResume: true, collaboration: false, scheduledExecution: false, collaborationWrite: false },
    fallbackModels: [{ id: 'default', displayName: 'Default (CLI config)', reasoningLevels: [] }],
    async buildExecutionInvocation() {
      throw runtimeError('RUNTIME_SHARED_SERVER_UNAVAILABLE', '未找到可连接的 Claude 服务；TAKO 不会启动 Claude 实例。', {
        runtime_id: 'claude', reason: 'CLAUDE_EXTERNAL_CONNECTION_UNAVAILABLE',
      })
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
