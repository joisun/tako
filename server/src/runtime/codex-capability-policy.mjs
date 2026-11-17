import { isAbsolute } from 'node:path'

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_MCP_SERVERS = 256
const MAX_SKILLS = 2_048

export function createCodexCapabilityPolicyResolver() {
  return Object.freeze({
    async resolveThreadConfig({ client, cwd, capabilities } = {}) {
      if (typeof client?.request !== 'function' || typeof cwd !== 'string' || cwd.length === 0) {
        throw new TypeError('Codex capability configuration options are invalid')
      }
      if (capabilities?.integrations !== 'disabled') return {}
      const response = await client.request('config/read', { cwd, includeLayers: false })
      const servers = response?.config?.mcp_servers
      if (!response?.config || (servers != null && (typeof servers !== 'object' || Array.isArray(servers)))) {
        throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
      }
      const names = Object.keys(servers ?? {})
      if (names.length > MAX_MCP_SERVERS || names.some(name => !MCP_NAME.test(name))) {
        throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
      }
      return {
        'features.plugins': false,
        'features.apps': false,
        'apps._default.enabled': false,
        ...Object.fromEntries(names.map(name => [`mcp_servers.${name}.enabled`, false])),
      }
    },
  })
}

export function skillsThreadConfig(response, { cwd } = {}) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.data)
    || response.data.length > 16 || typeof cwd !== 'string' || cwd.length === 0) {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  const matches = response.data.filter((entry) => entry?.cwd === cwd)
  if (matches.length !== 1) throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  const entry = matches[0]
  if (!Array.isArray(entry.errors) || entry.errors.length > 0
    || !Array.isArray(entry.skills) || entry.skills.length > MAX_SKILLS) {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  const paths = []
  const seen = new Set()
  for (const skill of entry.skills) {
    const path = skill?.path
    if (typeof path !== 'string' || path.length === 0 || path.length > 4_096
      || !isAbsolute(path) || path.includes('\0')) {
      throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
    }
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return {
    skills: { config: paths.map((path) => ({ path, enabled: false })) },
    features: {
      skill_search: false,
      skill_mcp_dependency_install: false,
    },
  }
}

function capabilityError(code) {
  return Object.assign(new Error(code), { code })
}
