import { realpath } from 'node:fs/promises'
import { relative, isAbsolute, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

// Claims have no expiry: a lost connection does not prove a writer has stopped.
export function createExecutionResourceCoordinator({ database, isAlive = processExists }) {
  database.exec(`CREATE TABLE IF NOT EXISTS execution_resources (
    owner TEXT NOT NULL, run_id TEXT NOT NULL, workspace TEXT NOT NULL,
    pid INTEGER, state TEXT NOT NULL CHECK(state IN ('held','unknown')),
    PRIMARY KEY(owner, run_id, workspace))`)
  if (database.prepare('PRAGMA table_info(execution_resources)').all().find(row=>row.name==='workspace').pk===0) {
    database.exec(`BEGIN IMMEDIATE; ALTER TABLE execution_resources RENAME TO execution_resources_previous;
      CREATE TABLE execution_resources (owner TEXT NOT NULL,run_id TEXT NOT NULL,workspace TEXT NOT NULL,pid INTEGER,state TEXT NOT NULL CHECK(state IN ('held','unknown')),PRIMARY KEY(owner,run_id,workspace));
      INSERT INTO execution_resources SELECT * FROM execution_resources_previous; DROP TABLE execution_resources_previous; COMMIT;`)
  }

  if (!database.prepare('PRAGMA table_info(execution_resources)').all().some(row=>row.name==='access')) database.exec("ALTER TABLE execution_resources ADD COLUMN access TEXT NOT NULL DEFAULT 'write'")

  function acquire({ owner, runId, workspace, workspaces = [workspace], access = 'write' }) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const claims = database.prepare('SELECT * FROM execution_resources').all()
      const own = claims.find(row => row.owner === owner && row.run_id === runId)
      if (own) throw Object.assign(new Error('Execution already has a resource claim'), { code: 'EXECUTION_ALREADY_CLAIMED' })
      if (claims.some(row => (row.state==='unknown'||access!=='observe'&&row.access!=='observe'&&(access !== 'read' || row.access !== 'read')) && workspaces.some(path=>overlaps(row.workspace, path)))) {
        database.exec('COMMIT')
        return null
      }
      for (const path of [...new Set(workspaces)]) database.prepare("INSERT INTO execution_resources(owner,run_id,workspace,pid,state,access) VALUES (?,?,?,NULL,'held',?)").run(owner, runId, path, access)
      database.exec('COMMIT')
    } catch (error) { try { database.exec('ROLLBACK') } catch {}; throw error }
    return {
      spawned(pid) { database.prepare('UPDATE execution_resources SET pid=? WHERE owner=? AND run_id=?').run(pid, owner, runId) },
      async releaseWhenExited(pid) {
        // Allow the owned runtime's asynchronous shutdown to reap its child.
        for (let attempt = 0; pid && isAlive(pid) && attempt < 25; attempt++) await delay(100)
        if (pid && isAlive(pid)) {
          database.prepare("UPDATE execution_resources SET state='unknown' WHERE owner=? AND run_id=?").run(owner, runId)
          return false
        }
        database.prepare('DELETE FROM execution_resources WHERE owner=? AND run_id=?').run(owner, runId)
        return true
      },
    }
  }

  async function wait({ owner, runId, workspace, workspaces = [workspace], signal, access = 'write', immediate = false }) {
    const canonical = [...new Set(await Promise.all(workspaces.map(path=>realpath(path))))].sort()
    if(immediate)return signal.aborted?null:acquire({owner,runId,workspaces:canonical,access})
    while (!signal.aborted) {
      const claim = acquire({ owner, runId, workspaces: canonical, access })
      if (claim) return claim
      await delay(200, undefined, { signal })
    }
    throw Object.assign(new Error('RUN_CANCELED'), { code: 'RUN_CANCELED' })
  }

  function recover() {
    const unknown = []
    for (const row of database.prepare('SELECT * FROM execution_resources').all()) {
      // A crash between launch and PID persistence is ambiguous; never release it automatically.
      if (!row.pid || isAlive(row.pid)) {
        database.prepare("UPDATE execution_resources SET state='unknown' WHERE owner=? AND run_id=?").run(row.owner, row.run_id)
        unknown.push(row)
      } else database.prepare('DELETE FROM execution_resources WHERE owner=? AND run_id=?').run(row.owner, row.run_id)
    }
    return unknown
  }
  function reconcile(owner, runId) {
    const claims = database.prepare('SELECT * FROM execution_resources WHERE owner=? AND run_id=?').all(owner, runId)
    const claim=claims.find(value=>value.state!=='unknown')??claims.find(value=>value.pid&&isAlive(value.pid))??claims[0]
    if (claim && claim.state !== 'unknown') throw Object.assign(new Error('仍由服务管理的目录占用不能手动释放'), { code: 'LOOP_RESOURCE_ACTIVE', statusCode: 409 })
    if (claim?.pid && isAlive(claim.pid)) throw Object.assign(new Error('原进程仍存在，不能释放目录'), { code: 'LOOP_PROCESS_STILL_RUNNING', statusCode: 409 })
    database.prepare('DELETE FROM execution_resources WHERE owner=? AND run_id=?').run(owner, runId)
  }
  return Object.freeze({ wait, acquire, recover, reconcile,
    list: () => database.prepare('SELECT * FROM execution_resources').all() })
}

function overlaps(a, b) {
  const contains = (root, path) => {
    const child = relative(root, path)
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  }
  return contains(a, b) || contains(b, a)
}
