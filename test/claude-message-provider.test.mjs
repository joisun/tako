import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSessionMessageStore } from '../server/src/session-message-store.mjs'
import { createSessionMessaging } from '../server/src/runtime/session-messaging.mjs'
import { createClaudeMessageProvider } from '../server/src/runtime/session-messaging/providers/claude.mjs'
import { createTerminalMessageTransport } from '../server/src/runtime/session-messaging/terminal.mjs'

async function fixture(t, { withTerminal = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-external-connection-'))
  const workspacePath = join(directory, 'workspace')
  await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  const dataRoot = join(directory, 'claude-data')
  const project = join(dataRoot, 'projects', 'fixture-project')
  await mkdir(project, { recursive: true })
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const transcriptPath = join(project, sessionId + '.jsonl')
  const transcript = JSON.stringify({ sessionId, cwd: workspace, type: 'user', message: { role: 'user', content: 'Existing history' } }) + '\n'
  await writeFile(transcriptPath, transcript)
  const forbidden = Object.fromEntries(['sdkDriver', 'cliDriver', 'command', 'resolveLaunch'].map(name => [
    name, t.mock.fn(() => assert.fail(`Claude ${name} must not be called`)),
  ]))
  const terminalCommand = t.mock.fn(async (executable, args) => {
    assert.equal(executable, 'otty')
    if (args[1] === 'list') return { stdout: JSON.stringify({ data: [{
      id: 'existing-pane', agent: 'Claude Code', agent_session_id: sessionId, cwd: workspace, agent_state: 'idle',
    }] }) }
    assert.equal(args[1], 'send-text')
    return { stdout: '{}' }
  })
  const terminalClose = t.mock.fn(() => assert.fail('The external terminal must not be closed'))
  const terminal = withTerminal ? {
    ...createTerminalMessageTransport({ command: terminalCommand, enabled: async () => true }),
    // The provider must restrict even a more capable transport to queue.
    operations: ['queue', 'steer', 'stop', 'compact'], close: terminalClose,
  } : null
  const provider = createClaudeMessageProvider({ dataRoot, terminal, ...forbidden })
  const session = { provider: 'claude', store_id: provider.storeId, session_id: sessionId }
  const store = createSessionMessageStore({ databasePath: join(directory, 'receipts.sqlite') })
  const messaging = createSessionMessaging({ providers: [provider], store })
  t.after(async () => {
    try { await messaging.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  return { provider, session, messaging, forbidden, terminalCommand, terminalClose, workspace, transcriptPath, transcript }
}

function assertNoClaudeCalls(forbidden) {
  for (const [name, callback] of Object.entries(forbidden)) {
    assert.equal(callback.mock.callCount(), 0, `${name} was called`)
  }
}

async function assertUnsupported(messaging, session, operations) {
  for (const operation of operations) {
    const { delivery } = await messaging.send({
      request_id: `unsupported-${operation}`, session, operation,
      text: 'Do not start a worker', expected_turn_id: 'external-turn',
    })
    assert.equal(delivery.status, 'rejected')
    assert.equal(delivery.error.code, 'SESSION_MESSAGE_UNSUPPORTED')
  }
}

test('Claude without a terminal reads metadata but exposes no automatic control channel', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.provider.transports, [])
  assert.deepEqual(await f.provider.capabilities(), [])
  assert.deepEqual((await f.messaging.sources()).providers[0].capabilities, [])
  assert.deepEqual(await f.provider.resolve(f.session), { workspace: f.workspace, path: f.transcriptPath })
  assert.deepEqual(await f.messaging.capabilities(f.session), {
    session: f.session, workspace: f.workspace, active_turn_id: null, owned_connection: false, operations: [],
  })
  await assertUnsupported(f.messaging, f.session, ['queue', 'steer', 'stop', 'interrupt', 'compact'])
  assert.equal(await f.provider.reconcile({ session: f.session, operation: 'compact' }), null)
  assert.equal(await readFile(f.transcriptPath, 'utf8'), f.transcript)
  assert.equal(f.terminalCommand.mock.callCount(), 0)
  assertNoClaudeCalls(f.forbidden)
})

test('Claude retains queue delivery to an existing terminal and preserves its receipt', async t => {
  const f = await fixture(t, { withTerminal: true })
  assert.deepEqual(f.provider.transports.map(({ id, operations }) => ({ id, operations })), [
    { id: 'terminal', operations: ['queue'] },
  ])
  assert.deepEqual((await f.messaging.capabilities(f.session)).operations, [
    { operation: 'queue', priority: ['terminal'] },
  ])
  const input = { request_id: 'terminal-queue', session: f.session, text: 'Continue in the existing terminal' }
  const result = await f.messaging.send(input)
  assert.equal(result.delivery.status, 'accepted')
  assert.equal(result.delivery.transport, 'terminal')
  assert.equal(result.delivery.kind, 'terminal_queued')
  assert.equal(result.delivery.pane_id, 'existing-pane')
  assert.equal(result.delivery.native_message_id, null)
  assert.equal((await f.messaging.send(input)).reused, true)
  assert.equal(f.terminalCommand.mock.callCount(), 2)
  const [, args] = f.terminalCommand.mock.calls[1].arguments
  assert.deepEqual(args, ['pane', 'send-text', '--pane', 'existing-pane', '--no-escape', '--submit=queue', '--wait-secs', '2', '--', input.text])
  await assertUnsupported(f.messaging, f.session, ['steer', 'stop', 'interrupt', 'compact'])
  assert.equal(f.terminalCommand.mock.callCount(), 2)
  await f.provider.close()
  assert.deepEqual(await f.provider.capabilities(), [])
  assert.deepEqual((await f.messaging.delivery({ request_id: input.request_id })).delivery, result.delivery)
  assert.equal(f.terminalClose.mock.callCount(), 0)
  assert.equal(await readFile(f.transcriptPath, 'utf8'), f.transcript)
  assertNoClaudeCalls(f.forbidden)
})

test('Claude terminal transport rejects direct non-queue controls and use after close', async t => {
  const f = await fixture(t, { withTerminal: true })
  const [transport] = f.provider.transports
  for (const operation of ['steer', 'stop', 'compact']) {
    await assert.rejects(transport.prepare({}, operation), { code: 'SESSION_MESSAGE_UNSUPPORTED' })
    await assert.rejects(transport.execute(operation, {}), { code: 'SESSION_MESSAGE_UNSUPPORTED' })
  }
  await f.provider.close()
  await assert.rejects(transport.prepare({}, 'queue'), { code: 'SESSION_MESSAGE_UNAVAILABLE' })
  await assert.rejects(transport.execute('queue', {}), { code: 'SESSION_MESSAGE_UNAVAILABLE' })
  assert.equal(f.terminalCommand.mock.callCount(), 0)
  assert.equal(f.terminalClose.mock.callCount(), 0)
  assertNoClaudeCalls(f.forbidden)
})
