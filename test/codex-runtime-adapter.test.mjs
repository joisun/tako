import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexRuntimeDefinition } from '../server/src/runtime/adapters/codex.mjs'
import { parseCodexJsonLine } from '../server/src/runtime/parsers/codex-jsonl.mjs'

function unexpectedConnection() {
  assert.fail('This method must not connect to a Codex server')
}

test('Codex definition rejects one-shot invocation without connecting or launching a process', async () => {
  const definition = createCodexRuntimeDefinition({ createClient: unexpectedConnection })
  await assert.rejects(definition.buildInvocation({
    launch: { executable: '/fake/codex' },
    run: { prompt: 'Implement the requested change.', workspace: '/workspace/project' },
  }), { code: 'RUNTIME_SHARED_SERVER_REQUIRED' })
})

test('Codex definition discovers models through an injected shared client', async () => {
  const calls = []
  const connections = []
  let closed = false
  const definition = createCodexRuntimeDefinition({
    dataRoot: '/fake/codex-home',
    createClient(options) {
      connections.push(options)
      return {
        started: Promise.resolve({}),
        notify(method) { calls.push({ method }) },
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'initialize') return {}
          assert.equal(method, 'model/list')
          return { data: [{
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            description: 'Frontier coding model',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'medium', description: 'Balanced' },
            ],
          }] }
        },
        close() { closed = true },
      }
    },
  })
  const launch = {
    runtime_id: 'codex',
    executable: '/opt/tasks/bin/codex',
    version: 'codex-cli 0.150.0',
    source: 'path',
  }

  assert.deepEqual(await definition.fetchModels({ launch }), {
    source: 'live',
    models: [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      description: 'Frontier coding model',
      reasoningLevels: ['low', 'medium'],
      defaultReasoningLevel: 'medium',
      metadata: {},
    }],
  })
  assert.deepEqual(calls, [
    { method: 'initialize', params: {
      clientInfo: { name: 'tako', title: 'TAKO', version: 'source' },
      capabilities: { experimentalApi: true },
    } },
    { method: 'initialized' },
    { method: 'model/list', params: { limit: 100, includeHidden: false } },
  ])
  assert.equal(connections.length, 1)
  assert.equal(connections[0].dataRoot, '/fake/codex-home')
  assert.equal(Object.hasOwn(connections[0], 'executable'), false)
  assert.equal(Object.hasOwn(connections[0], 'env'), false)
  assert.ok(connections[0].allowedMethods.includes('model/list'))
  assert.equal(closed, true)
})

test('Codex definition exposes the normalized event parser', () => {
  const definition = createCodexRuntimeDefinition({ createClient: unexpectedConnection })
  assert.equal(definition.parseEvent, parseCodexJsonLine)
})

test('Codex availability remains independent from login state', () => {
  const definition = createCodexRuntimeDefinition({ createClient: unexpectedConnection })
  assert.equal(definition.authProbe, undefined)
})

test('Codex definition delegates interactive sessions to the injected factory', () => {
  const created = []
  const definition = createCodexRuntimeDefinition({
    createClient: unexpectedConnection,
    interactiveFactory: {
      create(input) {
        created.push(input)
        return { kind: 'interactive-session' }
      },
    },
  })

  assert.equal(definition.capabilities.interactiveSession, true)
  assert.deepEqual(definition.capabilities.contextIsolation, {
    skills: true,
    integrations: true,
  })
  assert.deepEqual(definition.createInteractiveSession({ run: { id: 'run-1' } }), {
    kind: 'interactive-session',
  })
  assert.deepEqual(created, [{ run: { id: 'run-1' } }])
  assert.equal(typeof definition.buildInvocation, 'function')
})

test('Codex definition reads display messages from the CLI-owned Thread without exposing tool payloads', async () => {
  const requests = []
  let closed = false
  const definition = createCodexRuntimeDefinition({
    dataRoot: '/fake/codex-home',
    createClient(options) {
      assert.equal(options.dataRoot, '/fake/codex-home')
      assert.equal(Object.hasOwn(options, 'executable'), false)
      assert.equal(Object.hasOwn(options, 'cwd'), false)
      assert.equal(Object.hasOwn(options, 'env'), false)
      return {
        started: Promise.resolve({}),
        async request(method, params) {
          requests.push({ method, params })
          if (method === 'initialize') return {}
          if (method === 'thread/items/list') throw Object.assign(new Error('unsupported'), { code: 'RUNTIME_PROTOCOL_METHOD_UNAVAILABLE' })
          assert.equal(method, 'thread/read')
          return {
            thread: {
              id: 'thread-1',
              turns: [{
                items: [
                  { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Review it.' }] },
                  { type: 'commandExecution', id: 'tool-1', command: 'private command' },
                  { type: 'agentMessage', id: 'agent-1', text: 'Review complete.' },
                ],
              }],
            },
          }
        },
        close() { closed = true },
      }
    },
  })

  assert.deepEqual(await definition.readConversation({
    launch: { executable: '/opt/tasks/bin/codex' },
    run: { session_id: 'thread-1', snapshot: { workspace: '/workspace/project' } },
  }), {
    session_id: 'thread-1',
    messages: [
      { id: 'user-1', role: 'user', text: 'Review it.' },
      { id: 'agent-1', role: 'assistant', text: 'Review complete.' },
    ],
    truncated: false,
  })
  assert.deepEqual(requests.at(-1), {
    method: 'thread/read',
    params: { threadId: 'thread-1', includeTurns: true },
  })
  assert.equal(closed, true)
})


test('Codex conversation pagination keeps chronological display messages and drops tool payloads', async () => {
  const requests = []
  const definition = createCodexRuntimeDefinition({ createClient: () => ({
    started: Promise.resolve({}), close() {},
    async request(method, params) {
      if (method === 'initialize') return {}
      assert.equal(method, 'thread/items/list')
      requests.push(params)
      return params.cursor ? { data: [{ item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] } }], nextCursor: null }
        : { data: [{ item: { type: 'agentMessage', id: 'a', text: 'Answer' } }, { item: { type: 'commandExecution', command: 'private tool payload' } }], nextCursor: 'page-2' }
    },
  }) })
  const result = await definition.readConversation({ launch: { executable: '/bin/codex' }, run: { session_id: 'thread', snapshot: { workspace: '/tmp' } } })
  assert.deepEqual(result.messages, [{ id: 'u', role: 'user', text: 'Question' }, { id: 'a', role: 'assistant', text: 'Answer' }])
  assert.equal(requests[0].sortDirection, 'desc')
  assert.equal(requests[1].cursor, 'page-2')
  assert.equal(result.truncated, false)
})
