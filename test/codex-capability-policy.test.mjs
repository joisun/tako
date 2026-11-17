import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexCapabilityPolicyResolver,
  skillsThreadConfig,
} from '../server/src/runtime/codex-capability-policy.mjs'

test('integration isolation reads workspace MCP configuration through the shared client', async () => {
  const calls = []
  const client = {
    async request(method, params) {
      calls.push({ method, params })
      return { config: { mcp_servers: {
        'plain-server': { command: '/fake/plain', enabled: true },
        'paused-server': { command: '/fake/paused', enabled: false },
      } } }
    },
  }
  const resolver = createCodexCapabilityPolicyResolver()

  const result = await resolver.resolveThreadConfig({
    client,
    cwd: '/tmp/project',
    capabilities: { skills: 'inherit', integrations: 'disabled' },
  })

  assert.deepEqual(calls, [{
    method: 'config/read',
    params: { cwd: '/tmp/project', includeLayers: false },
  }])
  assert.deepEqual(result, {
    'features.plugins': false,
    'features.apps': false,
    'apps._default.enabled': false,
    'mcp_servers.plain-server.enabled': false,
    'mcp_servers.paused-server.enabled': false,
  })
})

test('inherited integrations perform no discovery or thread override', async () => {
  let calls = 0
  const resolver = createCodexCapabilityPolicyResolver()
  assert.deepEqual(await resolver.resolveThreadConfig({
    client: { request() { calls += 1; throw new Error('unexpected discovery') } },
    cwd: '/tmp/project',
    capabilities: { skills: 'disabled', integrations: 'inherit' },
  }), {})
  assert.equal(calls, 0)
})

test('integration isolation disables plugins and apps even without configured MCP servers', async () => {
  for (const config of [{}, { mcp_servers: {} }]) {
    const resolver = createCodexCapabilityPolicyResolver()
    assert.deepEqual(await resolver.resolveThreadConfig({
      client: { async request() { return { config } } },
      cwd: '/tmp/project', capabilities: { integrations: 'disabled' },
    }), {
      'features.plugins': false,
      'features.apps': false,
      'apps._default.enabled': false,
    })
  }
})

test('integration discovery rejects malformed configuration, unsafe names, and excessive server counts', async () => {
  const cases = [
    undefined,
    { config: null },
    { config: { mcp_servers: [] } },
    { config: { mcp_servers: 'invalid' } },
    { config: { mcp_servers: { 'line\nbreak': {} } } },
    { config: { mcp_servers: { 'ambiguous.name': {} } } },
    { config: { mcp_servers: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`server-${i}`, {}])) } },
  ]
  for (const response of cases) {
    const resolver = createCodexCapabilityPolicyResolver()
    await assert.rejects(resolver.resolveThreadConfig({
      client: { async request() { return response } },
      cwd: '/tmp/project',
      capabilities: { skills: 'inherit', integrations: 'disabled' },
    }), { code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID' })
  }
})

test('integration discovery propagates shared connection failure instead of using partial isolation', async () => {
  const failure = Object.assign(new Error('shared connection timed out'), { code: 'RUNTIME_PROTOCOL_TIMEOUT' })
  const resolver = createCodexCapabilityPolicyResolver()
  await assert.rejects(resolver.resolveThreadConfig({
    client: { async request() { throw failure } },
    cwd: '/tmp/project', capabilities: { integrations: 'disabled' },
  }), error => error === failure)
})

test('skill isolation converts only the requested workspace discovery into thread config', () => {
  assert.deepEqual(skillsThreadConfig({
    data: [{
      cwd: '/tmp/project',
      errors: [],
      skills: [
        { name: 'beta', path: '/skills/beta/SKILL.md', enabled: true, description: 'beta', scope: 'user' },
        { name: 'alpha', path: '/skills/alpha/SKILL.md', enabled: true, description: 'alpha', scope: 'repo' },
        { name: 'beta-copy', path: '/skills/beta/SKILL.md', enabled: true, description: 'beta', scope: 'user' },
      ],
    }],
  }, { cwd: '/tmp/project' }), {
    skills: {
      config: [
        { path: '/skills/beta/SKILL.md', enabled: false },
        { path: '/skills/alpha/SKILL.md', enabled: false },
      ],
    },
    features: {
      skill_search: false,
      skill_mcp_dependency_install: false,
    },
  })
})

test('skill isolation rejects incomplete discovery instead of creating a partially isolated Thread', () => {
  assert.throws(() => skillsThreadConfig({ data: [{
    cwd: '/tmp/project',
    errors: [{ path: '/broken/SKILL.md', message: 'bad metadata' }],
    skills: [],
  }] }, { cwd: '/tmp/project' }), { code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID' })
  assert.throws(() => skillsThreadConfig({ data: [] }, { cwd: '/tmp/project' }), {
    code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID',
  })
})
