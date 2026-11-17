import { join } from 'node:path'

import WebSocket from '../../vendor/ws.mjs'

// This connection observes the existing daemon. It never starts or owns that server.
export function createCodexSharedClient({
  dataRoot,
  requestTimeoutMs = 5000,
  maximumLineBytes = 8 * 1024 * 1024,
  allowedMethods = ['initialize', 'thread/loaded/list', 'thread/read'],
  serverRequest,
}) {
  if (typeof dataRoot !== 'string' || !dataRoot
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 0x7fffffff
    || !Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1 || maximumLineBytes > 0x7fffffff
    || !Array.isArray(allowedMethods) || !allowedMethods.every(method => typeof method === 'string' && method)
    || (serverRequest !== undefined && typeof serverRequest !== 'function')) {
    throw new TypeError('Codex shared client options are invalid')
  }
  const methods = new Set(allowedMethods)
  const socket = new WebSocket(`ws+unix:${join(dataRoot, 'app-server-control', 'app-server-control.sock')}:/`, {
    maxPayload: maximumLineBytes,
    perMessageDeflate: false,
  })
  const pending = new Map()
  const listeners = new Set()
  const requestListeners = new Set()
  const serverRequests = new Set()
  const closeListeners = new Set()
  let nextId = 0
  let closed = false
  let closeError = null
  let resolveStarted, rejectStarted
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  started.catch(() => {})
  const startupTimer = setTimeout(() => close(protocolError('RUNTIME_PROTOCOL_TIMEOUT')), requestTimeoutMs)
  startupTimer.unref?.()
  socket.once('open', () => {
    clearTimeout(startupTimer)
    resolveStarted({})
  })

  function close(error = protocolError('RUNTIME_PROTOCOL_CLOSED')) {
    if (closed) return
    closed = true
    closeError = error
    clearTimeout(startupTimer)
    rejectStarted(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    listeners.clear()
    requestListeners.clear()
    serverRequests.clear()
    for (const listener of closeListeners) { try { listener(error) } catch {} }
    closeListeners.clear()
    socket.terminate()
  }
  socket.on('error', error => close(protocolError(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
    ? 'RUNTIME_PROTOCOL_FRAME_TOO_LARGE' : 'RUNTIME_PROTOCOL_CLOSED')))
  socket.on('close', () => close())
  socket.on('message', bytes => {
    if (closed) return
    let message
    try { message = JSON.parse(bytes.toString()) } catch { return }
    if (!message || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (typeof message.id === 'string' || Number.isSafeInteger(message.id)) void handleServerRequest(message)
      } else {
        for (const listener of listeners) { try { listener(message) } catch {} }
      }
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (Object.hasOwn(message, 'error')) request.reject(protocolFailure(message.error))
    else request.resolve(message.result)
  })

  function send(message) {
    if (closed || socket.readyState !== WebSocket.OPEN) throw protocolError('RUNTIME_PROTOCOL_CLOSED')
    socket.send(JSON.stringify(message), error => {
      if (error) close(protocolError('RUNTIME_PROTOCOL_CLOSED'))
    })
  }

  function respond(id, response) {
    if (!serverRequests.has(id) || closed) return false
    send({ ...response, id })
    serverRequests.delete(id)
    return true
  }

  async function handleServerRequest(message) {
    if (serverRequests.has(message.id)) return
    serverRequests.add(message.id)
    try {
      if (requestListeners.size) {
        for (const listener of requestListeners) await listener(message)
        return
      }
      if (!serverRequest) throw Object.assign(new Error('Client does not handle server requests'), { rpcCode: -32601 })
      const result = await serverRequest({ id: message.id, method: message.method, params: message.params ?? {} })
      respond(message.id, { result: result ?? null })
    } catch (error) {
      if (closed) return
      try { respond(message.id, { error: {
        code: Number.isSafeInteger(error?.rpcCode) ? error.rpcCode : -32603,
        message: 'Client rejected server request',
      } }) } catch { close(protocolError('RUNTIME_PROTOCOL_CLOSED')) }
    }
  }

  return {
    started,
    get closed() { return closed },
    request(method, params = {}) {
      if (!methods.has(method)) throw new Error('CODEX_SHARED_SERVER_READ_ONLY')
      if (closed) return Promise.reject(closeError)
      return started.then(() => {
        if (closed) throw closeError
        const id = ++nextId
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return
            reject(protocolError('RUNTIME_PROTOCOL_TIMEOUT'))
          }, requestTimeoutMs)
          timer.unref?.()
          pending.set(id, { resolve, reject, timer })
          try { send({ id, method, params }) } catch (error) {
            pending.delete(id)
            clearTimeout(timer)
            reject(error)
          }
        })
      })
    },
    notify(method, params = {}) {
      if (method !== 'initialized') throw new Error('CODEX_SHARED_SERVER_READ_ONLY')
      send({ method, params })
    },
    onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    onRequest(listener) {
      if (typeof listener !== 'function') throw new TypeError('request listener is required')
      requestListeners.add(listener)
      return () => requestListeners.delete(listener)
    },
    respond,
    onClose(listener) {
      if (typeof listener !== 'function') throw new TypeError('close listener is required')
      if (closed) listener(closeError)
      else closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close,
  }
}

function protocolError(code) {
  return Object.assign(new Error(code), { code })
}

function protocolFailure(error) {
  let code = 'RUNTIME_PROTOCOL_ERROR'
  if (error?.code === -32601 || (error?.code === -32600 && typeof error.message === 'string'
    && /^Invalid request: unknown variant `thread\/(?:items\/list|turns\/list|search|searchOccurrences)`/.test(error.message))) {
    code = 'RUNTIME_PROTOCOL_METHOD_UNAVAILABLE'
  } else if (error?.code === -32600 && typeof error.message === 'string'
    && /^thread \S+ already has an active writer$/.test(error.message)) {
    code = 'RUNTIME_SESSION_IN_USE'
  } else if (JSON.stringify(error)?.includes('activeTurnNotSteerable')) code = 'TURN_NOT_STEERABLE'
  return Object.assign(protocolError(code), { rpcCode: error?.code })
}
