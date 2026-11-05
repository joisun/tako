import { createHash } from 'node:crypto'

import { parseDocument, stringify } from '../../vendor/yaml.mjs'

import { validateCadence } from './cadence.mjs'
import { SchedulerError } from './scheduler-errors.mjs'
import { isCodexModelSlug, isCodexReasoningLevel } from './codex-model-selection.mjs'
import { THREAD_MODES, validInheritanceLimit } from '../session-policy.mjs'

const DEFINITION_TYPE = 'undercontrol/action'
// Read existing user Markdown without rewriting it during installation. New writes use UnderControl.
const LEGACY_DEFINITION_TYPES = new Set(['rillo/action', 'rillo/schedule', 'undercontrol/schedule', 'tasks-recorder/schedule', 'task-recorder/schedule', 'tasks_recorder/schedule', 'task_recorder/schedule'])
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DURATION = /^(\d+)(s|m|h)$/
const AGENT = /^[a-z][a-z0-9-]{0,63}$/
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/
const MARKER = /^type:\s*["']?(?:undercontrol|rillo|tasks?[-_]recorder)\/(?:schedule|action)["']?\s*(?:#.*)?$/m
const FIELDS = new Set([
  'type', 'id', 'title', 'enabled', 'schedule_enabled', 'external_enabled', 'external_secret', 'workspace', 'agent', 'schedule', 'capabilities',
  'sandbox', 'model', 'reasoning', 'fast_mode', 'network_access', 'timeout', 'session_id',
  'thread_mode', 'max_inherit_runs',
  // Read retired fields without applying or writing them back.
  'auto_compact_token_limit',
])
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const OPENCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:/~-]*$/
const OPENCODE_VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CAPABILITY_MODES = new Set(['inherit', 'disabled'])
const WEEKDAYS = new Map([
  ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 7],
])
const WEEKDAY_NAMES = new Map([...WEEKDAYS].map(([name, value]) => [value, name]))

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must be an object`, { field })
  }
  return value
}

function exactFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SCHEDULE_DEFINITION_INVALID', `unsupported ${field} field: ${key}`, { field: key })
  }
}

function string(value, field, max) {
  if (typeof value !== 'string') fail('SCHEDULE_DEFINITION_INVALID', `${field} must be a string`, { field })
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must contain 1 to ${max} characters`, { field })
  }
  return normalized
}

function optionalSelection(value, field, validator, maximum) {
  if (value === undefined || value === null || value === '') return null
  const normalized = string(value, field, maximum)
  if (!validator(normalized)) fail('SCHEDULE_DEFINITION_INVALID', `${field} is invalid`, { field })
  return normalized
}

function agentId(value = 'codex') {
  const normalized = string(value, 'agent', 64)
  if (!AGENT.test(normalized)) {
    fail('SCHEDULE_DEFINITION_INVALID', 'agent is invalid', { field: 'agent' })
  }
  return normalized
}

function capabilities(value) {
  if (value === undefined || value === null) {
    return { skills: 'inherit', integrations: 'inherit' }
  }
  const policy = object(value, 'capabilities')
  exactFields(policy, new Set(['skills', 'integrations']), 'capabilities')
  const mode = (field) => {
    const selected = policy[field] ?? 'inherit'
    if (!CAPABILITY_MODES.has(selected)) {
      fail('SCHEDULE_DEFINITION_INVALID', `capabilities.${field} is invalid`, {
        field: `capabilities.${field}`,
      })
    }
    return selected
  }
  return { skills: mode('skills'), integrations: mode('integrations') }
}

function time(value, field = 'schedule.at') {
  if (typeof value !== 'string' || !TIME.test(value)) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must be HH:mm`, { field })
  }
  const [hour, minute] = value.split(':').map(Number)
  return { hour, minute }
}

function timeoutSeconds(value) {
  if (value === undefined || value === null) return 7200
  let seconds
  if (Number.isInteger(value)) seconds = value
  else if (typeof value === 'string') {
    const match = DURATION.exec(value.trim())
    if (!match) fail('SCHEDULE_DEFINITION_INVALID', 'timeout must use s, m, or h units', { field: 'timeout' })
    const factor = { s: 1, m: 60, h: 3600 }[match[2]]
    seconds = Number(match[1]) * factor
  }
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) {
    fail('SCHEDULE_DEFINITION_INVALID', 'timeout must be from 60s to 24h', { field: 'timeout' })
  }
  return seconds
}

function sessionPolicy(value) {
  const thread_mode = value.thread_mode ?? 'new'
  if (!THREAD_MODES.has(thread_mode)) fail('SCHEDULE_DEFINITION_INVALID', 'thread_mode must be new, reuse or auto', { field: 'thread_mode' })
  const max_inherit_runs = value.max_inherit_runs ?? 20
  if (!validInheritanceLimit(max_inherit_runs)) fail('SCHEDULE_DEFINITION_INVALID', 'max_inherit_runs must be 1–10000', { field: 'max_inherit_runs' })

  return { thread_mode, max_inherit_runs }
}

function duration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function cadence(value, clock, { allowPastOnce = false } = {}) {
  const original = object(value, 'schedule')
  const { work_hours, ...schedule } = original
  const hours = work_hours === undefined ? {} : { work_hours }
  if (typeof schedule.kind !== 'string') fail('SCHEDULE_DEFINITION_INVALID', 'schedule.kind is required', { field: 'schedule.kind' })
  const kind = schedule.kind
  if (kind === 'once') {
    if (work_hours !== undefined) fail('SCHEDULE_DEFINITION_INVALID', 'once schedules cannot define work_hours', { field: 'schedule.work_hours' })
    exactFields(schedule, new Set(['kind', 'at']), 'schedule')
    const at = string(schedule.at, 'schedule.at', 40)
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
      fail('SCHEDULE_DEFINITION_INVALID', 'schedule.at must include a timezone offset', { field: 'schedule.at' })
    }
    return validateCadence({ kind, at }, { now: clock(), allowPastOnce })
  }
  if (kind === 'interval') {
    exactFields(schedule, new Set(['kind', 'minutes']), 'schedule')
    return validateCadence({ kind, minutes: schedule.minutes, ...hours })
  }
  if (kind === 'hourly') {
    exactFields(schedule, new Set(['kind', 'minute']), 'schedule')
    return validateCadence({ kind, minute: schedule.minute, ...hours })
  }
  if (kind === 'daily') {
    exactFields(schedule, new Set(['kind', 'at']), 'schedule')
    return validateCadence({ kind, ...time(schedule.at), ...hours })
  }
  if (kind === 'weekly') {
    exactFields(schedule, new Set(['kind', 'on', 'at']), 'schedule')
    if (!Array.isArray(schedule.on) || schedule.on.length === 0) {
      fail('SCHEDULE_DEFINITION_INVALID', 'schedule.on must contain weekday names', { field: 'schedule.on' })
    }
    const weekdays = schedule.on.map((day) => {
      if (typeof day !== 'string' || !WEEKDAYS.has(day.toLowerCase())) {
        fail('SCHEDULE_DEFINITION_INVALID', `unsupported weekday: ${String(day)}`, { field: 'schedule.on' })
      }
      return WEEKDAYS.get(day.toLowerCase())
    })
    return validateCadence({ kind, weekdays, ...time(schedule.at), ...hours })
  }
  if (kind === 'monthly') {
    exactFields(schedule, new Set(['kind', 'day', 'at']), 'schedule')
    return validateCadence({ kind, day: schedule.day, ...time(schedule.at), ...hours })
  }
  fail('SCHEDULE_DEFINITION_INVALID', `unsupported schedule kind: ${kind}`, { field: 'schedule.kind' })
}

function humanCadenceBase(value) {
  const at = (hour, minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (value.kind === 'once') return { kind: 'once', at: value.at }
  if (value.kind === 'interval') return { kind: 'interval', minutes: value.minutes }
  if (value.kind === 'hourly') return { kind: 'hourly', minute: value.minute }
  if (value.kind === 'daily') return { kind: 'daily', at: at(value.hour, value.minute) }
  if (value.kind === 'weekly') {
    return { kind: 'weekly', on: value.weekdays.map((day) => WEEKDAY_NAMES.get(day)), at: at(value.hour, value.minute) }
  }
  return { kind: 'monthly', day: value.day, at: at(value.hour, value.minute) }
}

function humanCadence(value) {
  return { ...humanCadenceBase(value), ...(value.work_hours ? { work_hours: value.work_hours } : {}) }
}

export function definitionEtag(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  return createHash('sha256').update(source).digest('hex')
}

export function parseScheduleDefinition(source, {
  sourcePath = null,
  clock = () => new Date(),
} = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  const match = FRONT_MATTER.exec(source.replace(/^\uFEFF/, ''))
  if (!match || !MARKER.test(match[1])) return null
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    fail('SCHEDULE_DEFINITION_YAML_INVALID', 'Action front matter YAML is invalid', { source_path: sourcePath })
  }
  const frontMatter = object(document.toJS({ maxAliasCount: 0 }), 'front matter')
  exactFields(frontMatter, FIELDS, 'front matter')
  if (frontMatter.type !== DEFINITION_TYPE && !LEGACY_DEFINITION_TYPES.has(frontMatter.type)) {
    fail('SCHEDULE_DEFINITION_INVALID', `type must be ${DEFINITION_TYPE}`, { field: 'type' })
  }
  const id = string(frontMatter.id, 'id', 128)
  if (!ID.test(id)) fail('SCHEDULE_DEFINITION_INVALID', 'id must be a UUID', { field: 'id' })
  if (frontMatter.enabled !== undefined && typeof frontMatter.enabled !== 'boolean') {
    fail('SCHEDULE_DEFINITION_INVALID', 'enabled must be boolean', { field: 'enabled' })
  }
  if (frontMatter.network_access != null && (typeof frontMatter.network_access !== 'boolean' || agentId(frontMatter.agent) !== 'codex')) {
    fail('SCHEDULE_DEFINITION_INVALID', 'network_access requires Codex and a boolean value', { field: 'network_access' })
  }
  if (frontMatter.fast_mode != null && typeof frontMatter.fast_mode !== 'boolean') {
    fail('SCHEDULE_DEFINITION_INVALID', 'fast_mode must be boolean or null', { field: 'fast_mode' })
  }
  if (frontMatter.fast_mode != null && agentId(frontMatter.agent) !== 'codex') {
    fail('SCHEDULE_DEFINITION_INVALID', 'fast_mode is only supported by Codex', { field: 'fast_mode' })
  }
  const sandbox = frontMatter.sandbox ?? 'read-only'
  if (!SANDBOXES.has(sandbox)) fail('SCHEDULE_DEFINITION_INVALID', 'sandbox is not supported', { field: 'sandbox' })
  validateOpenCodeSettings(agentId(frontMatter.agent), sandbox, capabilities(frontMatter.capabilities))
  const prompt = match[2].trim()
  if (prompt.length === 0 || prompt.length > 20000) {
    fail('SCHEDULE_DEFINITION_INVALID', 'Markdown body Prompt must contain 1 to 20000 characters', { field: 'prompt' })
  }
  const legacy = frontMatter.type !== DEFINITION_TYPE
  const enabled = legacy ? true : frontMatter.enabled ?? true
  const triggers = triggerSettings({ ...frontMatter, schedule_enabled: frontMatter.schedule_enabled ?? (legacy ? frontMatter.enabled ?? true : true) })
  const result = {
    id,
    title: string(frontMatter.title, 'title', 200),
    enabled,
    ...triggers,
    workspace: string(frontMatter.workspace, 'workspace', 4096),
    agent: agentId(frontMatter.agent),
    cadence: frontMatter.schedule == null ? null : cadence(frontMatter.schedule, clock, { allowPastOnce: true }),
    sandbox_mode: sandbox,
    model: modelSelection(frontMatter.model, agentId(frontMatter.agent)),
    reasoning_effort: reasoningSelection(frontMatter.reasoning, agentId(frontMatter.agent)),
    ...(frontMatter.network_access != null ? { network_access: frontMatter.network_access } : {}),
    ...(frontMatter.fast_mode != null ? { fast_mode: frontMatter.fast_mode } : {}),
    ...(frontMatter.session_id != null ? { session_id: string(frontMatter.session_id, 'session_id', 128) } : {}),
    timeout_seconds: timeoutSeconds(frontMatter.timeout),
    capabilities: capabilities(frontMatter.capabilities),
    ...sessionPolicy(frontMatter),
    timezone_mode: 'system',
    prompt,
  }
  if (sourcePath !== null) result.source_path = sourcePath
  result.etag = definitionEtag(source)
  return result
}

export function serializeScheduleDefinition(job, { clock = () => new Date() } = {}) {
  const value = object(job, 'definition')
  const enabled = value.enabled ?? true
  const frontMatter = {
    type: DEFINITION_TYPE,
    id: string(value.id, 'id', 128),
    title: string(value.title, 'title', 200),
    enabled,
    ...triggerSettings(value),
    workspace: string(value.workspace, 'workspace', 4096),
    agent: agentId(value.agent),
    schedule: value.cadence == null ? null : humanCadence(validateCadence(value.cadence, { now: clock(), allowPastOnce: true })),
    capabilities: capabilities(value.capabilities),
    sandbox: value.sandbox_mode ?? 'read-only',
  }
  if (!ID.test(frontMatter.id)) fail('SCHEDULE_DEFINITION_INVALID', 'id must be a UUID', { field: 'id' })
  if (!SANDBOXES.has(frontMatter.sandbox)) fail('SCHEDULE_DEFINITION_INVALID', 'sandbox is not supported', { field: 'sandbox' })
  if (value.model !== undefined && value.model !== null) {
    frontMatter.model = modelSelection(value.model, frontMatter.agent)
  }
  if (value.reasoning_effort !== undefined && value.reasoning_effort !== null) {
    frontMatter.reasoning = reasoningSelection(value.reasoning_effort, frontMatter.agent)
  }
  if (value.network_access != null) {
    if (typeof value.network_access !== 'boolean' || frontMatter.agent !== 'codex') {
      fail('SCHEDULE_DEFINITION_INVALID', 'network_access requires Codex and a boolean value', { field: 'network_access' })
    }
    frontMatter.network_access = value.network_access
  }
  if (value.fast_mode != null) {
    if (typeof value.fast_mode !== 'boolean' || frontMatter.agent !== 'codex') {
      fail('SCHEDULE_DEFINITION_INVALID', 'fast_mode requires Codex and a boolean value', { field: 'fast_mode' })
    }
    frontMatter.fast_mode = value.fast_mode
  }
  validateOpenCodeSettings(frontMatter.agent, frontMatter.sandbox, frontMatter.capabilities)
  const policy = sessionPolicy(value)
  frontMatter.thread_mode = policy.thread_mode
  frontMatter.max_inherit_runs = policy.max_inherit_runs
  frontMatter.timeout = duration(timeoutSeconds(value.timeout_seconds))
  if (value.session_id != null) frontMatter.session_id = string(value.session_id, 'session_id', 128)
  const prompt = string(value.prompt, 'prompt', 20000)
  return `---\n${stringify(frontMatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${prompt}\n`
}

function modelSelection(value, agent) {
  return agent === 'opencode'
    ? optionalSelection(value, 'model', (text) => OPENCODE_MODEL.test(text), 256)
    : optionalSelection(value, 'model', isCodexModelSlug, 128)
}

function reasoningSelection(value, agent) {
  return agent === 'opencode'
    ? optionalSelection(value, 'reasoning', (text) => OPENCODE_VARIANT.test(text), 64)
    : optionalSelection(value, 'reasoning', isCodexReasoningLevel, 16)
}

function validateOpenCodeSettings(agent, sandbox, policy) {
  if (agent !== 'opencode') return
  if (sandbox !== 'danger-full-access') {
    fail('SCHEDULE_DEFINITION_INVALID', 'OpenCode requires danger-full-access; it does not provide an OS sandbox', { field: 'sandbox' })
  }
  if (policy.skills !== 'inherit' || policy.integrations !== 'inherit') {
    fail('SCHEDULE_DEFINITION_INVALID', 'OpenCode currently requires inherited skills and integrations', { field: 'capabilities' })
  }
}

function triggerSettings(value) {
  for (const field of ['schedule_enabled', 'external_enabled']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      fail('SCHEDULE_DEFINITION_INVALID', `${field} must be boolean`, { field })
    }
  }
  const external_secret = value.external_secret ?? null
  if (external_secret !== null && (typeof external_secret !== 'string' || !external_secret.trim() || external_secret.length > 1024)) {
    fail('SCHEDULE_DEFINITION_INVALID', 'external_secret must contain 1–1024 characters', { field: 'external_secret' })
  }
  if (value.external_enabled === true && external_secret === null) {
    fail('SCHEDULE_DEFINITION_INVALID', 'external calling requires a secret', { field: 'external_secret' })
  }
  return { schedule_enabled: value.schedule_enabled ?? true, external_enabled: value.external_enabled ?? false, external_secret }
}
