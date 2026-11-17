import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { messageError, unavailable } from '../common.mjs'

export function createClaudeMessageProvider({ dataRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), terminal = null } = {}) {
  const root = resolve(dataRoot), storeId = createHash('sha256').update(root).digest('hex').slice(0, 20)
  let closed = false
  function requireQueue(operation) {
    if (closed) throw unavailable('Claude 消息 provider 已关闭')
    if (operation !== 'queue') throw messageError('SESSION_MESSAGE_UNSUPPORTED', 'Claude 仅支持向已有终端会话排队发送消息')
  }
  const transports = terminal ? [{
    id: terminal.id, operations: ['queue'],
    async prepare(context, operation) { requireQueue(operation); await terminal.prepare(context, operation) },
    async execute(operation, context) { requireQueue(operation); return terminal.execute(operation, context) },
  }] : []
  async function metadata(session) {
    if (!/^[0-9a-f-]{36}$/i.test(session.session_id)) throw messageError('SESSION_MESSAGE_REFERENCE_INVALID', 'Claude Session ID 必须为 UUID')
    let directories
    try { directories = await readdir(join(root, 'projects'), { withFileTypes: true }) } catch { throw messageError('SESSION_MESSAGE_REFERENCE_INVALID', 'Claude 会话目录不可用') }
    for (const directory of directories.slice(0, 10000)) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue
      const path = join(root, 'projects', directory.name, session.session_id + '.jsonl')
      let handle
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        handle = await open(path, 'r')
        const buffer = Buffer.alloc(256 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
          let row
          try { row = JSON.parse(line) } catch { continue }
          if (row.sessionId !== session.session_id || !isAbsolute(row.cwd ?? '')) continue
          const workspace = await realpath(row.cwd)
          return { workspace, path }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw messageError('SESSION_MESSAGE_REFERENCE_INVALID', '无法安全读取 Claude 会话元数据') }
      finally { await handle?.close() }
    }
    throw messageError('SESSION_MESSAGE_REFERENCE_INVALID', '在指定 Claude 数据源中找不到会话')
  }
  return {
    id: 'claude', dataRoot: root, storeId,
    transports,
    resolve: metadata,
    async capabilities() { return terminal && !closed ? [{ operation: 'queue', priority: [terminal.id] }] : [] },
    async describe(session) {
      const target = await metadata(session)
      return { workspace: target.workspace, active_turn_id: null, owned_connection: false, operations: await this.capabilities() }
    },
    async reconcile() { return null },
    async close() { closed = true },
  }
}
