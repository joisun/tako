import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readJson, sendJson } from './http-utils.mjs'

function failure(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode })
}

export function createActionTriggerServer({ definitions, runService, host = '127.0.0.1', port = 43128,
  publicUrl = null, maxBodyBytes = 256 * 1024, requestsPerMinute = 120 } = {}) {
  let minute = 0
  let requests = 0
  let address = null
  const server = createServer(async (request, response) => {
    try {
      const currentMinute = Math.floor(Date.now() / 60000)
      if (currentMinute !== minute) { minute = currentMinute; requests = 0 }
      if (++requests > requestsPerMinute) throw failure('TRIGGER_RATE_LIMITED', 429)
      const url = new URL(request.url, 'http://localhost')
      const match = /^\/actions\/([0-9a-f-]{36})\/trigger$/i.exec(url.pathname)
      if (!match || request.method !== 'POST' || url.search) throw failure('NOT_FOUND', 404)
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw failure('CONTENT_TYPE_REQUIRED', 415)
      if (Number(request.headers['content-length']) > maxBodyBytes) throw failure('REQUEST_BODY_TOO_LARGE', 413)
      let action
      try { action = await definitions.get(match[1]) } catch { throw failure('ACTION_UNAVAILABLE', 404) }
      if (!action.enabled || !action.external_enabled) throw failure('ACTION_UNAVAILABLE', 404)
      const input = await readJson(request, { limit: maxBodyBytes })
      try { action = await definitions.get(match[1]) } catch { throw failure('ACTION_UNAVAILABLE', 404) }
      if (!action.enabled || !action.external_enabled) throw failure('ACTION_UNAVAILABLE', 404)
      if (!input || Array.isArray(input) || typeof input !== 'object'
        || Object.keys(input).some(key => key !== 'secret' && key !== 'data')
        || !Object.hasOwn(input, 'data')) throw failure('TRIGGER_INPUT_INVALID', 400)
      if (typeof input.secret !== 'string' || !input.secret.trim() || input.secret.length > 1024
        || typeof action.external_secret !== 'string' || !action.external_secret
        || !timingSafeEqual(digest(input.secret), digest(action.external_secret))) throw failure('TRIGGER_UNAUTHORIZED', 401)
      const { run } = await runService.create({ schedule: action, origin: 'external', data: input.data })
      sendJson(response, 202, { accepted: true, run_id: run.id, status: run.status })
    } catch (error) {
      const status = error.statusCode ?? (error.code === 'RUN_QUEUE_FULL' ? 429 : 503)
      sendJson(response, status, { accepted: false, error: { code: error.statusCode || status === 429 ? error.code : 'TRIGGER_UNAVAILABLE' } })
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.timeout = 15000
  server.maxConnections = 64
  return {
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
      address = server.address()
      const urlHost = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host
      return { ...address, url: publicUrl ?? `http://${urlHost}:${address.port}` }
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() })
    },
  }
}

function digest(value) { return createHash('sha256').update(value).digest() }
