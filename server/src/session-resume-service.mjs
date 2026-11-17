import { isAbsolute } from 'node:path'

import { TAKOError } from '../../mcp/src/errors.mjs'

const ACTIVE_RUNS = new Set(['queued', 'claimed', 'running'])
const OPENING_REASONS = {
  active: '该会话正在执行，结束后才能恢复原会话。',
  unknown: '暂时无法核实会话状态，请稍后重试。',
  idle: null,
}

function resumeError(code, message, details) {
  return new TAKOError(code, message, details)
}

function scheduledRunTarget(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have resumable facts.')
  }
  if (
    typeof (run.id ?? run.run_id) !== 'string'
    || (run.id ?? run.run_id).trim() === ''
    || typeof (run.schedule_id ?? run.job_id) !== 'string'
    || (run.schedule_id ?? run.job_id).trim() === ''
    || typeof (run.session_id ?? run.thread_id) !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(run.session_id ?? run.thread_id)
  ) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid runtime session.', {
      run_id: run.id ?? run.run_id,
    })
  }

  let spec
  if (typeof run.spec_json === 'string') {
    try {
      spec = JSON.parse(run.spec_json)
    } catch {
      throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid immutable spec.', {
        run_id: run.id ?? run.run_id,
      })
    }
  } else {
    spec = { workspace: run.workspace, title: run.title }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid immutable spec.', {
      run_id: run.id ?? run.run_id,
    })
  }
  if (
    typeof spec.workspace !== 'string'
    || spec.workspace.trim() === ''
    || spec.workspace.length > 4096
    || !isAbsolute(spec.workspace)
    || typeof spec.title !== 'string'
    || spec.title.trim() === ''
    || spec.title.length > 200
  ) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid canonical Workspace and title.', {
      run_id: run.id ?? run.run_id,
    })
  }
  return {
    run_id: run.id ?? run.run_id,
    job_id: run.schedule_id ?? run.job_id,
    runtime_id: run.runtime_id ?? 'codex',
    status: run.status,
    session_id: run.session_id ?? run.thread_id,
    workspace: spec.workspace,
    title: spec.title,
  }
}

export function createSessionResumeService({
  settings,
  terminalLauncher,
  sessionInventory,
  schedulerService = null,
  runService = null,
  runtimeRegistry = null,
  sessionActivity,
} = {}) {
  if (!settings?.get) throw new TypeError('settings.get is required')
  if (!terminalLauncher?.launch) throw new TypeError('terminalLauncher.launch is required')
  if (!sessionInventory?.has) throw new TypeError('sessionInventory.has is required')
  if (schedulerService !== null && typeof schedulerService?.getRun !== 'function') {
    throw new TypeError('schedulerService.getRun is required when schedulerService is provided')
  }
  if (runService !== null && typeof runService?.resumeTarget !== 'function') {
    throw new TypeError('runService.resumeTarget is required when runService is provided')
  }
  if (runService !== null && typeof runService?.isSessionActive !== 'function') {
    throw new TypeError('runService.isSessionActive is required when runService is provided')
  }

  async function readTarget(runId) {
    const run = runService !== null
      ? runService.resumeTarget(runId, { allowActive: true })
      : (await schedulerService.getRun(runId)).run
    return scheduledRunTarget(run)
  }

  async function checkTarget(target) {
    if (target.runtime_id === 'codex') {
      if (!await sessionInventory.has(target.session_id)) {
        throw resumeError(
          'CODEX_SESSION_NOT_FOUND',
          'The Codex session transcript is not available on this machine.',
          { run_id: target.run_id, session_id: target.session_id },
        )
      }
    } else {
      const definition = runtimeRegistry?.get(target.runtime_id)
      if (target.runtime_id !== 'opencode' || typeof definition?.sessionExists !== 'function') {
        throw resumeError('RUNTIME_RESUME_UNSUPPORTED', 'This runtime cannot currently be resumed.', {
          run_id: target.run_id, runtime_id: target.runtime_id,
        })
      }
      const launch = await runtimeRegistry.resolve(target.runtime_id)
      if (!await definition.sessionExists({ launch, sessionId: target.session_id, workspace: target.workspace })) {
        throw resumeError('RUNTIME_SESSION_NOT_FOUND', 'The runtime session is not available on this machine.', {
          run_id: target.run_id, session_id: target.session_id, runtime_id: target.runtime_id,
        })
      }
    }
  }

  async function openingFor(target, { fresh = false } = {}) {
    let state = 'idle'
    const active = ACTIVE_RUNS.has(target.status)
      || runService?.isSessionActive(target.runtime_id, target.session_id)
    if (active) state = 'active'
    else if (target.runtime_id === 'codex') {
      const activity = await Promise.resolve().then(() => sessionActivity?.({ fresh })).catch(() => null)
      const native = activity?.sessions?.find(session => session.session_id === target.session_id)
      if (activity?.available !== true) state = 'unknown'
      else if (native?.state === 'active' || native?.active_flags?.length) state = 'active'
      else if (native && !['idle', 'notLoaded'].includes(native.state)) state = 'unknown'
    }
    if (runService?.isSessionActive(target.runtime_id, target.session_id)) state = 'active'
    return { state, can_resume: state === 'idle', can_fork: target.runtime_id === 'codex', reason: OPENING_REASONS[state] }
  }

  async function launchTarget(target, mode = 'resume') {
    const currentSettings = await settings.get()
    if (mode === 'resume') {
      const opening = await openingFor(target, { fresh: true })
      if (!opening.can_resume) {
        throw Object.assign(resumeError(
          opening.state === 'active' ? 'SCHEDULE_SESSION_ACTIVE' : 'SCHEDULE_SESSION_STATUS_UNKNOWN',
          opening.reason,
        ), { statusCode: 409 })
      }
    }
    const launch = await terminalLauncher.launch({
      terminal: currentSettings.settings.resume_terminal,
      ...(target.runtime_id === 'codex' ? {} : { runtimeId: target.runtime_id }),
      sessionId: target.session_id,
      workspace: target.workspace,
      title: target.title,
      ...(mode === 'fork' ? { mode } : {}),
    })
    return {
      ok: true,
      run_id: target.run_id,
      job_id: target.job_id,
      terminal: launch.terminal,
      terminal_label: launch.terminal_label,
      ...(launch.action ? { action: launch.action } : {}),
    }
  }

  async function sessionOpening(runId) {
    const target = await readTarget(runId)
    await checkTarget(target)
    return { session: await openingFor(target) }
  }

  async function resumeScheduledRun(runId) {
    const target = await readTarget(runId)
    await checkTarget(target)
    return launchTarget(target)
  }

  async function forkScheduledRun(runId) {
    const target = await readTarget(runId)
    if (target.runtime_id !== 'codex') throw resumeError('RUNTIME_FORK_UNSUPPORTED', '此客户端暂不支持 Fork 会话。')
    await checkTarget(target)
    return launchTarget(target, 'fork')
  }

  return { sessionOpening, resumeScheduledRun, forkScheduledRun }
}
