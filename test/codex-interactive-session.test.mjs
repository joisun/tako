import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexInteractiveSessionFactory } from '../server/src/runtime/adapters/codex-interactive-session.mjs'

function fakeClient({ skillsResponse, handlers = {} } = {}) {
  const notifications = new Set()
  const closeListeners = new Set()
  const requests = []
  const client = {
    started: Promise.resolve({}),
    requests,
    notified: [],
    closed: false,
    closeCalls: 0,
    async request(method, params) {
      assert.equal(client.closed, false, 'requests must use an open connection')
      requests.push({ method, params })
      if (Object.hasOwn(handlers, method)) return handlers[method](params)
      if (method === 'initialize') return { userAgent: 'codex-cli 0.150.0' }
      if (method === 'skills/list') return skillsResponse ?? { data: [] }
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null }
      if (method === 'thread/unsubscribe') return {}
      if (method === 'thread/turns/list') return { data: [{ id: 'private-turn', status: 'interrupted' }], nextCursor: null }
      if (method === 'thread/start' || method === 'thread/resume') {
        return {
          thread: { id: params.threadId ?? 'private-thread', turns: [] },
          model: 'gpt-5', cwd: '/tmp/project', approvalPolicy: 'never',
          approvalsReviewer: 'user', sandbox: { type: { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[params.sandbox] }, modelProvider: 'openai',
        }
      }
      if (method === 'turn/start') {
        return { turn: { id: 'private-turn', status: 'inProgress', items: [] } }
      }
      if (method === 'turn/steer') return { turnId: 'private-turn' }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected method ${method}`)
    },
    notify(method) { client.notified.push(method) },
    onNotification(listener) {
      notifications.add(listener)
      return () => notifications.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    disconnect(exit_code = 1) {
      client.closed = true
      for (const listener of closeListeners) listener(Object.assign(new Error('RUNTIME_PROTOCOL_CLOSED'), { code: 'RUNTIME_PROTOCOL_CLOSED', exit_code }))
    },
    emit(method, params) {
      for (const listener of notifications) listener({ method, params })
    },
    close() { client.closeCalls += 1; client.closed = true },
  }
  return client
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function fakeTimers() {
  let nextId = 0
  const timers = new Map()
  return {
    setTimer(callback, delay) {
      const id = ++nextId
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    expire(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `expected a ${delay}ms timer`)
      timers.delete(entry[0])
      entry[1].callback()
    },
    get pending() { return timers.size },
  }
}

const RUN = Object.freeze({
  id: 'run-1',
  title: 'Review migration',
  prompt: 'Review the migration.',
  workspace: '/tmp/project',
  sandbox_mode: 'read-only',
  model: 'gpt-5',
  reasoning_effort: 'high',
  timeout_seconds: 7_200,
  capabilities: Object.freeze({ skills: 'inherit', integrations: 'inherit' }),
})

test('Codex interactive session streams a shared-server Turn and steers it through a public revision', async () => {
  const client = fakeClient()
  const events = []
  const spawns = []
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onSpawn: (spawned) => spawns.push(spawned),
  })

  const completion = session.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(spawns, [{ pid: null }])
  assert.deepEqual(client.notified, ['initialized'])
  assert.deepEqual(events.slice(0, 2), [
    { type: 'session', payload: { session_id: 'private-thread' } },
    { type: 'user_message', payload: { kind: 'prompt', text: 'Review the migration.' } },
  ])
  assert.deepEqual(client.requests.slice(0, 3), [
    {
      method: 'initialize',
      params: {
        clientInfo: { name: 'tako', title: 'TAKO', version: 'source' },
        capabilities: { experimentalApi: true },
      },
    },
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/project', model: 'gpt-5', approvalPolicy: 'never',
        sandbox: 'read-only', ephemeral: false,
        config: { thread_unload_delay_secs: 0 },
      },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'private-thread',
        input: [{ type: 'text', text: 'Review the migration.' }],
        cwd: '/tmp/project', model: 'gpt-5', effort: 'high',
      },
    },
  ])

  client.emit('turn/started', {
    threadId: 'private-thread',
    turn: { id: 'private-turn', status: 'inProgress', items: [] },
  })
  client.emit('item/agentMessage/delta', {
    threadId: 'private-thread', turnId: 'private-turn',
    itemId: 'message-1', delta: 'Checking the schema.',
  })
  client.emit('item/completed', {
    threadId: 'private-thread', turnId: 'private-turn', completedAtMs: 1,
    item: {
      id: 'file-1', type: 'fileChange', status: 'completed',
      changes: [
        { path: '/tmp/project/report.md', kind: 'update' },
        { path: '/tmp/outside.md', kind: 'delete' },
      ],
    },
  })

  assert.deepEqual(events.filter(({ type }) => ['turn_started', 'assistant_delta'].includes(type)).slice(-2), [
    { type: 'turn_started', payload: { turn_revision: 1 } },
    {
      type: 'assistant_delta',
      payload: { turn_revision: 1, item_id: 'message-1', delta: 'Checking the schema.' },
    },
  ])
  assert.doesNotMatch(JSON.stringify(events), /private-turn/)

  await session.steer({ expectedTurnRevision: 1, text: 'Check rollback too.' })
  assert.deepEqual(client.requests.at(-1), {
    method: 'turn/steer',
    params: {
      threadId: 'private-thread', expectedTurnId: 'private-turn',
      input: [{ type: 'text', text: 'Check rollback too.' }],
    },
  })
  assert.deepEqual(events.at(-1), {
    type: 'intervention_accepted',
    payload: { turn_revision: 1, text: 'Check rollback too.' },
  })

  client.emit('turn/completed', {
    threadId: 'private-thread',
    turn: { id: 'private-turn', status: 'completed', items: [] },
  })
  assert.deepEqual(await completion, {
    status: 'succeeded', exit_code: 0, error_code: null,
    session_id: 'private-thread', final_message: 'Checking the schema.',
    usage: null, file_changes: [{ path: 'report.md', kind: 'update' }],
  })
  assert.equal(client.closed, true)
  assert.deepEqual(client.requests.slice(-2), [
    { method: 'thread/unsubscribe', params: { threadId: 'private-thread' } },
    { method: 'thread/loaded/list', params: { limit: 100, cursor: null } },
  ])
})

test('canceling a Run interrupts its Turn and waits for stop confirmation before disconnecting', async () => {
  const stopped = deferred()
  const client = fakeClient({ handlers: { 'thread/turns/list': () => stopped.promise } })
  const observer = fakeClient()
  const controller = new AbortController()
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: controller.signal,
    emit: () => {},
    onSpawn: () => {},
  })

  const completion = session.start()
  let completed = false
  void completion.then(() => { completed = true })
  await flush()
  controller.abort()
  await flush()

  assert.deepEqual(client.requests.slice(-2), [
    { method: 'turn/interrupt', params: { threadId: 'private-thread', turnId: 'private-turn' } },
    { method: 'thread/turns/list', params: { threadId: 'private-thread', limit: 1, sortDirection: 'desc', itemsView: 'summary' } },
  ])
  assert.equal(completed, false)
  assert.equal(client.closed, false)
  assert.equal(client.requests.some(({ method }) => method === 'thread/unsubscribe'), false)

  stopped.resolve({ data: [{ id: 'private-turn', status: 'interrupted' }] })

  assert.deepEqual(await completion, {
    status: 'canceled', exit_code: null, error_code: 'RUN_CANCELED',
    session_id: 'private-thread', final_message: null, usage: null, file_changes: [],
  })
  assert.equal(client.closed, true)
  assert.equal(client.closeCalls, 1)
  assert.equal(observer.closed, false)
  assert.deepEqual(await observer.request('thread/loaded/list', {}), { data: [], nextCursor: null })
  observer.close()
})

test('Codex interactive session resolves integration config on the initialized shared client before Thread creation', async () => {
  const client = fakeClient({
    skillsResponse: { data: [{
      cwd: '/tmp/project', errors: [],
      skills: [{
        name: 'review', path: '/skills/review/SKILL.md', enabled: true,
        description: 'Review code', scope: 'user',
      }],
    }] },
  })
  const configurations = []
  const clients = []
  const signal = new AbortController().signal
  const factory = createCodexInteractiveSessionFactory({
    async resolveCapabilityConfig(input) {
      configurations.push(input)
      assert.equal(client.requests[0].method, 'initialize')
      return {
        'features.plugins': false,
        'features.apps': false,
        'apps._default.enabled': false,
        'mcp_servers.external.enabled': false,
      }
    },
    createClient(options) {
      clients.push(options)
      return client
    },
  })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: {
      ...RUN,
      capabilities: { skills: 'disabled', integrations: 'disabled' },
    },
    signal,
    emit: () => {},
    onSpawn: () => {},
  })

  const completion = session.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(configurations, [{
    client,
    cwd: '/tmp/project',
    capabilities: { skills: 'disabled', integrations: 'disabled' },
  }])
  assert.deepEqual(clients, [undefined])
  assert.deepEqual(client.requests.slice(0, 3), [
    {
      method: 'initialize',
      params: {
        clientInfo: { name: 'tako', title: 'TAKO', version: 'source' },
        capabilities: { experimentalApi: true },
      },
    },
    {
      method: 'skills/list',
      params: { cwds: ['/tmp/project'], forceReload: true },
    },
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/project', model: 'gpt-5', approvalPolicy: 'never',
        sandbox: 'read-only', ephemeral: false,
        config: {
          'features.plugins': false,
          'features.apps': false,
          'apps._default.enabled': false,
          'mcp_servers.external.enabled': false,
          skills: { config: [{ path: '/skills/review/SKILL.md', enabled: false }] },
          features: { skill_search: false, skill_mcp_dependency_install: false },
          thread_unload_delay_secs: 0,
        },
      },
    },
  ])
  assert.doesNotMatch(JSON.stringify(client.requests), /web_search/i)

  client.emit('turn/completed', {
    threadId: 'private-thread',
    turn: { id: 'private-turn', status: 'completed', items: [] },
  })
  await completion
})

test('Codex interactive session fails before creating a Thread when shared capability discovery fails', async () => {
  let clients = 0
  const client = fakeClient()
  const factory = createCodexInteractiveSessionFactory({
    createClient() { clients += 1; return client },
    resolveCapabilityConfig: async () => {
      throw Object.assign(new Error('private discovery output'), {
        code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID',
      })
    },
  })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: { ...RUN, capabilities: { skills: 'inherit', integrations: 'disabled' } },
    signal: new AbortController().signal,
    emit: () => {},
    onSpawn: () => {},
  })

  assert.deepEqual(await session.start(), {
    status: 'failed', exit_code: null,
    error_code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID',
    session_id: null, final_message: null, usage: null, file_changes: [],
  })
  assert.equal(clients, 1)
  assert.deepEqual(client.requests.map(({ method }) => method), ['initialize'])
  assert.equal(client.closed, true)
})

test('Run timeout interrupts its Turn and waits for confirmed termination without stopping the server', async () => {
  const stopped = deferred()
  const client = fakeClient({ handlers: { 'thread/turns/list': () => stopped.promise } })
  const observer = fakeClient()
  const timers = fakeTimers()
  const factory = createCodexInteractiveSessionFactory({
    createClient: () => client,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: new AbortController().signal,
    emit: () => {},
    onSpawn: () => {},
  })

  const completion = session.start()
  let completed = false
  void completion.then(() => { completed = true })
  await flush()
  timers.expire(7_200_000)
  await flush()

  assert.deepEqual(client.requests.slice(-2), [
    { method: 'turn/interrupt', params: { threadId: 'private-thread', turnId: 'private-turn' } },
    { method: 'thread/turns/list', params: { threadId: 'private-thread', limit: 1, sortDirection: 'desc', itemsView: 'summary' } },
  ])
  assert.equal(completed, false)
  assert.equal(client.closed, false)
  stopped.resolve({ data: [{ id: 'private-turn', status: 'interrupted' }] })

  assert.deepEqual(await completion, {
    status: 'timed_out', exit_code: null, error_code: 'RUNTIME_TIMEOUT',
    session_id: 'private-thread', final_message: null, usage: null, file_changes: [],
  })
  assert.equal(client.closed, true)
  assert.equal(timers.pending, 0)
  assert.deepEqual(await observer.request('thread/loaded/list', {}), { data: [], nextCursor: null })
  observer.close()
})

test('unconfirmed interruption reports execution_stopped false after the stop deadline', async () => {
  const stopped = deferred()
  const client = fakeClient({ handlers: { 'thread/turns/list': () => stopped.promise } })
  const controller = new AbortController()
  const timers = fakeTimers()
  const session = createCodexInteractiveSessionFactory({
    createClient: () => client,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  }).create({
    launch: { executable: '/fake/codex' }, run: RUN,
    signal: controller.signal, emit() {}, onSpawn() {},
  })
  const completion = session.start()
  await flush()
  controller.abort()
  await flush()
  assert.equal(client.closed, false)
  assert.ok(client.requests.some(({ method }) => method === 'turn/interrupt'))
  timers.expire(5_000)

  const result = await completion
  assert.equal(result.status, 'canceled')
  assert.equal(result.error_code, 'RUN_CANCELED')
  assert.equal(result.execution_stopped, false)
  assert.equal(result.session_id, 'private-thread')
  assert.equal(client.closed, true)
  assert.equal(timers.pending, 0)
  stopped.resolve({ data: [{ id: 'private-turn', status: 'interrupted' }] })
  await flush()
  assert.equal(client.closeCalls, 1)
})

test('interrupt acknowledgement and an inProgress summary do not confirm execution has stopped', async () => {
  const nextPoll = deferred()
  const stopped = deferred()
  let polls = 0
  const client = fakeClient({ handlers: {
    'thread/turns/list': () => {
      polls += 1
      if (polls === 1) return { data: [{ id: 'private-turn', status: 'inProgress' }] }
      nextPoll.resolve()
      return stopped.promise
    },
  } })
  const controller = new AbortController()
  const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
    launch: { executable: '/fake/codex' }, run: RUN,
    signal: controller.signal, emit() {}, onSpawn() {},
  })
  const completion = session.start()
  let completed = false
  void completion.then(() => { completed = true })
  await flush()
  controller.abort()
  await nextPoll.promise
  assert.equal(completed, false)
  assert.equal(client.closed, false)
  assert.equal(client.requests.some(({ method }) => method === 'thread/unsubscribe'), false)
  stopped.resolve({ data: [{ id: 'private-turn', status: 'interrupted' }] })
  assert.equal((await completion).execution_stopped, undefined)
})

test('Fast mode reaches the actual turn request as fast/default or inherits without an override', async () => {
  for (const [fast_mode, tier] of [[true, 'fast'], [false, 'default'], [null, undefined], [undefined, undefined]]) {
    const client = fakeClient()
    const controller = new AbortController()
    const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
    const session = factory.create({
      launch: { executable: '/opt/tasks/bin/codex' },
      run: { ...RUN, fast_mode },
      signal: controller.signal,
      emit() {},
      onSpawn() {},
    })
    const completion = session.start()
    try {
      await new Promise((resolve) => setImmediate(resolve))
      const turn = client.requests.find(({ method }) => method === 'turn/start')
      assert.ok(turn)
      assert.equal(turn.params.serviceTier, tier)
      assert.equal(Object.hasOwn(turn.params, 'serviceTier'), tier !== undefined)
    } finally {
      controller.abort()
      await completion
    }
  }
})

test('shared connection loss keeps session identity and reports that execution may still be running', async () => {
  const client = fakeClient()
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({ launch: { executable: '/codex' }, run: RUN, signal: new AbortController().signal, emit() {}, onSpawn() {} })
  const completion = session.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.steerable, true)
  client.disconnect(17)
  const result = await completion
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'RUNTIME_PROTOCOL_CLOSED')
  assert.equal(result.exit_code, 17)
  assert.equal(result.session_id, 'private-thread')
  assert.equal(result.execution_stopped, false)
  assert.equal(session.steerable, false)
  await assert.rejects(session.steer({ expectedTurnRevision: 1, text: 'hello' }), { code: 'RUN_NOT_ACTIVE' })
})


test('workspace network policy reaches thread creation and canceled sessions remain recoverable', async () => {
  for (const network_access of [true, false, null]) {
    const client = fakeClient()
    const controller = new AbortController()
    const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
      launch: { executable: '/bin/codex' }, run: { ...RUN, sandbox_mode: 'workspace-write', network_access },
      signal: controller.signal, emit() {}, onSpawn() {},
    })
    const completion = session.start()
    await new Promise((resolve) => setImmediate(resolve))
    const thread = client.requests.find(({ method }) => method === 'thread/start')
    assert.equal(thread.params.config?.['sandbox_workspace_write.network_access'], network_access ?? undefined)
    controller.abort()
    assert.equal((await completion).session_id, 'private-thread')
  }
})

test('a busy inherited session fails without starting a turn or silently creating another session', async () => {
  const client = fakeClient()
  const request = client.request.bind(client)
  client.request = async (method, params) => {
    if (method !== 'thread/resume') return request(method, params)
    client.requests.push({ method, params })
    throw Object.assign(new Error('RUNTIME_SESSION_IN_USE'), { code: 'RUNTIME_SESSION_IN_USE' })
  }
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({
    launch: { executable: '/bin/codex' },
    run: { ...RUN, resume_session_id: 'occupied-thread' },
    signal: new AbortController().signal,
    emit() {}, onSpawn() {},
  })
  const result = await session.start()
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'RUNTIME_SESSION_IN_USE')
  assert.equal(client.closed, true)
  assert.equal(session.steerable, false)
  assert.deepEqual(client.requests.map(({ method }) => method), ['initialize', 'thread/loaded/list', 'thread/resume'])
  assert.equal(client.requests[2].params.threadId, 'occupied-thread')
  assert.equal(client.requests[2].params.excludeTurns, true)
  assert.equal(client.requests[2].params.config.thread_unload_delay_secs, 0)
})

test('an already loaded inherited Thread is rejected even when found on a later page', async () => {
  const client = fakeClient({ handlers: {
    'thread/loaded/list': ({ cursor }) => cursor === null
      ? { data: ['unrelated-thread'], nextCursor: 'page-2' }
      : { data: ['occupied-thread'], nextCursor: null },
  } })
  const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
    launch: { executable: '/fake/codex' },
    run: { ...RUN, resume_session_id: 'occupied-thread' },
    signal: new AbortController().signal, emit() {}, onSpawn() {},
  })
  const result = await session.start()
  assert.equal(result.error_code, 'RUNTIME_SESSION_IN_USE')
  assert.equal(result.session_id, null)
  assert.deepEqual(client.requests.map(({ method }) => method), [
    'initialize', 'thread/loaded/list', 'thread/loaded/list',
  ])
  assert.deepEqual(client.requests.slice(1).map(({ params }) => params), [
    { limit: 100, cursor: null }, { limit: 100, cursor: 'page-2' },
  ])
  assert.equal(client.closed, true)
})

test('invalid loaded-thread discovery fails closed without resuming a Thread', async () => {
  for (const response of [{}, { data: [], nextCursor: 'repeated' }]) {
    const client = fakeClient({ handlers: { 'thread/loaded/list': () => response } })
    const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
      launch: { executable: '/fake/codex' }, run: { ...RUN, resume_session_id: 'old-thread' },
      signal: new AbortController().signal, emit() {}, onSpawn() {},
    })
    assert.equal((await session.start()).error_code, 'RUNTIME_PROTOCOL_INVALID')
    assert.equal(client.requests.some(({ method }) => ['thread/resume', 'turn/start'].includes(method)), false)
    assert.equal(client.closed, true)
  }
})

test('an unloaded Thread resumes with fresh config, excludeTurns, and zero unload delay', async () => {
  const client = fakeClient()
  const session = createCodexInteractiveSessionFactory({
    createClient: () => client,
    resolveCapabilityConfig: async () => ({ 'features.plugins': false, 'features.apps': false }),
  }).create({
    launch: { executable: '/fake/codex' },
    run: { ...RUN, resume_session_id: 'old-thread', execution_config: { thread_unload_delay_secs: 60 } },
    signal: new AbortController().signal, emit() {}, onSpawn() {},
  })
  const completion = session.start()
  await flush()
  assert.deepEqual(client.requests.slice(0, 4).map(({ method }) => method), [
    'initialize', 'thread/loaded/list', 'thread/resume', 'turn/start',
  ])
  assert.deepEqual(client.requests[2].params, {
    threadId: 'old-thread', cwd: '/tmp/project', model: 'gpt-5',
    approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true,
    config: { 'features.plugins': false, 'features.apps': false, thread_unload_delay_secs: 0 },
  })
  client.emit('turn/completed', {
    threadId: 'old-thread', turn: { id: 'private-turn', status: 'completed', items: [] },
  })
  assert.equal((await completion).session_id, 'old-thread')
})

test('finishing a Run unsubscribes and waits for Thread unloading before closing its connection', async () => {
  const unloaded = deferred()
  const client = fakeClient({ handlers: { 'thread/loaded/list': () => unloaded.promise } })
  const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
    launch: { executable: '/fake/codex' }, run: RUN,
    signal: new AbortController().signal, emit() {}, onSpawn() {},
  })
  const completion = session.start()
  let completed = false
  void completion.then(() => { completed = true })
  await flush()
  client.emit('turn/completed', {
    threadId: 'private-thread', turn: { id: 'private-turn', status: 'completed', items: [] },
  })
  await flush()
  assert.deepEqual(client.requests.slice(-2).map(({ method }) => method), ['thread/unsubscribe', 'thread/loaded/list'])
  assert.equal(completed, false)
  assert.equal(client.closed, false)
  unloaded.resolve({ data: [], nextCursor: null })
  assert.equal((await completion).status, 'succeeded')
  assert.equal(client.closed, true)
})

test('per-run execution credentials reach only the matching MCP config instead of client process options', async () => {
  const clients = []
  const specifications = []
  for (const token of ['run-one-token', 'run-two-token']) {
    const client = fakeClient()
    const specification = {
      ...RUN,
      execution_env: { TAKO_LOOP_TOKEN: token, TAKO_LOOP_RUN: token, UNUSED_SECRET: 'not-for-mcp' },
      execution_config: {
        thread_unload_delay_secs: 60,
        'mcp_servers.tako_loop': {
          command: '/fake/node', args: ['/fake/loop-mcp.mjs'], enabled: true,
          env: { EXISTING: 'kept', TAKO_LOOP_TOKEN: 'stale-token' },
          env_vars: ['TAKO_LOOP_TOKEN', 'TAKO_LOOP_RUN'],
        },
      },
    }
    const before = structuredClone(specification)
    const session = createCodexInteractiveSessionFactory({
      createClient(...args) { clients.push(args); return client },
      resolveCapabilityConfig: async () => ({
        'features.plugins': false, 'features.apps': false,
        'mcp_servers.external.enabled': false,
      }),
    }).create({
      launch: { executable: '/fake/codex' }, run: specification,
      signal: new AbortController().signal, emit() {}, onSpawn() {},
    })
    const completion = session.start()
    await flush()
    const config = client.requests.find(({ method }) => method === 'thread/start').params.config
    assert.deepEqual(config, {
      'features.plugins': false, 'features.apps': false,
      'mcp_servers.external.enabled': false,
      thread_unload_delay_secs: 0,
      'mcp_servers.tako_loop': {
        command: '/fake/node', args: ['/fake/loop-mcp.mjs'], enabled: true,
        env: { EXISTING: 'kept', TAKO_LOOP_TOKEN: token, TAKO_LOOP_RUN: token },
      },
    })
    assert.deepEqual(specification, before)
    specifications.push(config['mcp_servers.tako_loop'].env)
    client.emit('turn/completed', {
      threadId: 'private-thread', turn: { id: 'private-turn', status: 'completed', items: [] },
    })
    await completion
  }
  assert.deepEqual(clients, [[], []])
  assert.equal(specifications[0].TAKO_LOOP_TOKEN, 'run-one-token')
  assert.equal(specifications[1].TAKO_LOOP_TOKEN, 'run-two-token')
})

test('missing per-run MCP credentials fail before Thread creation', async () => {
  const client = fakeClient()
  const session = createCodexInteractiveSessionFactory({ createClient: () => client }).create({
    launch: { executable: '/fake/codex' },
    run: { ...RUN, execution_config: { 'mcp_servers.tako_loop': {
      command: '/fake/node', env_vars: ['TAKO_LOOP_TOKEN'], enabled: true,
    } }, execution_env: {} },
    signal: new AbortController().signal, emit() {}, onSpawn() {},
  })
  const result = await session.start()
  assert.equal(result.error_code, 'RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  assert.deepEqual(client.requests.map(({ method }) => method), ['initialize'])
  assert.equal(client.closed, true)
})
