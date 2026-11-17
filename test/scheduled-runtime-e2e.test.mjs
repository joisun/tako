import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'

import { startDaemon } from '../server/src/daemon-runtime.mjs'
import { createCodexRuntimeDefinition } from '../server/src/runtime/adapters/codex.mjs'
import { createCodexSessionAdapter } from '../server/src/runtime/adapters/codex-sessions.mjs'
import { createExecutableResolver } from '../server/src/runtime/executable-resolver.mjs'

const SESSION_ID = '019fcfae-8d5b-7640-aec8-83a114810589'

async function writeFakeCodex(directory) {
  const path = join(directory, 'codex')
  const invocationLog = join(directory, 'codex-invocations.jsonl')
  await writeFile(invocationLog, '')
  await writeFile(path, `#!/usr/bin/env node
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n')
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.999.0\\n')
  process.exit(0)
}
process.stderr.write('Unexpected Codex process command: ' + JSON.stringify(args) + '\\n')
process.exit(1)
`, { mode: 0o700 })
  await chmod(path, 0o700)
  return { path, invocationLog }
}

async function startFakeAppServer(dataRoot, { disconnect }) {
  const socketPath = join(dataRoot, 'app-server-control', 'app-server-control.sock')
  await mkdir(join(dataRoot, 'app-server-control'), { recursive: true })
  const server = createServer()
  const websocket = new WebSocketServer({ server })
  const calls = []
  const timers = new Set()
  let turnStatus = null
  let loaded = false
  let connections = 0
  websocket.on('connection', socket => {
    connections += 1
    const send = message => socket.send(JSON.stringify(message))
    const result = (id, value) => send({ id, result: value })
    const notify = (method, params) => send({ method, params: { threadId: SESSION_ID, ...params } })
    socket.on('message', bytes => {
      const request = JSON.parse(bytes.toString())
      calls.push(request)
      if (request.method === 'initialized') return
      if (request.method === 'initialize') return result(request.id, { userAgent: 'codex-cli 0.999.0' })
      if (request.method === 'config/read') {
        return result(request.id, { config: { mcp_servers: { external: { command: 'must-not-run' } } } })
      }
      if (request.method === 'skills/list') {
        assert.equal(request.params.forceReload, true)
        return result(request.id, { data: [{
          cwd: request.params.cwds[0], errors: [],
          skills: [{ name: 'report', path: '/skills/report/SKILL.md', enabled: true }],
        }] })
      }
      if (request.method === 'thread/start') {
        const config = request.params.config
        assert.deepEqual(config.skills.config, [{ path: '/skills/report/SKILL.md', enabled: false }])
        assert.equal(config.features.skill_search, false)
        assert.equal(config.features.skill_mcp_dependency_install, false)
        for (const key of ['features.plugins', 'features.apps', 'apps._default.enabled', 'mcp_servers.external.enabled']) {
          assert.equal(config[key], false, key)
        }
        assert.equal(JSON.stringify(config).includes('web_search'), false)
        loaded = true
        return result(request.id, { thread: { id: SESSION_ID, turns: [] }, sandbox: { type: 'workspaceWrite' } })
      }
      if (request.method === 'thread/loaded/list') {
        return result(request.id, { data: loaded ? [SESSION_ID] : [], nextCursor: null })
      }
      if (request.method === 'thread/unsubscribe') {
        assert.equal(request.params.threadId, SESSION_ID)
        loaded = false
        return result(request.id, {})
      }
      if (request.method === 'turn/start') {
        assert.equal(request.params.threadId, SESSION_ID)
        assert.match(request.params.input[0].text, /Create the report/)
        turnStatus = 'inProgress'
        result(request.id, { turn: { id: 'turn-1', status: turnStatus, items: [] } })
        notify('turn/started', { turn: { id: 'turn-1', status: turnStatus, items: [] } })
        notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'message-1', delta: 'Starting report. ' })
        if (disconnect) timers.add(setTimeout(() => socket.terminate(), 100))
        return
      }
      if (request.method === 'turn/steer') {
        assert.equal(turnStatus, 'inProgress')
        assert.equal(request.params.threadId, SESSION_ID)
        assert.equal(request.params.expectedTurnId, 'turn-1')
        assert.match(request.params.input[0].text, /summary/)
        result(request.id, { turnId: 'turn-1' })
        notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'message-1', delta: 'Added summary.' })
        notify('item/completed', { turnId: 'turn-1', item: { id: 'files-1', type: 'fileChange', status: 'completed', changes: [{ path: 'report.md', kind: 'update' }] } })
        notify('item/completed', { turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Report created with summary.' } })
        turnStatus = 'completed'
        return notify('turn/completed', { turn: { id: 'turn-1', status: turnStatus, items: [] } })
      }
      if (request.method === 'turn/interrupt') {
        assert.equal(request.params.threadId, SESSION_ID)
        assert.equal(request.params.turnId, 'turn-1')
        turnStatus = 'interrupted'
        result(request.id, {})
        return notify('turn/completed', { turn: { id: 'turn-1', status: turnStatus, items: [] } })
      }
      if (request.method === 'thread/turns/list') {
        return result(request.id, { data: [{ id: 'turn-1', status: turnStatus, items: [] }], nextCursor: null })
      }
      assert.fail(`Unexpected shared app-server method: ${request.method}`)
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return {
    calls,
    async assertAcceptsConnection() {
      assert.equal(server.listening, true)
      const previous = connections
      const socket = new WebSocket(`ws+unix:${socketPath}:/`, { handshakeTimeout: 1_000 })
      try {
        await once(socket, 'open')
        assert.equal(connections, previous + 1)
      } finally { socket.terminate() }
    },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of websocket.clients) socket.terminate()
      await Promise.all([
        new Promise(resolve => websocket.close(resolve)),
        new Promise(resolve => server.close(resolve)),
      ])
    },
  }
}

async function request(url, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForRun(url, runId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await request(url, `/api/v1/runs/${runId}`)
    if (!['queued', 'running'].includes(result.body.run.status)) return result.body.run
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Run did not finish')
}

async function waitForActiveTurn(url, runId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await request(url, `/api/v1/runs/${runId}`)
    if (result.body.run.status === 'running' && result.body.run.turn_revision === 1) {
      return result.body.run
    }
    if (!['queued', 'running'].includes(result.body.run.status)) {
      throw new Error(`Run stopped before exposing an active Turn: ${JSON.stringify(result.body.run)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Run did not expose an active Turn')
}

async function readRunEvents(url, runId) {
  const response = await fetch(`${url}/api/v1/runs/${runId}/events`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      assert.equal(done, false, 'Run event stream ended before terminal status')
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop()
      for (const frame of frames) {
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (!data) continue
        const event = JSON.parse(data.slice(6))
        events.push(event)
        if (event.type === 'status' && ['succeeded', 'failed', 'canceled'].includes(event.payload.state)) return events
      }
    }
  } finally { await reader.cancel() }
}

async function waitForResources(databasePath, runId, disconnected) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const rows = database.prepare('SELECT owner, run_id, pid, state FROM execution_resources WHERE run_id = ?').all(runId)
      if (disconnected && rows[0]?.state === 'unknown') {
        assert.deepEqual(rows.map(row => ({ ...row })), [{ owner: 'schedule', run_id: runId, pid: null, state: 'unknown' }])
        return
      }
      if (!disconnected && rows.length === 0) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('Execution resource claim did not settle')
  } finally { database.close() }
}

for (const outcome of ['succeeded', 'disconnected', 'interrupted']) test(`daemon executes Actions using an existing shared app-server (${outcome})`, async (t) => {
  // Keep the Unix socket path below the macOS limit, including its fixed suffix.
  const root = await mkdtemp('/tmp/tako-e2e-')
  let runtime
  let appServer
  t.after(async () => {
    try { await runtime?.close() } finally {
      try { await appServer?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const workspace = join(root, 'workspace')
  const data = join(root, 'data')
  const codexRoot = join(root, 'codex-root')
  const databasePath = join(data, 'scheduler.sqlite')
  await mkdir(workspace)
  await mkdir(data)
  const codex = await writeFakeCodex(root)
  appServer = await startFakeAppServer(codexRoot, { disconnect: outcome === 'disconnected' })

  runtime = await startDaemon({
    config: {
      databasePath: join(data, 'journal.sqlite'),
      schedulerDatabasePath: databasePath,
      scheduleDefinitionsDirectory: join(data, 'schedules'),
      schedulerLogsDirectory: join(data, 'run-logs'),
      codexPath: codex.path,
      outputDir: root,
      serverHost: '127.0.0.1',
      serverPort: 0,
    },
    dashboardHtml: '<!doctype html><title>TAKO</title>',
    createCodexRuntime: (options = {}) => createCodexRuntimeDefinition({ ...options, dataRoot: codexRoot }),
    createSessionAdapter: (options = {}) => createCodexSessionAdapter({ ...options, dataRoot: codexRoot }),
    createRuntimeResolver: options => createExecutableResolver({ ...options, candidatePaths: () => [] }),
  })

  assert.equal(runtime.scheduler.ready, true)
  const created = await request(runtime.address.url, '/api/v1/schedules', {
    method: 'POST',
    body: {
      title: 'Create report',
      prompt: 'Create the report in report.md.',
      workspace,
      agent: 'codex',
      cadence: { kind: 'daily', hour: 9, minute: 0 },
      sandbox_mode: 'workspace-write',
      model: null,
      reasoning_effort: null,
      timeout_seconds: 600,
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.job.agent, 'codex')
  assert.deepEqual(created.body.job.capabilities, {
    skills: 'disabled',
    integrations: 'disabled',
  })

  const launched = await request(runtime.address.url, '/api/v1/runs', {
    method: 'POST',
    body: {
      schedule_id: created.body.job.id,
      origin: 'manual',
      idempotency_key: 'manual-e2e-run',
    },
  })
  assert.equal(launched.status, 202, JSON.stringify(launched.body))
  assert.equal(launched.body.run.status, 'queued')

  if (outcome === 'disconnected') {
    const failed = await waitForRun(runtime.address.url, launched.body.run.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error_code, 'RUNTIME_PROTOCOL_CLOSED')
    assert.equal(failed.exit_code, null)
    assert.equal(failed.session_id, SESSION_ID)
    assert.equal(failed.interactive, false)
    const retry = await request(runtime.address.url, `/api/v1/runs/${failed.id}/steer`, {
      method: 'POST', body: { expected_turn_revision: 1, text: 'Please add a summary.' },
    })
    assert.notEqual(retry.status, 202)
    assert.equal(retry.body.error.code, 'RUN_NOT_ACTIVE')
  } else {
    const active = await waitForActiveTurn(runtime.address.url, launched.body.run.id)
    assert.equal(active.interactive, true)
    assert.equal(active.session_id, SESSION_ID)

    if (outcome === 'interrupted') {
      const canceled = await request(runtime.address.url, `/api/v1/runs/${active.id}/cancel`, { method: 'POST', body: {} })
      assert.equal(canceled.status, 200, JSON.stringify(canceled.body))
    } else {
      const steered = await request(runtime.address.url, `/api/v1/runs/${active.id}/steer`, {
        method: 'POST',
        body: { expected_turn_revision: 1, text: 'Please add a summary.' },
      })
      assert.equal(steered.status, 202, JSON.stringify(steered.body))
      assert.deepEqual(steered.body, {
        accepted: true,
        run_id: active.id,
        turn_revision: 1,
      })
    }

    const run = await waitForRun(runtime.address.url, launched.body.run.id)
    assert.equal(run.status, outcome === 'interrupted' ? 'canceled' : 'succeeded')
    assert.equal(run.runtime_id, 'codex')
    assert.equal(run.session_id, SESSION_ID)
    if (outcome === 'succeeded') {
      assert.equal(run.exit_code, 0)
      assert.deepEqual(run.file_changes, [{ path: 'report.md', kind: 'update' }])
      assert.equal(run.final_message, 'Report created with summary.')
    } else {
      assert.equal(run.exit_code, null)
      assert.equal(run.error_code, 'RUN_CANCELED')
    }
    assert.equal(appServer.calls.filter(call => call.method === 'thread/unsubscribe').length, 1)
    assert.ok(appServer.calls.some(call => call.method === 'thread/loaded/list'))
    assert.equal(appServer.calls.filter(call => call.method === 'turn/interrupt').length, outcome === 'interrupted' ? 1 : 0)
  }

  const events = await readRunEvents(runtime.address.url, launched.body.run.id)
  assert.ok(events.some(event => event.type === 'assistant_delta' && event.payload.delta === 'Starting report. '))
  if (outcome === 'succeeded') {
    assert.ok(events.some(event => event.type === 'assistant_delta' && event.payload.delta === 'Added summary.'))
  }
  await waitForResources(databasePath, launched.body.run.id, outcome === 'disconnected')
  await appServer.assertAcceptsConnection()
  await runtime.close()
  await appServer.assertAcceptsConnection()
  await waitForResources(databasePath, launched.body.run.id, outcome === 'disconnected')
  const invocations = (await readFile(codex.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(invocations.length > 0, 'CLI version probe should use the fake executable')
  for (const args of invocations) assert.deepEqual(args, ['--version'], 'TAKO must not launch app-server, exec, mcp or debug commands')
})
