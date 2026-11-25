import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { normalizeSessionReference, sessionReferenceKey } from './session-reference.mjs'

export function createSessionPinStore({ databasePath, clock = () => new Date() }) {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(databasePath)
  chmodSync(databasePath, 0o600)
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS session_pins (
        session_key TEXT PRIMARY KEY,
        reference_json TEXT NOT NULL,
        pinned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_key TEXT PRIMARY KEY, status TEXT NOT NULL, note_json TEXT,
        generated_at TEXT, error TEXT
      );
      UPDATE session_summaries SET status='failed', error='服务已重启，请重新生成。' WHERE status='running';
      PRAGMA user_version=1;`)
  } catch (error) { db.close(); throw error }
  const find = db.prepare('SELECT * FROM session_pins WHERE session_key=?')
  const insert = db.prepare('INSERT INTO session_pins VALUES(?,?,?)')
  const remove = db.prepare('DELETE FROM session_pins WHERE session_key=?')
  const pin = row => row ? { ...JSON.parse(row.reference_json), pinned_at: row.pinned_at } : null
  let closed = false
  return {
    list() { return db.prepare('SELECT * FROM session_pins ORDER BY pinned_at DESC,session_key').all().map(pin) },
    set(reference, pinned) {
      const ref = normalizeSessionReference(reference)
      const key = sessionReferenceKey(ref)
      const existing = find.get(key)
      if (!pinned) return { pin: null, changed: Number(remove.run(key).changes) > 0 }
      if (existing) return { pin: pin(existing), changed: false }
      const at = new Date(clock()).toISOString()
      insert.run(key, JSON.stringify(ref), at)
      return { pin: { ...ref, pinned_at: at }, changed: true }
    },
    summary(ref) {
      const row = db.prepare('SELECT * FROM session_summaries WHERE session_key=?').get(sessionReferenceKey(ref))
      return row ? { status: row.status, note: JSON.parse(row.note_json), generated_at: row.generated_at, error: row.error } : null
    },
    saveSummary(ref, note, expectedNote) {
      const key = sessionReferenceKey(ref)
      const content = JSON.stringify(note)
      const result = expectedNote === null
        ? db.prepare(`INSERT INTO session_summaries(session_key,status,note_json) VALUES(?,'ready',?)
            ON CONFLICT(session_key) DO UPDATE SET status='ready',note_json=excluded.note_json,error=NULL
            WHERE status!='running' AND note_json IS NULL`).run(key, content)
        : db.prepare(`UPDATE session_summaries SET status='ready',note_json=?,error=NULL
            WHERE session_key=? AND status!='running' AND note_json=?`).run(content, key, JSON.stringify(expectedNote))
      return result.changes > 0
    },
    startSummary(ref) {
      db.prepare(`INSERT INTO session_summaries(session_key,status) VALUES(?,'running')
        ON CONFLICT(session_key) DO UPDATE SET status='running',error=NULL`).run(sessionReferenceKey(ref))
    },
    finishSummary(ref, note, error) {
      db.prepare(`UPDATE session_summaries SET status=?,error=?,note_json=coalesce(?,note_json),
        generated_at=coalesce(?,generated_at) WHERE session_key=?`)
        .run(note ? 'ready' : 'failed', error, note ? JSON.stringify(note) : null, note ? new Date(clock()).toISOString() : null, sessionReferenceKey(ref))
    },
    check() { return { schemaVersion: 1, integrityCheck: db.prepare('PRAGMA quick_check').get().quick_check, foreignKeyViolations: [], invariantViolations: [] } },
    close() { if (!closed) { closed = true; db.close() } },
  }
}
