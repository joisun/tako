import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentExecution } from '../server/src/agent-execution.mjs'
import { createCollaborationRuntime } from '../server/src/collaboration-runtime.mjs'
import { createClaudeRuntimeDefinition } from '../server/src/runtime/adapters/claude.mjs'
import { createRuntimeAgentRegistry } from '../server/src/runtime/runtime-agent-registry.mjs'

function externalConnectionUnavailable(error) {
  assert.equal(error.code, 'RUNTIME_SHARED_SERVER_UNAVAILABLE')
  assert.deepEqual(error.details, {
    runtime_id: 'claude', reason: 'CLAUDE_EXTERNAL_CONNECTION_UNAVAILABLE',
  })
  assert.match(error.message, /未找到可连接的 Claude 服务/)
  assert.match(error.message, /TAKO 不会启动 Claude 实例/)
  return true
}

test('Claude disables automatic execution capabilities and retains the version probe', () => {
  const definition = createClaudeRuntimeDefinition()
  assert.equal(definition.capabilities.collaboration, false)
  assert.equal(definition.capabilities.collaborationWrite, false)
  assert.equal(definition.capabilities.scheduledExecution, false)
  assert.deepEqual(definition.versionProbe.args, ['--version'])
})

test('Claude refuses invocation without requiring launch details or a Run spec', async () => {
  await assert.rejects(
    createClaudeRuntimeDefinition().buildExecutionInvocation(),
    externalConnectionUnavailable,
  )
})

test('Claude team availability reports disabled collaboration without CLI or model probes', async t => {
  const resolve = t.mock.fn(() => assert.fail('Disabled Claude must not probe the CLI'))
  const models = t.mock.fn(() => assert.fail('Disabled Claude must not discover models'))
  const runtime = createCollaborationRuntime({
    store: { memory: { close: async () => {} } },
    resources: { list: () => [] },
    registry: { get: () => createClaudeRuntimeDefinition(), resolve, models },
  })
  t.after(() => runtime.close())
  assert.deepEqual(await runtime.memberRuntime('claude'), {
    id: 'claude', state: 'unavailable', source: 'unavailable', models: [],
    model_override_supported: false, error_code: 'RUNTIME_SHARED_SERVER_UNAVAILABLE',
  })
  assert.equal(resolve.mock.callCount(), 0)
  assert.equal(models.mock.callCount(), 0)
})

test('Team availability retains discovery unless collaboration is explicitly disabled', async t => {
  for (const collaboration of [undefined, true]) {
    const resolve = t.mock.fn(async () => ({ executable: '/not-executed/codex' }))
    const models = t.mock.fn(async () => ({ source: 'live', models: [{ id: 'fixture-model' }] }))
    const runtime = createCollaborationRuntime({
      store: { memory: { close: async () => {} } },
      resources: { list: () => [] },
      registry: { get: () => ({ capabilities: { collaboration } }), resolve, models },
    })
    t.after(() => runtime.close())
    assert.deepEqual(await runtime.memberRuntime('codex'), {
      id: 'codex', state: 'ready', source: 'live', models: [{ id: 'fixture-model' }],
      model_override_supported: true, error_code: null,
    })
    assert.deepEqual(resolve.mock.calls[0].arguments, ['codex'])
    assert.deepEqual(models.mock.calls[0].arguments, ['codex'])
  }
})

test('Claude new and resumed team executions fail before the process supervisor', async t => {
  const start = t.mock.fn(() => assert.fail('Claude worker must not be started'))
  const onSpawn = t.mock.fn()
  const registry = createRuntimeAgentRegistry({
    definitions: [createClaudeRuntimeDefinition()],
    resolver: {
      async resolve() {
        return { runtime_id: 'claude', executable: '/not-executed/claude', version: 'fixture', source: 'fixture' }
      },
    },
  })
  const execute = createAgentExecution({ registry, supervisor: { start } })
  for (const spec of [
    { sandbox_mode: 'read-only', prompt: 'Discuss the task' },
    { sandbox_mode: 'read-only', resume_session_id: 'existing-session', prompt: 'Continue the review' },
    { sandbox_mode: 'workspace-write', prompt: 'Implement the task' },
  ]) {
    await assert.rejects(execute({
      runId: 'claude-run', runtimeId: 'claude', spec,
      signal: new AbortController().signal, onSpawn,
    }), externalConnectionUnavailable)
  }
  assert.equal(start.mock.callCount(), 0)
  assert.equal(onSpawn.mock.callCount(), 0)
})
