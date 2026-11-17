import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'

import { createCodexSharedClient } from '../server/src/runtime/codex-shared-client.mjs'
import { createCodexSessionAdapter } from '../server/src/runtime/adapters/codex-sessions.mjs'

const listInput = { workspace: '', branch: '', query: '', archived: false, cursor: null, limit: 10 }
const thread = { id: 'native', name: 'Native session', cwd: '/workspace', createdAt: 1, updatedAt: 2, status: { type: 'idle' } }
const reply = (socket, id, result) => socket.send(JSON.stringify({ id, result }))
const settle = () => new Promise(resolve => setImmediate(resolve))

function forbidProcesses(t) {
  const mocks = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name =>
    t.mock.method(childProcess, name, () => assert.fail('Unexpected process launch: ' + name)))
  syncBuiltinESMExports()
  t.after(() => {
    for (const mock of mocks) {
      assert.equal(mock.mock.callCount(), 0)
      mock.mock.restore()
    }
    syncBuiltinESMExports()
  })
}

async function fakeServer(t, onMessage, root) {
  root ??= await mkdtemp('/tmp/tako-shared-')
  const path = join(root, 'app-server-control', 'app-server-control.sock')
  await mkdir(join(root, 'app-server-control'), { recursive: true })
  const server = createServer()
  const websocket = new WebSocketServer({ server })
  const calls = []
  let connections = 0
  websocket.on('connection', socket => {
    connections++
    socket.on('message', bytes => {
      const message = JSON.parse(bytes)
      calls.push(message)
      onMessage?.(message, socket)
    })
  })
  server.listen(path)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of websocket.clients) socket.terminate()
    await Promise.all([
      new Promise(resolve => websocket.close(resolve)),
      new Promise(resolve => server.close(resolve)),
    ])
    await rm(root, { recursive: true, force: true })
  })
  return { root, server, websocket, calls, connections: () => connections }
}

function clientFor(t, root, options = {}) {
  const client = createCodexSharedClient({ dataRoot: root, ...options })
  t.after(() => client.close())
  return client
}

test('shared socket multiplexes out-of-order replies without spawning or exposing a server pid', async t => {
  forbidProcesses(t)
  const waiting = []
  const f = await fakeServer(t, (message, socket) => {
    waiting.push(message)
    if (waiting.length === 3) for (const request of waiting.toReversed()) reply(socket, request.id, request.params)
  })
  const client = clientFor(t, f.root)
  // Requests made while connecting also wait safely for the handshake.
  const requests = [1, 2, 3].map(value => client.request('thread/read', { value }))
  assert.deepEqual(await client.started, {})
  assert.equal(Object.hasOwn(client, 'pid'), false)
  assert.deepEqual(await Promise.all(requests), [{ value: 1 }, { value: 2 }, { value: 3 }])
  client.close()
  assert.equal(f.server.listening, true)
  const next = clientFor(t, f.root)
  await next.started
  assert.equal(f.connections(), 2)
})

test('default method whitelist stays read-only and a custom whitelist is isolated from later mutation', async t => {
  const f = await fakeServer(t, (message, socket) => {
    if (Object.hasOwn(message, 'id')) reply(socket, message.id, {})
  })
  const readOnly = clientFor(t, f.root)
  await readOnly.started
  for (const method of ['initialize', 'thread/loaded/list', 'thread/read']) await readOnly.request(method)
  assert.throws(() => readOnly.request('thread/start'), /READ_ONLY/)
  assert.throws(() => readOnly.notify('shutdown'), /READ_ONLY/)
  readOnly.notify('initialized')
  const methods = ['thread/start']
  const runtime = clientFor(t, f.root, { allowedMethods: methods })
  methods.push('turn/start')
  await runtime.request('thread/start')
  assert.throws(() => runtime.request('turn/start'), /READ_ONLY/)
})

test('RPC errors retain rpcCode and distinguish unsupported methods and session ownership', async t => {
  const f = await fakeServer(t, (message, socket) => {
    socket.send(JSON.stringify({ id: message.id, error: message.params }))
  })
  const client = clientFor(t, f.root)
  for (const [error, code] of [
    [{ code: -32601, message: 'Missing method' }, 'RUNTIME_PROTOCOL_METHOD_UNAVAILABLE'],
    [{ code: -32600, message: 'Invalid request: unknown variant `thread/items/list`' }, 'RUNTIME_PROTOCOL_METHOD_UNAVAILABLE'],
    [{ code: -32600, message: 'thread native already has an active writer' }, 'RUNTIME_SESSION_IN_USE'],
    [{ code: -32602, message: 'Invalid params' }, 'RUNTIME_PROTOCOL_ERROR'],
    [{ code: -32000, data: { activeTurnNotSteerable: {} } }, 'TURN_NOT_STEERABLE'],
  ]) await assert.rejects(client.request('thread/read', error), { code, rpcCode: error.code })
  assert.equal(client.closed, false)
})

test('request timeout ignores late replies and leaves concurrent requests and the shared server usable', async t => {
  let slow
  const f = await fakeServer(t, (message, socket) => {
    if (message.params.slow) slow = { id: message.id, socket }
    else reply(socket, message.id, 'ready')
  })
  const client = clientFor(t, f.root, { requestTimeoutMs: 50 })
  await client.started
  const timedOut = assert.rejects(client.request('thread/read', { slow: true }), { code: 'RUNTIME_PROTOCOL_TIMEOUT' })
  assert.equal(await client.request('thread/read'), 'ready')
  await timedOut
  reply(slow.socket, slow.id, 'too late')
  assert.equal(await client.request('thread/read'), 'ready')
  assert.equal(client.closed, false)
  assert.equal(f.server.listening, true)
})

test('close rejects every pending request, notifies once and supports unsubscribe and late subscribers', async t => {
  let received
  const allReceived = new Promise(resolve => { received = resolve })
  let requests = 0
  const f = await fakeServer(t, () => { if (++requests === 2) received() })
  const client = clientFor(t, f.root)
  await client.started
  const errors = []
  client.onClose(error => errors.push(error))
  client.onClose(() => { throw new Error('Listener failure must not interrupt cleanup') })
  const unsubscribe = client.onClose(() => assert.fail('Removed close listener'))
  unsubscribe()
  const pending = [1, 2].map(() => assert.rejects(client.request('thread/read'), { code: 'RUNTIME_PROTOCOL_CLOSED' }))
  await allReceived
  client.close()
  client.close()
  await Promise.all(pending)
  await assert.rejects(client.request('thread/read'), { code: 'RUNTIME_PROTOCOL_CLOSED' })
  assert.throws(() => client.notify('initialized'), { code: 'RUNTIME_PROTOCOL_CLOSED' })
  assert.equal(errors.length, 1)
  client.onClose(error => errors.push(error))
  assert.equal(errors[1], errors[0])
  assert.equal(f.server.listening, true)
})

test('disconnect rejects pending requests and does not reconnect or stop the server on its own', async t => {
  const f = await fakeServer(t, (_message, socket) => socket.terminate())
  const client = clientFor(t, f.root)
  let closes = 0
  client.onClose(() => closes++)
  await assert.rejects(client.request('thread/read'), { code: 'RUNTIME_PROTOCOL_CLOSED' })
  await settle()
  assert.equal(client.closed, true)
  assert.equal(closes, 1)
  assert.equal(f.connections(), 1)
  assert.equal(f.server.listening, true)
})

test('closing before connection and a stalled handshake settle started and notify onClose', async t => {
  const f = await fakeServer(t)
  const early = clientFor(t, f.root)
  let closes = 0
  early.onClose(() => closes++)
  const startup = assert.rejects(early.started, { code: 'RUNTIME_PROTOCOL_CLOSED' })
  early.close()
  await startup
  assert.equal(closes, 1)

  const stalledRoot = await mkdtemp('/tmp/tako-stall-')
  await mkdir(join(stalledRoot, 'app-server-control'))
  const stalled = createServer()
  const sockets = new Set()
  stalled.on('upgrade', (_request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  stalled.listen(join(stalledRoot, 'app-server-control', 'app-server-control.sock'))
  await once(stalled, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => stalled.close(resolve))
    await rm(stalledRoot, { recursive: true, force: true })
  })
  const timed = clientFor(t, stalledRoot, { requestTimeoutMs: 50 })
  await assert.rejects(timed.started, { code: 'RUNTIME_PROTOCOL_TIMEOUT' })
  assert.equal(timed.closed, true)
  assert.equal(stalled.listening, true)
})

test('maximumLineBytes admits large fragmented histories and rejects messages beyond the configured bound', async t => {
  const body = '界'.repeat(3 * 1024 * 1024)
  const f = await fakeServer(t, (message, socket) => {
    const response = JSON.stringify({ id: message.id, result: body })
    socket.send(response.slice(0, 100), { fin: false })
    socket.send(response.slice(100), { fin: true })
  })
  const large = clientFor(t, f.root, { maximumLineBytes: 12 * 1024 * 1024 })
  assert.equal(await large.request('thread/read'), body)
  const small = clientFor(t, f.root, { maximumLineBytes: 1024 })
  await assert.rejects(small.request('thread/read'), { code: 'RUNTIME_PROTOCOL_FRAME_TOO_LARGE' })
  assert.equal(small.closed, true)
  assert.equal(f.server.listening, true)
})

test('server requests cannot settle a client request with the same id and default to explicit rejection', async t => {
  let response
  const rejected = new Promise(resolve => { response = resolve })
  const f = await fakeServer(t, (message, socket) => {
    if (message.method) {
      socket.send(JSON.stringify({ id: message.id, method: 'item/commandExecution/requestApproval', params: { threadId: 'other' } }))
    } else {
      response(message)
      reply(socket, message.id, 'actual reply')
    }
  })
  const client = clientFor(t, f.root)
  const pending = client.request('thread/read')
  assert.equal((await rejected).error.code, -32601)
  assert.equal(await pending, 'actual reply')
})

test('optional serverRequest handles approval, tool and user input requests separately from notifications', async t => {
  const requests = [
    { id: 'approval', method: 'item/commandExecution/requestApproval', params: {} },
    { id: 'file', method: 'item/fileChange/requestApproval', params: {} },
    { id: 'tool', method: 'item/tool/call', params: {} },
    { id: 'input', method: 'item/tool/requestUserInput', params: {} },
  ]
  let done
  const completed = new Promise(resolve => { done = resolve })
  const responses = []
  const f = await fakeServer(t, (message, socket) => {
    if (message.method) {
      reply(socket, message.id, {})
      socket.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'native' } }))
      for (const request of requests) socket.send(JSON.stringify(request))
    } else {
      responses.push(message)
      if (responses.length === requests.length) done()
    }
  })
  const handled = [], notifications = []
  const client = clientFor(t, f.root, { serverRequest: async request => {
    handled.push(request)
    if (request.id === 'approval' || request.id === 'file') return { decision: 'decline' }
    if (request.id === 'tool') return { success: false, contentItems: [] }
    throw Object.assign(new Error('No user input supported'), { rpcCode: -32601 })
  } })
  const remove = client.onNotification(() => assert.fail('Removed notification listener'))
  remove()
  client.onNotification(event => notifications.push(event))
  await client.request('initialize')
  await completed
  assert.deepEqual(handled, requests)
  assert.equal(notifications.length, 1)
  assert.deepEqual(responses.find(row => row.id === 'approval').result, { decision: 'decline' })
  assert.deepEqual(responses.find(row => row.id === 'tool').result, { success: false, contentItems: [] })
  assert.equal(responses.find(row => row.id === 'input').error.code, -32601)
})

test('onRequest and respond support explicit refusal, unsubscribe and asynchronous handler failures', async t => {
  const responses = []
  const f = await fakeServer(t, (message, socket) => {
    if (message.method) socket.send(JSON.stringify({ id: message.id, method: 'item/tool/requestUserInput', params: { threadId: 'native' } }))
    else {
      responses.push(message)
      reply(socket, message.id, {})
    }
  })
  const client = clientFor(t, f.root)
  const error = { code: -32601, message: 'TAKO cannot service this request' }
  const unsubscribe = client.onRequest(request => {
    assert.equal(request.method, 'item/tool/requestUserInput')
    assert.equal(client.respond(request.id, { error }), true)
    assert.equal(client.respond(request.id, { error }), false)
  })
  await client.request('initialize')
  assert.deepEqual(responses[0].error, error)
  unsubscribe()
  await client.request('thread/read')
  assert.equal(responses[1].error.code, -32601)
  const removeFailing = client.onRequest(async () => { throw new Error('Private error details') })
  await client.request('thread/read')
  assert.equal(responses[2].error.code, -32603)
  assert.equal(responses[2].error.message.includes('Private'), false)
  removeFailing()
  client.close()
  assert.equal(client.respond(999, { error }), false)
})

test('Sessions list, history, search and index reconciliation use only the existing Unix socket', async t => {
  forbidProcesses(t)
  let repaired = false
  const f = await fakeServer(t, (message, socket) => {
    if (!Object.hasOwn(message, 'id')) return
    const { method, params } = message
    if (method === 'initialize') return reply(socket, message.id, {})
    if (method === 'thread/list') {
      if (params.useStateDbOnly === false) repaired = true
      return reply(socket, message.id, { data: repaired ? [thread] : [], nextCursor: null })
    }
    if (method === 'thread/read') return reply(socket, message.id, { thread: { ...thread, id: params.threadId } })
    if (method === 'thread/items/list') return reply(socket, message.id, { data: [{ turnId: 'turn', startedAtMs: 1000, item: { id: 'answer', type: 'agentMessage', text: 'Native history' } }], nextCursor: null })
    if (method === 'thread/search') return reply(socket, message.id, { data: [{ thread, snippet: 'Native body match' }], nextCursor: null })
    assert.fail('Unexpected method: ' + method)
  })
  // This directory previously caused file search to resolve the executable and spawn ripgrep.
  await mkdir(join(f.root, 'sessions'))
  const adapter = createCodexSessionAdapter({ dataRoot: f.root, resolveLaunch: () => assert.fail('Must not resolve Codex executable') })
  t.after(() => adapter.close())
  assert.equal((await adapter.list(listInput)).sessions[0].session_id, 'native')
  assert.equal((await adapter.workspaces(listInput)).workspaces[0].path, '/workspace')
  const history = await adapter.messages('native', { order: 'asc' })
  assert.equal(history.messages[0].text, 'Native history')
  const search = await adapter.list({ ...listInput, query: 'body' })
  assert.equal(search.sessions[0].snippet, 'Native body match')
  assert.equal(search.search_scope, 'messages')
  assert.deepEqual(f.calls.filter(call => call.params?.useStateDbOnly === false).map(call => call.params.archived), [false, true])
  assert.equal(f.calls.filter(call => call.method === 'initialize').length, 3)
  adapter.close()
  assert.equal(f.server.listening, true)
  const next = clientFor(t, f.root)
  await next.started
})

test('Sessions reconnects after a missing server, idle disconnect and failed in-flight query without spawning', async t => {
  forbidProcesses(t)
  const root = await mkdtemp('/tmp/tako-reconnect-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const disconnects = []
  const adapter = createCodexSessionAdapter({ dataRoot: root, resolveLaunch: () => assert.fail('Must not resolve Codex executable'), createClient(options) {
    const client = createCodexSharedClient(options)
    disconnects.push(new Promise(resolve => client.onClose(resolve)))
    return client
  } })
  t.after(() => adapter.close())
  await assert.rejects(adapter.readSession('native'), { code: 'SESSION_BROWSER_UNAVAILABLE', statusCode: 503 })
  let disconnect = false
  const f = await fakeServer(t, (message, socket) => {
    if (!Object.hasOwn(message, 'id')) return
    if (message.method === 'initialize') return reply(socket, message.id, {})
    if (disconnect) { disconnect = false; socket.terminate(); return }
    reply(socket, message.id, { thread: { ...thread, id: message.params.threadId } })
  }, root)
  const results = await Promise.all(['one', 'two'].map(id => adapter.readSession(id)))
  assert.deepEqual(results.map(row => row.session_id), ['one', 'two'])
  assert.equal(f.connections(), 1)
  const current = [...f.websocket.clients][0]
  const closed = once(current, 'close')
  current.terminate()
  await closed
  await disconnects[1]
  assert.equal((await adapter.readSession('native')).session_id, 'native')
  assert.equal(f.connections(), 2)
  disconnect = true
  await assert.rejects(adapter.readSession('native'), { code: 'SESSION_BROWSER_UNAVAILABLE' })
  assert.equal((await adapter.readSession('native')).session_id, 'native')
  assert.equal(f.connections(), 3)
  adapter.close()
  assert.equal(f.server.listening, true)
})

test('Sessions search and history report unsupported methods instead of spawning fallback readers', async t => {
  forbidProcesses(t)
  const f = await fakeServer(t, (message, socket) => {
    if (!Object.hasOwn(message, 'id')) return
    if (message.method === 'initialize') return reply(socket, message.id, {})
    if (message.method === 'thread/read') return reply(socket, message.id, { thread })
    socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }))
  })
  const adapter = createCodexSessionAdapter({ dataRoot: f.root, resolveLaunch: () => assert.fail('Must not resolve executable') })
  t.after(() => adapter.close())
  await assert.rejects(adapter.list({ ...listInput, query: 'body' }), { code: 'SESSION_BROWSER_UNSUPPORTED', statusCode: 501 })
  await assert.rejects(adapter.messages('native', { order: 'asc' }), { code: 'SESSION_BROWSER_UNSUPPORTED', statusCode: 501 })
  assert.equal(f.server.listening, true)
})

test('canceling or timing out a search disconnects only that socket and preserves foreground history', async t => {
  forbidProcesses(t)
  let searching
  const receivedSearch = new Promise(resolve => { searching = resolve })
  const f = await fakeServer(t, (message, socket) => {
    if (!Object.hasOwn(message, 'id')) return
    if (message.method === 'initialize') return reply(socket, message.id, {})
    if (message.method === 'thread/search') { searching(); return }
    reply(socket, message.id, { thread })
  })
  const adapter = createCodexSessionAdapter({ dataRoot: f.root, createClient: options =>
    createCodexSharedClient({ ...options, requestTimeoutMs: 100 }) })
  t.after(() => adapter.close())
  await adapter.readSession('native')
  const controller = new AbortController()
  const canceled = assert.rejects(adapter.list({ ...listInput, query: 'body' }, { signal: controller.signal }), { name: 'AbortError' })
  await receivedSearch
  controller.abort()
  await canceled
  assert.equal((await adapter.readSession('native')).session_id, 'native')
  assert.equal(f.connections(), 2)
  await assert.rejects(adapter.list({ ...listInput, query: 'body' }), { code: 'SESSION_BROWSER_SEARCH_FAILED', statusCode: 504 })
  assert.equal((await adapter.readSession('native')).session_id, 'native')
  assert.equal(f.connections(), 3)
  assert.equal(f.server.listening, true)
})

test('Sessions keeps its read socket past the old 45-second idle limit and closes pending initialization immediately', async t => {
  let hold = false, initializing
  const held = new Promise(resolve => { initializing = resolve })
  const f = await fakeServer(t, (message, socket) => {
    if (!Object.hasOwn(message, 'id')) return
    if (message.method === 'initialize' && hold) { initializing(); return }
    reply(socket, message.id, message.method === 'initialize' ? {} : { thread })
  })
  const adapter = createCodexSessionAdapter({ dataRoot: f.root })
  t.after(() => adapter.close())
  await adapter.readSession('native')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.timers.tick(45_001)
  await adapter.readSession('native')
  assert.equal(f.connections(), 1)
  t.mock.timers.reset()
  adapter.close()
  hold = true
  const waiting = createCodexSessionAdapter({ dataRoot: f.root })
  t.after(() => waiting.close())
  const result = assert.rejects(waiting.readSession('native'), { code: 'SESSION_BROWSER_UNAVAILABLE' })
  await held
  waiting.close()
  await result
  assert.equal(f.server.listening, true)
})
