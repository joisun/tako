import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, realpath, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { archiveRoomArtifacts, restoreRoomArtifacts } from '../collaboration-artifacts.mjs'
import { loopError } from './errors.mjs'

const FORMAT='undercontrol-room-v1'
const LEGACY_FORMAT='rillo-room-v1'
const roomTables=['loop_rooms','loop_members','loop_tasks','loop_runs','loop_messages','loop_inbox','loop_events','loop_boards','loop_work_items','loop_memories']
const scope = table => ['loop_rooms'].includes(table) ? 'id' : ['loop_runs','loop_inbox','loop_events'].includes(table) ? 'task_id' : 'room_id'
const roomExpression=(table,prefix)=>['loop_runs','loop_inbox','loop_events'].includes(table)?`(SELECT room_id FROM loop_tasks WHERE id=${prefix}.task_id)`:`${prefix}.${scope(table)}`

export function createRoomMemory({db,clock}) {
  const now=()=>new Date(clock()).toISOString(),leases=new Map()
  // The dirty revision is written inside the same transaction as every business fact.
  for(const table of roomTables)for(const action of ['INSERT','UPDATE','DELETE']) {
    const prefix=action==='DELETE'?'OLD':'NEW',room=roomExpression(table,prefix)
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_memory_${action.toLowerCase()} AFTER ${action} ON ${table} WHEN ${room} IS NOT NULL BEGIN
      INSERT INTO loop_memory_sync(room_id,revision) VALUES(${room},1) ON CONFLICT(room_id) DO UPDATE SET revision=revision+1;
    END`)
  }
  db.exec('INSERT OR IGNORE INTO loop_memory_sync(room_id,revision) SELECT id,1 FROM loop_rooms')
  async function directory(value) {
    if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0'))throw loopError('LOOP_MEMORY_DIRECTORY_INVALID','请指定绝对路径的团队记忆目录')
    await mkdir(value,{recursive:true,mode:0o700}).catch(error=>{throw loopError('LOOP_MEMORY_DIRECTORY_INVALID',`记忆目录无法创建或访问（${error.code??'DIRECTORY_UNAVAILABLE'}）`)})
    const canonical=await realpath(value)
    if(!(await stat(canonical)).isDirectory())throw loopError('LOOP_MEMORY_DIRECTORY_INVALID','记忆路径必须是目录')
    return canonical
  }
  async function own(path,roomId) {
    const current=leases.get(path)
    if(current){if(current.roomId!==roomId)throw loopError('LOOP_MEMORY_DIRECTORY_IN_USE','一个记忆目录只能保存一个团队',409);return}
    // An OS-backed SQLite write lock is released on crashes, without PID guesses or expiring leases.
    const legacyLock=join(path,'.rillo-lock.sqlite')
    const lockPath=await stat(legacyLock).then(()=>legacyLock,error=>{if(error.code==='ENOENT')return join(path,'.undercontrol-lock.sqlite');throw error});let lock
    try {
      lock=new DatabaseSync(lockPath)
      chmodSync(lockPath,0o600)
      lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
      leases.set(path,{roomId,lock})
    }catch(error){lock?.close();if([5,6].includes(error.errcode))throw loopError('LOOP_MEMORY_DIRECTORY_IN_USE','记忆目录正由其他服务写入，请使用新的恢复目录',409);throw loopError('LOOP_MEMORY_SYNC_FAILED',`记忆目录无法写入（${error.code??'WRITE_FAILED'}）`,503)}
  }
  async function bind(path,roomId) {
    const canonical=await directory(path)
    const existing=db.prepare("SELECT id FROM loop_rooms WHERE json_extract(config_json,'$.memory_directory')=? AND id!=?").get(canonical,roomId)
    if(existing)throw loopError('LOOP_MEMORY_DIRECTORY_IN_USE','此目录已属于其他团队',409)
    const saved=await readFile(join(canonical,'room.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
    if(saved){let envelope;try{envelope=JSON.parse(saved)}catch{throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','已有团队资料无法读取')};if(envelope.data?.loop_rooms?.[0]?.id!==roomId)throw loopError('LOOP_MEMORY_RESTORE_REQUIRED','该目录已有团队资料，请使用恢复团队',409)}
    await own(canonical,roomId)
    return canonical
  }
  function snapshot(roomId) {
    const rows={}
    for(const table of roomTables) {
      const key=scope(table),where=['loop_runs','loop_inbox','loop_events'].includes(table)?`${key} IN (SELECT id FROM loop_tasks WHERE room_id=?)`:`${key}=?`
      rows[table]=db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(roomId).map(row=>{const value={...row};delete value.token_hash;return value})
    }
    return rows
  }
  async function write(path,data) {
    const temporary=join(path,`.room-${randomUUID()}.tmp`),target=join(path,'room.json')
    const body=JSON.stringify(data),envelope=JSON.stringify({format:FORMAT,exported_at:now(),sha256:createHash('sha256').update(body).digest('hex'),data})
    try {
      const file=await open(temporary,'wx',0o600)
      try{await file.writeFile(envelope);await file.sync()}finally{await file.close()}
      await rename(temporary,target)
      const parent=await open(path,'r');try{await parent.sync()}finally{await parent.close()}
    }finally{await rm(temporary,{force:true})}
  }
  let queue=Promise.resolve()
  function flush(roomId=null) {
    const operation=queue.catch(()=>{}).then(async()=>{
      const pending=db.prepare('SELECT s.*,r.config_json FROM loop_memory_sync s JOIN loop_rooms r ON r.id=s.room_id WHERE s.revision>s.exported_revision AND (? IS NULL OR s.room_id=?)').all(roomId,roomId)
      for(const row of pending) {
        const path=JSON.parse(row.config_json??'{}').memory_directory
        if(!path)continue
        try{await own(path,row.room_id);const data=snapshot(row.room_id);data.artifacts=await archiveRoomArtifacts(data,path);await write(path,data);db.prepare('UPDATE loop_memory_sync SET exported_revision=?,last_error=NULL WHERE room_id=?').run(row.revision,row.room_id)}
        catch(error){db.prepare('UPDATE loop_memory_sync SET last_error=? WHERE room_id=?').run(error.code??'WRITE_FAILED',row.room_id);throw loopError('LOOP_MEMORY_SYNC_FAILED',`团队资料尚未同步到记忆目录（${error.code??'WRITE_FAILED'}）；请检查目录后重试`,503)}
      }
    })
    queue=operation;return operation
  }
  async function restore({source_directory,memory_directory,workspaces,default_root}) {
    if(!Array.isArray(workspaces))throw loopError('LOOP_INPUT_INVALID','恢复的项目记录无效')
    const source=await realpath(source_directory).catch(()=>{throw loopError('LOOP_MEMORY_DIRECTORY_INVALID','原资料目录不存在或无法访问')})
    let archive
    try{const file=await open(join(source,'room.json'),'r');try{if((await file.stat()).size>256*1024*1024)throw new Error('oversize');archive=JSON.parse(await file.readFile('utf8'))}finally{await file.close()}}catch{throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','无法读取团队资料')}
    const data=archive.data
    if(![FORMAT,LEGACY_FORMAT].includes(archive.format)||!data||createHash('sha256').update(JSON.stringify(data)).digest('hex')!==archive.sha256||roomTables.some(table=>!Array.isArray(data[table]))||data.loop_rooms.length!==1)throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料格式或校验值无效')
    if(roomTables.some(table=>data[table].some(row=>!row||typeof row!=='object'||Array.isArray(row))))throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','资料包含无效记录')
    const roomId=data.loop_rooms[0].id
    const target=await directory(memory_directory||default_root&&join(default_root,roomId))
    if(source===target)throw loopError('LOOP_MEMORY_DIRECTORY_INVALID','恢复目录须与来源目录不同，保留原始资料')
    const ids=table=>new Set(data[table].map(row=>row.id)),members=ids('loop_members'),tasks=ids('loop_tasks'),runs=ids('loop_runs'),messages=ids('loop_messages')
    const invalid=()=>{throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','团队资料中的记录归属或引用无效')}
    for(const table of roomTables)for(const row of data[table]) {
      if(!row||typeof row!=='object'||Array.isArray(row))invalid()
      for(const [key,value]of Object.entries(row))if(key.endsWith('_json')&&value!=null){try{JSON.parse(value)}catch{invalid()}}
      if(scope(table)==='room_id'&&row.room_id!==roomId)invalid()
      if(['loop_runs','loop_inbox','loop_events','loop_memories'].includes(table)&&!tasks.has(row.task_id))invalid()
      if(row.member_id&&!members.has(row.member_id)&&!row.member_snapshot_json&&table!=='loop_inbox'||row.owner_id&&!members.has(row.owner_id))invalid()
      if(row.run_id&&!runs.has(row.run_id)||row.source_run_id&&!runs.has(row.source_run_id)||row.consumed_by&&!runs.has(row.consumed_by))invalid()
      if(row.message_id&&!messages.has(row.message_id)||row.task_id&&!tasks.has(row.task_id))invalid()
    }
    if(db.prepare('SELECT id FROM loop_rooms WHERE id=?').get(roomId))throw loopError('LOOP_MEMORY_ROOM_EXISTS','此团队已存在，不覆盖当前资料',409)
    await bind(target,roomId)
    await restoreRoomArtifacts(data.artifacts,source,target).catch(()=>{throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','产物文件缺失、无法读取或校验失败，尚未导入团队')})
    // Keep immutable artifact copies available while the live index is reconstructed.
    await write(target,data)
    db.exec('BEGIN IMMEDIATE')
    try {
      for(const table of roomTables)for(const item of data[table]) {
        const value={...item},columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name)
        if(table==='loop_rooms')value.config_json=JSON.stringify({...JSON.parse(value.config_json),workspace:workspaces[0]??null,workspaces,memory_directory:target})
        if(table==='loop_runs'){value.token_hash=null;value.pid=null;if(['queued','starting','running','stopping'].includes(value.status)){value.status='unknown';value.error_code='LOOP_IMPORTED_UNRECONCILED'}}
        if(table==='loop_tasks'&&!['completed','canceled'].includes(value.status)){value.status='paused';value.config_json=JSON.stringify({...JSON.parse(value.config_json),imported:true})}
        if(table==='loop_messages'||table==='loop_events')delete value.sequence
        if(table==='loop_members'&&value.room_id!==roomId||['loop_tasks','loop_messages','loop_boards','loop_work_items','loop_memories'].includes(table)&&value.room_id!==roomId)throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','资料包含其他团队记录')
        const keys=Object.keys(value).filter(key=>columns.includes(key))
        db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>value[key]))
      }
      // Restored work never enters the outbox; the user must reconcile processes and prepare local worktrees first.
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');if(error.code==='ERR_SQLITE_ERROR')throw loopError('LOOP_MEMORY_ARCHIVE_INVALID','团队记录不完整或与现有索引冲突');throw error}
    await flush(roomId);return roomId
  }
  async function readArtifact(roomId,input) {
    const run=db.prepare('SELECT r.id FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id WHERE r.id=? AND t.room_id=?').get(input.source_run_id??null,roomId)
    if(!run||typeof input.reference!=='string')throw loopError('LOOP_ARTIFACT_INVALID','产物须属于当前团队的执行')
    const room=db.prepare('SELECT config_json FROM loop_rooms WHERE id=?').get(roomId),path=JSON.parse(room.config_json).memory_directory
    if(!path)throw loopError('LOOP_MEMORY_DIRECTORY_INVALID','此团队尚未配置记忆目录')
    await flush(roomId)
    const archive=JSON.parse(await readFile(join(path,'room.json'),'utf8')),item=archive.data.artifacts?.find(value=>value.run_id===run.id&&value.reference===input.reference)
    if(!item||item.status!=='saved')throw loopError('LOOP_ARTIFACT_MISSING','此产物没有可读取的文件快照',404)
    const offset=input.offset??0
    if(!Number.isSafeInteger(offset)||offset<0||offset>item.bytes)throw loopError('LOOP_INPUT_INVALID','产物读取位置无效')
    const file=await open(join(path,'artifacts',item.sha256),'r')
    try{
      const chunk=Buffer.alloc(Math.min(32768,item.bytes-offset)),{bytesRead}=await file.read(chunk,0,chunk.length,offset)
      if(bytesRead!==chunk.length)throw loopError('LOOP_ARTIFACT_CHECKSUM_INVALID','文件快照已改变，无法继续读取',409)
      let length=bytesRead,text
      for(let trim=0;trim<4;trim++){try{text=new TextDecoder('utf-8',{fatal:true}).decode(chunk.subarray(0,length));break}catch{length--}}
      if(text===undefined||text.includes('\0'))return{...item,content_type:'binary',text:null,next_offset:null}
      return{...item,offset,text,next_offset:offset+length<item.bytes?offset+length:null}
    }finally{await file.close()}
  }
  return {bind,flush,snapshot,restore,readArtifact,
    status:roomId=>db.prepare('SELECT revision,exported_revision,last_error FROM loop_memory_sync WHERE room_id=?').get(roomId),
    async close(){try{await flush()}finally{for(const {lock}of leases.values()){lock.exec('ROLLBACK');lock.close()}leases.clear()}},
  }
}
