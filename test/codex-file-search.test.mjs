import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { searchCodexFiles } from '../server/src/runtime/adapters/codex-sessions/file-search.mjs'

test('local message search uses shared metadata and ripgrep without resolving or starting Codex', async t => {
  const root = await mkdtemp('/tmp/tako-file-search-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'sessions'))
  const file = join(root, 'sessions', 'session.jsonl')
  await writeFile(file, '{"type":"event_msg","payload":{"type":"agent_message","message":"needle found"}}\n')
  const path = await realpath(file)
  let scans = 0
  const page = await searchCodexFiles({ query: 'needle', workspace: '', branch: '', archived: false, cursor: null, limit: 10 }, {
    dataRoot: root,
    load: async params => {
      assert.equal(params.useStateDbOnly, true)
      return { data: [{ id: 'session', path }], cursor: null }
    },
    session: row => ({ session_id: row.id, last_active_at: '2026-11-17T00:00:00Z' }),
    resolveExecutable: async executable => { assert.equal(executable, undefined); return '/fixture/rg' },
    spawnImpl(executable, args) {
      assert.equal(executable, '/fixture/rg')
      assert.ok(args.includes(path))
      scans++
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { assert.fail('search should finish') } })
      queueMicrotask(() => {
        child.stdout.end(path + '\0event_msg\tagent_message\t\tneedle found\n')
        child.emit('close', 0)
      })
      return child
    },
  })
  assert.equal(scans, 1)
  assert.equal(page.search_scope, 'messages')
  assert.equal(page.sessions[0].session_id, 'session')
  assert.equal(page.sessions[0].snippet, 'needle found')
})
