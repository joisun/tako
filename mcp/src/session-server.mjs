import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { UnderControlError } from './errors.mjs'
import { createSessionClient } from './session-client.mjs'
import { createUnderControlServer } from './tools.mjs'

async function resolveBaseUrl(env) {
  if (env.UNDERCONTROL_SERVER_URL) return env.UNDERCONTROL_SERVER_URL
  const path = join(homedir(), '.config', 'undercontrol', 'config.json')
  let config
  try { config = JSON.parse(await readFile(path, 'utf8')) } catch {
    throw new UnderControlError('CONFIG_INVALID', `Unable to read UnderControl config at ${path}. Install the service first.`)
  }
  const host = config.server_host ?? '127.0.0.1'
  const port = config.server_port ?? 43127
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnderControlError('CONFIG_INVALID', 'UnderControl service must use a valid 127.0.0.1 port.')
  }
  return `http://${host}:${port}`
}

export async function startSessionMcp({ env = process.env } = {}) {
  const service = createSessionClient({ baseUrl: await resolveBaseUrl(env) })
  const server = createUnderControlServer({ service })
  await server.connect(new StdioServerTransport())
  return server
}
