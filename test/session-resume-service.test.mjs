import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionResumeService } from '../server/src/session-resume-service.mjs'

const SCHEDULED_RUN_ID = '22222222-2222-4222-8222-222222222222'
const SCHEDULED_JOB_ID = '11111111-1111-4111-8111-111111111111'
const idleActivity = async () => ({ available: true, sessions: [] })

function scheduledRun(overrides = {}) {
  return {
    id: SCHEDULED_RUN_ID,
    job_id: SCHEDULED_JOB_ID,
    status: 'succeeded',
    thread_id: 'thread-scheduled',
    spec_json: JSON.stringify({
      title: 'Canonical scheduled title',
      workspace: '/canonical/scheduled-workspace',
      prompt: 'private scheduled prompt',
    }),
    ...overrides,
  }
}

test('scheduled Run resume uses only canonical Run facts and returns privacy-bounded metadata', async () => {
  const requests = []
  const launches = []
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    schedulerService: {
      getRun: async (...args) => {
        requests.push(args)
        return { run: scheduledRun() }
      },
    },
    sessionInventory: { has: async (sessionId) => sessionId === 'thread-scheduled' },
    sessionActivity: idleActivity,
    terminalLauncher: {
      launch: async (input) => {
        launches.push(input)
        return {
          terminal: 'otty', terminal_label: 'Otty', session_id: input.sessionId,
          workspace: input.workspace, window_title: input.title,
        }
      },
    },
  })

  const result = await service.resumeScheduledRun(SCHEDULED_RUN_ID, {
    thread_id: 'browser-thread', workspace: '/browser/workspace', title: 'Browser title',
  })

  assert.deepEqual(requests, [[SCHEDULED_RUN_ID]])
  assert.deepEqual(launches, [{
    terminal: 'otty', sessionId: 'thread-scheduled',
    workspace: '/canonical/scheduled-workspace', title: 'Canonical scheduled title',
  }])
  assert.deepEqual(result, {
    ok: true, run_id: SCHEDULED_RUN_ID, job_id: SCHEDULED_JOB_ID,
    terminal: 'otty', terminal_label: 'Otty',
  })
  assert.equal('session_id' in result, false)
  assert.equal('workspace' in result, false)
})

test('scheduled Run resume rejects a missing or invalid thread before lookup or launch', async () => {
  let threadId = null
  const service = createSessionResumeService({
    settings: { get: async () => assert.fail('settings must not be read') },
    schedulerService: { getRun: async () => ({ run: scheduledRun({ thread_id: threadId }) }) },
    sessionInventory: { has: async () => assert.fail('inventory must not be read') },
    terminalLauncher: { launch: async () => assert.fail('launcher must not run') },
  })

  for (const value of [null, 'invalid thread id']) {
    threadId = value
    await assert.rejects(
      service.resumeScheduledRun(SCHEDULED_RUN_ID),
      (error) => error.code === 'SCHEDULE_RUN_NOT_RESUMABLE',
    )
  }
})

test('scheduled OpenCode Run resume accepts native underscore session IDs', async () => {
  const sessionId = 'ses_f2e6a1c3_abc123'
  const launches = []
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'terminal' } }) },
    schedulerService: { getRun: async () => ({ run: scheduledRun({ thread_id: sessionId, runtime_id: 'opencode' }) }) },
    sessionInventory: { has: async (id, runtimeId) => id === sessionId && runtimeId === 'opencode' },
    runtimeRegistry: {
      get: () => ({ sessionExists: async ({ sessionId: id }) => id === sessionId }),
      resolve: async () => ({ executable: '/usr/local/bin/opencode' }),
    },
    terminalLauncher: { launch: async (input) => { launches.push(input); return { terminal: 'terminal' } } },
  })

  await service.resumeScheduledRun(SCHEDULED_RUN_ID)
  assert.equal(launches[0].sessionId, sessionId)
})

test('scheduled RunService resume accepts its canonical run_id-shaped resume target', async () => {
  const launches = []
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'terminal' } }) },
    runService: { isSessionActive: () => false, resumeTarget: () => ({
      run_id: SCHEDULED_RUN_ID, schedule_id: SCHEDULED_JOB_ID, runtime_id: 'opencode',
      session_id: 'ses_f1525bbabffeWegAS6bSi3rcC9', workspace: '/workspace', title: 'Scheduled task',
    }) },
    runtimeRegistry: {
      get: () => ({ sessionExists: async () => true }),
      resolve: async () => ({ executable: '/usr/local/bin/opencode' }),
    },
    sessionInventory: { has: async () => false },
    terminalLauncher: { launch: async input => { launches.push(input); return { terminal: 'terminal' } } },
  })

  const result = await service.resumeScheduledRun(SCHEDULED_RUN_ID)
  assert.equal(result.ok, true)
  assert.equal(launches[0].sessionId, 'ses_f1525bbabffeWegAS6bSi3rcC9')
})

test('scheduled Run resume rejects a missing local transcript before launch', async () => {
  const service = createSessionResumeService({
    settings: { get: async () => assert.fail('settings must not be read') },
    schedulerService: { getRun: async () => ({ run: scheduledRun() }) },
    sessionInventory: { has: async () => false },
    terminalLauncher: { launch: async () => assert.fail('launcher must not run') },
  })

  await assert.rejects(
    service.resumeScheduledRun(SCHEDULED_RUN_ID),
    (error) => error.code === 'CODEX_SESSION_NOT_FOUND',
  )
})

test('scheduled Run resume preserves typed terminal launch errors', async () => {
  const terminalError = Object.assign(new Error('Otty is unavailable'), { code: 'TERMINAL_UNAVAILABLE' })
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    schedulerService: { getRun: async () => ({ run: scheduledRun() }) },
    sessionInventory: { has: async () => true },
    sessionActivity: idleActivity,
    terminalLauncher: { launch: async () => { throw terminalError } },
  })

  await assert.rejects(
    service.resumeScheduledRun(SCHEDULED_RUN_ID),
    (error) => error === terminalError,
  )
})

function openingService({ state = 'idle', available = true, managed = false, status = 'succeeded', runtime = 'codex' } = {}) {
  const launches = [], checks = []
  const target = { run_id: SCHEDULED_RUN_ID, schedule_id: SCHEDULED_JOB_ID, status, runtime_id: runtime, session_id: 'thread-scheduled', workspace: '/canonical/scheduled-workspace', title: 'Canonical scheduled title' }
  const native = { state, available }
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    runService: { resumeTarget: () => target, isSessionActive: () => managed },
    sessionInventory: { has: async () => true },
    sessionActivity: async options => { checks.push(options); return { available: native.available, sessions: [{ session_id: target.session_id, state: native.state }] } },
    terminalLauncher: { launch: async input => { launches.push(input); return { terminal: 'otty', terminal_label: 'Otty', action: 'new_tab' } } },
  })
  return { service, launches, checks, native, target }
}

test('completed Action Run cannot resume while another Run owns the same session', async () => {
  const f = openingService({ managed: true })
  const { session } = await f.service.sessionOpening(SCHEDULED_RUN_ID)
  assert.equal(session.state, 'active')
  assert.equal(session.can_resume, false)
  assert.equal(session.can_fork, true)
  await assert.rejects(f.service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_ACTIVE', statusCode: 409 })
  assert.equal(f.launches.length, 0)
})

test('native active session blocks original resume even after the selected Run finished', async () => {
  const f = openingService({ state: 'active' })
  const { session } = await f.service.sessionOpening(SCHEDULED_RUN_ID)
  assert.equal(session.can_resume, false)
  assert.match(session.reason, /执行/)
  await assert.rejects(f.service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_ACTIVE' })
  assert.deepEqual(f.checks.at(-1), { fresh: true })
  assert.equal(f.launches.length, 0)
})

test('idle session can resume and launch rechecks native state after an idle UI snapshot', async () => {
  const f = openingService()
  assert.equal((await f.service.sessionOpening(SCHEDULED_RUN_ID)).session.can_resume, true)
  await f.service.resumeScheduledRun(SCHEDULED_RUN_ID)
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0].sessionId, 'thread-scheduled')
  f.native.state = 'active'
  await assert.rejects(f.service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_ACTIVE' })
  assert.equal(f.launches.length, 1)
})

test('unavailable or unknown native state never permits original resume but allows Fork', async () => {
  for (const input of [{ available: false }, { state: 'unknown' }, { state: 'systemError' }]) {
    const f = openingService(input)
    const { session } = await f.service.sessionOpening(SCHEDULED_RUN_ID)
    assert.equal(session.state, 'unknown')
    assert.equal(session.can_resume, false)
    assert.equal(session.can_fork, true)
    await assert.rejects(f.service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_STATUS_UNKNOWN' })
    assert.equal(f.launches.length, 0)
  }
})

test('Fork opens from immutable Run facts while active and preserves Action session identity', async () => {
  const f = openingService({ status: 'running', managed: true, available: false })
  const before = structuredClone(f.target)
  const result = await f.service.forkScheduledRun(SCHEDULED_RUN_ID, { session_id: 'browser-session', workspace: '/wrong' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.launches, [{ terminal: 'otty', sessionId: 'thread-scheduled', workspace: '/canonical/scheduled-workspace', title: 'Canonical scheduled title', mode: 'fork' }])
  assert.deepEqual(f.target, before)
  assert.equal(f.checks.length, 0)
})

test('the selected active Run blocks resume and OpenCode Fork is rejected before launch', async () => {
  const active = openingService({ status: 'running' })
  await assert.rejects(active.service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_ACTIVE' })
  assert.equal(active.launches.length, 0)
  const unsupported = openingService({ runtime: 'opencode' })
  await assert.rejects(unsupported.service.forkScheduledRun(SCHEDULED_RUN_ID), { code: 'RUNTIME_FORK_UNSUPPORTED' })
  assert.equal(unsupported.launches.length, 0)
})

test('a Run that starts during the native status query prevents the terminal launch', async () => {
  let managed = false
  const service = createSessionResumeService({
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    runService: {
      resumeTarget: () => ({ run_id: SCHEDULED_RUN_ID, schedule_id: SCHEDULED_JOB_ID, runtime_id: 'codex', session_id: 'thread-scheduled', workspace: '/workspace', title: 'Task' }),
      isSessionActive: () => managed,
    },
    sessionInventory: { has: async () => true },
    sessionActivity: async () => { managed = true; return { available: true, sessions: [] } },
    terminalLauncher: { launch: async () => assert.fail('another Run acquired this session') },
  })
  await assert.rejects(service.resumeScheduledRun(SCHEDULED_RUN_ID), { code: 'SCHEDULE_SESSION_ACTIVE' })
})
