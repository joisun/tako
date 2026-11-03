import {marketError} from './definition.mjs'
export function createMarketplaceStore(db){
  db.exec(`CREATE TABLE IF NOT EXISTS marketplace_schema(version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS marketplace_sources(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,cache_json TEXT,last_checked_at TEXT,last_error TEXT);
    CREATE TABLE IF NOT EXISTS marketplace_installed(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS marketplace_operations(id TEXT PRIMARY KEY,action TEXT NOT NULL,before_digest TEXT,after_json TEXT,error TEXT);`)
  const version=db.prepare('SELECT version FROM marketplace_schema').get()?.version
  if(version!=null&&version!==1)throw marketError('Marketplace 数据版本不支持',503)
  if(version==null)db.prepare('INSERT INTO marketplace_schema VALUES(1)').run()
  if(version==null)for(const source of [{id:'agency-agents',name:'Agency Agents',type:'github',repository:'msitarzewski/agency-agents',ref:'main',enabled:true},{id:'ecc',name:'ECC · Everything Claude Code',type:'github',repository:'affaan-m/ECC',ref:'main',enabled:true,directories:['agents']}])db.prepare('INSERT OR IGNORE INTO marketplace_sources(id,data_json) VALUES(?,?)').run(source.id,JSON.stringify(source))
  return {
    sources:()=>db.prepare('SELECT * FROM marketplace_sources ORDER BY rowid').all().map(row=>({...JSON.parse(row.data_json),last_checked_at:row.last_checked_at,last_error:row.last_error})),
    source(id){const row=db.prepare('SELECT * FROM marketplace_sources WHERE id=?').get(id);if(!row)throw marketError('目录来源不存在',404);return {...JSON.parse(row.data_json),last_checked_at:row.last_checked_at,last_error:row.last_error}},
    saveSource(source){db.prepare('INSERT INTO marketplace_sources(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(source.id,JSON.stringify(source));return source},
    clearCache:id=>db.prepare('UPDATE marketplace_sources SET cache_json=NULL,last_checked_at=NULL,last_error=NULL WHERE id=?').run(id),
    removeSource:id=>db.prepare('DELETE FROM marketplace_sources WHERE id=?').run(id),
    cache:id=>{const value=db.prepare('SELECT cache_json FROM marketplace_sources WHERE id=?').get(id)?.cache_json;return value?JSON.parse(value):null},
    saveCache(id,value,at){db.prepare('UPDATE marketplace_sources SET cache_json=?,last_checked_at=?,last_error=NULL WHERE id=?').run(JSON.stringify(value),at,id)},
    error:(id,message)=>db.prepare('UPDATE marketplace_sources SET last_error=? WHERE id=?').run(message,id),
    installed:()=>db.prepare('SELECT data_json FROM marketplace_installed ORDER BY rowid DESC').all().map(row=>JSON.parse(row.data_json)),
    get:id=>{const row=db.prepare('SELECT data_json FROM marketplace_installed WHERE id=?').get(id);if(!row)throw marketError('已安装定义不存在',404);return JSON.parse(row.data_json)},
    prepare(id,action,before,after){db.prepare('INSERT INTO marketplace_operations VALUES(?,?,?,?,NULL)').run(id,action,before,after?JSON.stringify(after):null)},
    operations:()=>db.prepare('SELECT * FROM marketplace_operations').all(),
    operationError:(id,error)=>db.prepare('UPDATE marketplace_operations SET error=? WHERE id=?').run(error,id),
    commit(id,record){db.exec('BEGIN IMMEDIATE');try{if(record)db.prepare('INSERT INTO marketplace_installed VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(id,JSON.stringify(record));else db.prepare('DELETE FROM marketplace_installed WHERE id=?').run(id);db.prepare('DELETE FROM marketplace_operations WHERE id=?').run(id);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}},
  }
}
