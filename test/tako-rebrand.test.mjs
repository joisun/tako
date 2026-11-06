import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseScheduleDefinition, serializeScheduleDefinition } from '../server/src/scheduler/schedule-definition-codec.mjs'
import { renderProjections } from '../mcp/src/renderer.mjs'

const action = {
  id: '4003f4f9-f7ac-4f28-86eb-e263effd2e57', title: 'Compatibility fixture',
  enabled: false, schedule_enabled: true, external_enabled: true, external_secret: 'fixture-only-secret',
  workspace: '/tmp/project', agent: 'codex', cadence: { kind: 'interval', minutes: 30 },
  sandbox_mode: 'read-only', model: null, reasoning_effort: 'low', timeout_seconds: 300,
  prompt: 'Read this run data and preserve the original task instructions.', thread_mode: 'new',
}

for (const name of ['tako', 'undercontrol', 'rillo']) {
  test(`${name}/action preserves disabled state, timer, secret and task body`, () => {
    const canonical = serializeScheduleDefinition(action)
    const input = canonical.replace('type: tako/action', `type: ${name}/action`)
    const before = parseScheduleDefinition(input)
    const after = parseScheduleDefinition(serializeScheduleDefinition(before))
    for (const key of ['id', 'enabled', 'schedule_enabled', 'external_enabled', 'external_secret', 'prompt', 'workspace', 'reasoning_effort']) {
      assert.deepEqual(before[key], action[key], key)
      assert.deepEqual(after[key], before[key], key)
    }
    assert.deepEqual(after.cadence, before.cadence)
  })
  test(`${name}/schedule retains pause semantics and does not enable HTTP`, () => {
    const input = serializeScheduleDefinition({ ...action, external_enabled: false }).replace('type: tako/action', `type: ${name}/schedule`)
      .replace(/^schedule_enabled:.*\n/m, '')
    const parsed = parseScheduleDefinition(input)
    assert.equal(parsed.enabled, true)
    assert.equal(parsed.schedule_enabled, false)
    assert.equal(parsed.external_enabled, false)
  })
  test(`${name} projection markers migrate without losing user content`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'tako-projection-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const file of ['Tasks.md', 'History.md']) {
      await writeFile(join(root, file), `User content before\n<!-- ${name}:start -->\nOld generated content\n<!-- ${name}:end -->\nUser content after\n`)
    }
    await renderProjections({ outputDir: root, loadSnapshot: async () => ({ tasks: [] }) })
    const output = await readFile(join(root, 'Tasks.md'), 'utf8')
    assert.match(output, /^User content before\n<!-- tako:start -->/)
    assert.match(output, /<!-- tako:end -->\nUser content after\n$/)
    assert.doesNotMatch(output, /Old generated content/)
  })
}

const { createHash } = await import('node:crypto')
const { DatabaseSync } = await import('node:sqlite')
const { access, mkdir } = await import('node:fs/promises')
const { parseAgentDefinition } = await import('../server/src/agent-catalog.mjs')
const { createRoomMemory } = await import('../server/src/collaboration/room-memory.mjs')
const { createCollaborationSchema } = await import('../server/src/collaboration/schema.mjs')

for (const name of ['tako', 'undercontrol', 'rillo']) {
  test(`${name} agent provenance retains version and attribution`, () => {
    const origin = { repository: 'example/catalog', revision: 'commit-id', license: 'MIT', url: 'https://example.test/definition.md' }
    const definition = parseAgentDefinition(`---\nname: Analyst\ndescription: A professional role\n${name}_source: ${JSON.stringify(origin)}\n---\nOriginal role instructions.`, { format: 'markdown', source: { kind: 'local' } })
    assert.deepEqual(definition.source.origin, origin)
    assert.equal(definition.source.revision, 'commit-id')
    assert.equal(definition.instructions, 'Original role instructions.')
  })
  test(`${name} room archive restores stable room identity without rewriting the original archive`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'tako-room-'))
    const source = join(root, 'source'), target = join(root, 'restored')
    await mkdir(source)
    const db = new DatabaseSync(':memory:')
    createCollaborationSchema(db)
    const memory = createRoomMemory({ db, clock: () => new Date() })
    t.after(async () => { await memory.close(); db.close(); await rm(root, { recursive: true, force: true }) })
    const data = Object.fromEntries(['loop_rooms', 'loop_members', 'loop_tasks', 'loop_runs', 'loop_messages', 'loop_inbox', 'loop_events', 'loop_boards', 'loop_work_items', 'loop_memories'].map(table => [table, []]))
    data.loop_rooms = [{ id: 'stable-room-id', title: 'Preserved team', created_at: '2026-01-01T00:00:00Z', config_json: '{}' }]
    const archive = JSON.stringify({ format: `${name}-room-v1`, data, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') })
    await writeFile(join(source, 'room.json'), archive)
    await memory.restore({ source_directory: source, memory_directory: target, workspaces: [] })
    assert.equal(db.prepare('SELECT title FROM loop_rooms WHERE id=?').get('stable-room-id').title, 'Preserved team')
    assert.equal(await readFile(join(source, 'room.json'), 'utf8'), archive)
    assert.equal(JSON.parse(await readFile(join(target, 'room.json'), 'utf8')).format, 'tako-room-v1')
  })
}

for (const name of ['undercontrol', 'rillo']) test(`${name} room lock remains authoritative after rename`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tako-room-lock-'))
  const lock = new DatabaseSync(join(root, `.${name}-lock.sqlite`))
  lock.exec('CREATE TABLE writer(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
  const db = new DatabaseSync(':memory:')
  createCollaborationSchema(db)
  const memory = createRoomMemory({ db, clock: () => new Date() })
  t.after(async () => { await memory.close(); db.close(); lock.close(); await rm(root, { recursive: true, force: true }) })
  await assert.rejects(memory.bind(root, 'stable-room-id'), error => error.code === 'LOOP_MEMORY_DIRECTORY_IN_USE')
  await assert.rejects(access(join(root, '.tako-lock.sqlite')))
  lock.exec('ROLLBACK')
  await memory.bind(root, 'stable-room-id')
})
