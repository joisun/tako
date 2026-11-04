import { runtimeEvent } from './runtime/runtime-event.mjs'

// Persistence, ownership and scheduling stay with the calling domain.
export function createAgentExecution({ registry, supervisor, clock = () => new Date() }) {
  return async function execute({ runId, runtimeId, spec, signal, logs, onSpawn,
    emit, invocationSpec = spec, onInteractive = () => {}, onContinuation=()=>{},nextSequence }) {
    const launch = await abortable(registry.resolve(runtimeId), signal)
    if (signal.aborted) throw Object.assign(new Error('RUN_CANCELED'), { code: 'RUN_CANCELED' })
    const definition = registry.get(runtimeId)
    if (typeof definition.createInteractiveSession === 'function') {
      const session = definition.createInteractiveSession({
        launch, run: spec, signal, logs,onContinuation,
        onSpawn: value => onSpawn({ ...value, runtime_version: launch.version }),
        emit: event => emit(runtimeEvent({ runId, sequence: nextSequence(),
          observedAt: new Date(clock()).toISOString(), type: event.type, payload: event.payload })),
      })
      onInteractive(session)
      return session.start()
    }
    const invocation = definition.buildExecutionInvocation
      ? await definition.buildExecutionInvocation({ launch, spec })
      : await definition.buildInvocation({ launch, run: invocationSpec })
    if (signal.aborted) throw Object.assign(new Error('RUN_CANCELED'), { code: 'RUN_CANCELED' })
    const result = await supervisor.start({ invocation, signal, logs, emit,
      onSpawn: value => onSpawn({ ...value, runtime_version: launch.version }),
      parseEvent: line => definition.parseEvent(line, { runId, sequence: nextSequence(),
        observedAt: new Date(clock()).toISOString(), workspace: spec.workspace }),
    })
    return definition.normalizeResult ? definition.normalizeResult(result) : result
  }
}

function abortable(promise, signal) {
  const canceled = () => Object.assign(new Error('RUN_CANCELED'), { code: 'RUN_CANCELED' })
  if (signal.aborted) return Promise.reject(canceled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(canceled())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
