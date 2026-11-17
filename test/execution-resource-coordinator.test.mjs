import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createExecutionResourceCoordinator } from '../server/src/execution-resource-coordinator.mjs'
import { createCollaborationRuntime } from '../server/src/collaboration-runtime.mjs'
import { createCollaborationStore } from '../server/src/collaboration/store.mjs'

function fixture(t, isAlive = () => false) {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  return { database, resources: createExecutionResourceCoordinator({ database, isAlive }) }
}

for (const options of [undefined, { executionStopped: true }]) {
  test(`shared execution with no PID releases all claims when stopped (${JSON.stringify(options)})`, async t => {
    const { resources } = fixture(t, () => assert.fail('No shared server PID should be checked'))
    const lease = resources.acquire({ owner: 'schedule', runId: 'run', workspaces: ['/project', '/output'] })
    lease.spawned(null)
    assert.equal(await lease.releaseWhenExited(null, options), true)
    assert.deepEqual(resources.list(), [])
    assert.ok(resources.acquire({ owner: 'collaboration', runId: 'next', workspace: '/project' }))
  })
}

for (const pid of [null, 123]) {
  test(`unconfirmed execution keeps all claims unknown even without a live PID (${pid})`, async t => {
    const { resources } = fixture(t)
    const lease = resources.acquire({ owner: 'schedule', runId: 'run', workspaces: ['/project', '/output'] })
    lease.spawned(pid)
    assert.equal(await lease.releaseWhenExited(pid, { executionStopped: false }), false)
    assert.deepEqual(resources.list().map(row => ({ pid: row.pid, state: row.state })),
      [{ pid, state: 'unknown' }, { pid, state: 'unknown' }])
    for (const workspace of ['/project/child', '/output']) {
      assert.equal(resources.acquire({ owner: 'collaboration', runId: 'next', workspace, access: 'observe' }), null)
    }
  })
}

test('owned process still alive retains an unknown claim', async t => {
  const { resources } = fixture(t, pid => pid === 123)
  const lease = resources.acquire({ owner: 'schedule', runId: 'run', workspace: '/project' })
  lease.spawned(123)
  assert.equal(await lease.releaseWhenExited(123), false)
  assert.equal(resources.list()[0].state, 'unknown')
  assert.throws(() => resources.reconcile('schedule', 'run'), { code: 'LOOP_PROCESS_STILL_RUNNING' })
})

test('owned process releases its claim after exiting', async t => {
  let checks = 0
  const { resources } = fixture(t, () => ++checks === 1)
  const lease = resources.acquire({ owner: 'schedule', runId: 'run', workspace: '/project' })
  lease.spawned(123)
  assert.equal(await lease.releaseWhenExited(123), true)
  assert.ok(checks > 1)
  assert.deepEqual(resources.list(), [])
})

async function collaborationFixture(t, executeAgent) {
  const database = new DatabaseSync(':memory:')
  const resources = createExecutionResourceCoordinator({ database })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tako-resource-coordination-')))
  const store = { ...createCollaborationStore({ database }) }
  let finished
  const completion = new Promise(resolve => { finished = resolve })
  const runtime = createCollaborationRuntime({
    store, resources, workspaceRoot: join(root, 'workspaces'), executeAgent,
    registry: { resolve: async () => ({}), get: () => ({}) },
    logs: { open: async () => ({ close: async () => {} }) },
    onChange() {
      const run = store.database.prepare("SELECT id FROM loop_runs WHERE status IN ('succeeded','failed','canceled','unknown')").get()
      if (run) finished(store.run(run.id))
    },
  })
  t.after(async () => { await runtime.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const room = await runtime.createRoom({ title: 'Shared execution resource test' })
  const message = await runtime.postMessage(room.id, { text: 'Check resource coordination', request_key: 'start' })
  const run = store.detail(message.task_id).runs[0]
  return { resources, store, runtime, run, completion }
}

for (const executionStopped of [undefined, true, false]) {
  test(`collaboration preserves shared execution resource claims until stopped (${executionStopped})`, { timeout: 5_000 }, async t => {
    let current, observed
    current = await collaborationFixture(t, async ({ onSpawn }) => {
      onSpawn({ pid: null })
      observed = current.store.run(current.run.id)
      return { status: 'succeeded', execution_stopped: executionStopped }
    })
    await current.runtime.start('http://127.0.0.1:1')
    const completed = await current.completion
    assert.equal(observed.status, 'running')
    assert.equal(observed.pid, null)
    assert.equal(completed.status, executionStopped === false ? 'unknown' : 'succeeded')
    assert.deepEqual(current.resources.list().map(({ pid, state }) => ({ pid, state })),
      executionStopped === false ? [{ pid: null, state: 'unknown' }] : [])
  })
}

for (const executionStopped of [true, false]) {
  test(`collaboration preserves stop confirmation after project refresh fails (${executionStopped})`, { timeout: 5_000 }, async t => {
    const current = await collaborationFixture(t, async ({ onSpawn }) => {
      onSpawn({ pid: null })
      return { status: 'succeeded', execution_stopped: executionStopped }
    })
    const refreshProjects = current.store.refreshProjects
    let refreshes = 0
    current.store.refreshProjects = (...args) => {
      if (++refreshes === 2) throw Object.assign(new Error('Project refresh failed'), { code: 'LOOP_WORKSPACE_UNAVAILABLE' })
      return refreshProjects(...args)
    }
    await current.runtime.start('http://127.0.0.1:1')
    assert.equal((await current.completion).status, executionStopped ? 'failed' : 'unknown')
    assert.equal(refreshes, 2)
    assert.deepEqual(current.resources.list().map(({ pid, state }) => ({ pid, state })),
      executionStopped ? [] : [{ pid: null, state: 'unknown' }])
  })
}

for (const spawned of [false, true]) {
  test(`collaboration retains claims on unexpected failure only after spawn (${spawned})`, { timeout: 5_000 }, async t => {
    const current = await collaborationFixture(t, async ({ onSpawn }) => {
      if (spawned) onSpawn({ pid: null })
      throw Object.assign(new Error('Connection unavailable'), { code: 'RUNTIME_UNAVAILABLE' })
    })
    await current.runtime.start('http://127.0.0.1:1')
    assert.equal((await current.completion).status, spawned ? 'unknown' : 'failed')
    assert.deepEqual(current.resources.list().map(({ pid, state }) => ({ pid, state })),
      spawned ? [{ pid: null, state: 'unknown' }] : [])
  })
}
