import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'

import { createCodexRuntimeDefinition } from '../server/src/runtime/adapters/codex.mjs'
import { createCodexSharedClient } from '../server/src/runtime/codex-shared-client.mjs'

const THREAD_ID = 'fake-execution-thread'
const TURN_ID = 'fake-execution-turn'

async function fixture(t, { turnError = null, hangUnsubscribe = false, sandboxType = 'readOnly' } = {}) {
  const forbidden = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name =>
    t.mock.method(childProcess, name, () => assert.fail('Unexpected process launch: ' + name)))
  syncBuiltinESMExports()
  t.after(() => {
    for (const mock of forbidden) {
      assert.equal(mock.mock.callCount(), 0)
      mock.mock.restore()
    }
    syncBuiltinESMExports()
  })

  const root = await mkdtemp('/tmp/tako-execution-')
  await mkdir(join(root, 'app-server-control'))
  const server = createServer()
  const websocket = new WebSocketServer({ server })
  const calls = []
  const sockets = []
  let receivedUnsubscribe
  const unsubscribing = new Promise(resolve => { receivedUnsubscribe = resolve })
  websocket.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', bytes => {
      const request = JSON.parse(bytes)
      calls.push(request)
      if (!Object.hasOwn(request, 'id')) return
      const reply = result => socket.send(JSON.stringify({ id: request.id, result }))
      if (request.method === 'initialize') return reply({})
      if (request.method === 'thread/start') return reply({ thread: { id: THREAD_ID }, sandbox: { type: sandboxType } })
      if (request.method === 'thread/loaded/list') return reply({ data: [], nextCursor: null })
      if (request.method === 'thread/unsubscribe') {
        receivedUnsubscribe()
        if (!hangUnsubscribe) reply({})
        return
      }
      if (request.method === 'turn/start') {
        if (turnError) socket.send(JSON.stringify({ id: request.id, error: turnError }))
        else reply({ turn: { id: TURN_ID, status: 'inProgress', items: [] } })
        return
      }
      if (request.method === 'turn/interrupt') {
        reply({})
        socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: THREAD_ID, turn: { id: TURN_ID, status: 'interrupted', items: [] },
        } }))
        return
      }
      if (request.method === 'thread/turns/list') return reply({ data: [{ id: TURN_ID, status: 'interrupted' }], nextCursor: null })
      assert.fail('Unexpected RPC method: ' + request.method)
    })
  })
  server.listen(join(root, 'app-server-control', 'app-server-control.sock'))
  await once(server, 'listening')
  const clients = []
  t.after(async () => {
    for (const client of clients) client.close()
    for (const socket of websocket.clients) socket.terminate()
    await Promise.all([
      new Promise(resolve => websocket.close(resolve)),
      new Promise(resolve => server.close(resolve)),
    ])
    await rm(root, { recursive: true, force: true })
  })
  const runtime = createCodexRuntimeDefinition({
    dataRoot: root,
    createClient(options) {
      assert.equal(options.dataRoot, root)
      const client = createCodexSharedClient(options)
      clients.push(client)
      return client
    },
  })
  const controller = new AbortController()
  let turnStarted
  const started = new Promise(resolve => { turnStarted = resolve })
  const spawns = []
  const session = runtime.createInteractiveSession({
    launch: { executable: '/never-start-a-provider' },
    run: { workspace: root, prompt: 'Fake server regression only', sandbox_mode: 'read-only',
      capabilities: { skills: 'inherit', integrations: 'inherit' } },
    signal: controller.signal,
    emit(event) { if (event.type === 'turn_started') turnStarted() },
    onSpawn(value) { spawns.push(value) },
  })
  return { root, server, sockets, clients, calls, session, controller, started, spawns, unsubscribing }
}

for (const rpcCode of [-32600, -32601, -32602, -32001]) {
  test(`explicit turn/start rejection ${rpcCode} does not mark execution as still running`, async t => {
    const f = await fixture(t, { turnError: { code: rpcCode, message: 'Fake server rejected this request before execution' } })
    const result = await f.session.start()
    assert.equal(result.status, 'failed')
    assert.notEqual(result.execution_stopped, false)
    assert.equal(result.session_id, THREAD_ID)
    assert.equal(result.error_code, rpcCode === -32601 ? 'RUNTIME_PROTOCOL_METHOD_UNAVAILABLE' : 'RUNTIME_PROTOCOL_ERROR')
    assert.deepEqual(f.spawns, [{ pid: null }])
    assert.equal(f.clients.length, 1)
    assert.equal(f.clients[0].closed, true)
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
    assert.equal(f.calls.some(call => call.method === 'thread/unsubscribe'), true)
    assert.equal(f.server.listening, true)
  })
}

test('internal turn/start RPC error -32603 retains unknown execution state', async t => {
  const f = await fixture(t, { turnError: { code: -32603, message: 'Fake internal error after possible acceptance' } })
  const result = await f.session.start()
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'RUNTIME_PROTOCOL_ERROR')
  assert.equal(result.execution_stopped, false)
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
  assert.equal(f.clients[0].closed, true)
  assert.equal(f.server.listening, true)
})

test('a read-only run refuses dangerFullAccess before sending turn/start', async t => {
  const f = await fixture(t, { sandboxType: 'dangerFullAccess' })
  const result = await f.session.start()
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'RUNTIME_SANDBOX_MISMATCH')
  assert.notEqual(result.execution_stopped, false)
  assert.equal(f.calls.find(call => call.method === 'thread/start').params.sandbox, 'read-only')
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false)
  assert.equal(f.clients[0].closed, true)
  assert.equal(f.server.listening, true)
})

for (const outcome of ['completed', 'canceled']) {
  test(`hung unsubscribe after ${outcome} is bounded by two seconds and preserves the shared server`, async t => {
    const f = await fixture(t, { hangUnsubscribe: true })
    const completion = f.session.start()
    await f.started
    const observer = createCodexSharedClient({ dataRoot: f.root, requestTimeoutMs: 20_000 })
    t.after(() => observer.close())
    await observer.started
    await observer.request('initialize')
    const originalClosed = once(f.sockets[0], 'close')
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => t.mock.timers.reset())
    let resolved = false
    void completion.then(() => { resolved = true })
    if (outcome === 'canceled') f.controller.abort()
    else f.sockets[0].send(JSON.stringify({ method: 'turn/completed', params: {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] },
    } }))
    await f.unsubscribing
    t.mock.timers.tick(1999)
    await Promise.resolve()
    assert.equal(resolved, false)
    assert.equal(f.clients[0].closed, false)
    t.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(resolved, true)
    const result = await completion
    await originalClosed
    assert.equal(result.status, outcome === 'canceled' ? 'canceled' : 'succeeded')
    assert.notEqual(result.execution_stopped, false)
    assert.equal(f.clients[0].closed, true)
    assert.equal(f.server.listening, true)
    assert.equal(observer.closed, false)
    assert.deepEqual(await observer.request('thread/loaded/list'), { data: [], nextCursor: null })
    assert.equal(f.calls.some(call => call.method === 'shutdown'), false)
  })
}
