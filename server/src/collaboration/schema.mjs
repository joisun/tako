export function createCollaborationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_schema (version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_rooms (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_members (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES loop_rooms(id),
      name TEXT NOT NULL, runtime_id TEXT NOT NULL, instructions TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_tasks (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES loop_rooms(id),
      title TEXT NOT NULL, goal TEXT NOT NULL, acceptance TEXT NOT NULL, workspace TEXT NOT NULL,
      status TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL,
      generation INTEGER NOT NULL, config_json TEXT NOT NULL,
      request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES loop_tasks(id),
      member_id TEXT NOT NULL, phase TEXT NOT NULL,
      stage INTEGER NOT NULL, attempt INTEGER NOT NULL, revision INTEGER NOT NULL,
      generation INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, session_id TEXT,
      token_hash TEXT, submission_json TEXT, action_json TEXT, result_json TEXT,
      error_code TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(task_id, revision, stage, member_id, attempt));
    CREATE TABLE IF NOT EXISTS loop_outbox (
      run_id TEXT PRIMARY KEY REFERENCES loop_runs(id), state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL REFERENCES loop_rooms(id), task_id TEXT REFERENCES loop_tasks(id),
      run_id TEXT REFERENCES loop_runs(id), author TEXT NOT NULL, text TEXT NOT NULL,
      request_key TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES loop_tasks(id),
      run_id TEXT REFERENCES loop_runs(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS loop_runs_task ON loop_runs(task_id,stage);
    CREATE INDEX IF NOT EXISTS loop_messages_room ON loop_messages(room_id,sequence);
    CREATE INDEX IF NOT EXISTS loop_events_task ON loop_events(task_id,sequence);
  `)
  const version = db.prepare('SELECT version FROM loop_schema').get()?.version
  if (version != null && ![1, 2, 3, 4, 5, 6, 7].includes(version)) throw Object.assign(new Error('Unsupported collaboration schema'), { code: 'LOOP_SCHEMA_UNSUPPORTED' })
  // Historical executions retain immutable identities independently of live membership.
  if (version != null && version < 5) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      for (const table of ['loop_runs','loop_inbox']) {
        const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql
        if(!sql)continue
        db.exec(sql.replace(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?[\"\x60]?${table}[\"\x60]?`),`CREATE TABLE ${table}_migration`).replace('member_id TEXT NOT NULL REFERENCES loop_members(id)','member_id TEXT NOT NULL'))
        db.exec(`INSERT INTO ${table}_migration SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_migration RENAME TO ${table}`)
      }
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');throw error}finally{db.exec('PRAGMA foreign_keys=ON')}
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [table, column] of [['loop_rooms','config_json'], ['loop_members','profile_json'], ['loop_members','execution_config_json'], ['loop_runs','routing_json'], ['loop_messages','mentions_json'], ['loop_runs','input_json'], ['loop_runs','member_snapshot_json'], ['loop_messages','author_snapshot_json'], ['loop_messages','attachments_json'], ['loop_runs','parts_json'], ['loop_members','avatar_json']]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS loop_inbox (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES loop_tasks(id), member_id TEXT NOT NULL,
      message_id TEXT REFERENCES loop_messages(id), source_run_id TEXT REFERENCES loop_runs(id), reason TEXT NOT NULL,
      request_key TEXT NOT NULL UNIQUE, consumed_by TEXT REFERENCES loop_runs(id), revision INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS loop_inbox_pending ON loop_inbox(task_id,member_id,consumed_by);`)
    for(const [table,column,definition] of [
      ['loop_messages','intent','TEXT'],['loop_messages','reply_to_message_id','TEXT'],['loop_messages','assignment_id','TEXT'],
      ['loop_inbox','delivery_json',`TEXT NOT NULL DEFAULT '{"state":"pending"}'`],
      ['loop_inbox','processing_json',`TEXT NOT NULL DEFAULT '{"state":"pending"}'`],
    ])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(item=>item.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    db.exec(`CREATE TABLE IF NOT EXISTS loop_boards (room_id TEXT PRIMARY KEY REFERENCES loop_rooms(id), revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS loop_work_items (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES loop_rooms(id), number INTEGER NOT NULL,
        name TEXT NOT NULL, column_id TEXT NOT NULL CHECK(column_id IN ('backlog','working','review','done')),
        owner_id TEXT REFERENCES loop_members(id), type TEXT NOT NULL, details TEXT NOT NULL,
        position INTEGER NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(room_id,number), UNIQUE(room_id,request_key));
      CREATE INDEX IF NOT EXISTS loop_work_items_room ON loop_work_items(room_id,position);`)
    db.exec(`CREATE TABLE IF NOT EXISTS loop_memories (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES loop_rooms(id), task_id TEXT NOT NULL REFERENCES loop_tasks(id),
      run_id TEXT NOT NULL REFERENCES loop_runs(id), kind TEXT NOT NULL CHECK(kind IN ('decision','summary')),
      text TEXT NOT NULL, sources_json TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(run_id,request_key));
      CREATE INDEX IF NOT EXISTS loop_memories_room ON loop_memories(room_id,created_at);
      CREATE TABLE IF NOT EXISTS loop_memory_sync (room_id TEXT PRIMARY KEY REFERENCES loop_rooms(id),revision INTEGER NOT NULL DEFAULT 0,exported_revision INTEGER NOT NULL DEFAULT -1,last_error TEXT);`)
    if(!db.prepare('PRAGMA table_info(loop_memory_sync)').all().some(row=>row.name==='last_error'))db.exec('ALTER TABLE loop_memory_sync ADD COLUMN last_error TEXT')
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS loop_rooms_creation_key ON loop_rooms(json_extract(config_json,'$.creation_request_key')) WHERE json_extract(config_json,'$.creation_request_key') IS NOT NULL")
    for (const room of db.prepare('SELECT id FROM loop_rooms WHERE config_json IS NULL').all()) {
      const previous = db.prepare('SELECT config_json,workspace FROM loop_tasks WHERE room_id=? ORDER BY rowid DESC LIMIT 1').get(room.id)
      const settings = previous ? JSON.parse(previous.config_json) : {}
      const first = db.prepare('SELECT id FROM loop_members WHERE room_id=? ORDER BY rowid LIMIT 1').get(room.id)
      db.prepare('UPDATE loop_rooms SET config_json=? WHERE id=?').run(JSON.stringify({ leader_id: settings.coordinator ?? first?.id ?? null, workspace: settings.source_workspace ?? previous?.workspace ?? null, instructions: '' }), room.id)
    }
    db.exec('CREATE INDEX IF NOT EXISTS loop_runs_session ON loop_runs(session_id); CREATE INDEX IF NOT EXISTS loop_runs_task ON loop_runs(task_id,stage); CREATE INDEX IF NOT EXISTS loop_inbox_pending ON loop_inbox(task_id,member_id,consumed_by)')
    db.exec("CREATE TABLE IF NOT EXISTS loop_definition_deletions (id TEXT PRIMARY KEY,room_id TEXT NOT NULL,member_id TEXT NOT NULL,files_json TEXT NOT NULL,state TEXT NOT NULL)")
    db.exec("UPDATE loop_runs SET member_snapshot_json=(SELECT json_object('id',m.id,'name',m.name,'runtime_id',m.runtime_id,'avatar',json(m.avatar_json)) FROM loop_members m WHERE m.id=loop_runs.member_id) WHERE member_snapshot_json IS NULL")
    db.exec("CREATE TABLE IF NOT EXISTS loop_catalog_deletions (id TEXT PRIMARY KEY,definition_id TEXT NOT NULL,files_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('staging','committed')))")
    if (version == null) db.prepare('INSERT INTO loop_schema VALUES (7)').run()
    else db.prepare('UPDATE loop_schema SET version=7').run()
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
