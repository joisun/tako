import { loopError } from './errors.mjs'
import { conversationWork } from './board/conversation-work.mjs'
const COLUMNS = new Set(['backlog','working','review','done'])
const TYPES = new Set(['task','bug','review','note'])
function text(value, max) { if (typeof value !== 'string' || !value.trim() || value.length>max || value.includes('\0')) throw loopError('LOOP_INPUT_INVALID','工作项内容无效'); return value.trim() }
export function createRoomBoard({db,clock,createId}) {
  function checkRoom(id) { if(!db.prepare('SELECT id FROM loop_rooms WHERE id=?').get(id)) throw loopError('LOOP_NOT_FOUND','团队不存在',404) }
  function snapshot(id) {
    checkRoom(id)
    return { revision:db.prepare('SELECT revision FROM loop_boards WHERE room_id=?').get(id)?.revision??0,
      items:[...conversationWork(db,id),...db.prepare('SELECT id,room_id,number,name,column_id AS "column",owner_id,type,details,position,created_at,updated_at FROM loop_work_items WHERE room_id=? ORDER BY position,id').all(id)] }
  }
  function writable(id){checkRoom(id);const row=db.prepare('SELECT config_json FROM loop_rooms WHERE id=?').get(id);if(JSON.parse(row.config_json??'{}').dissolved_at)throw loopError('LOOP_ROOM_DISSOLVED','团队已解散，看板仅供查看',409)}
  function checkRevision(id,value) {writable(id); if(!Number.isSafeInteger(value)||snapshot(id).revision!==value) throw loopError('LOOP_BOARD_CONFLICT','看板已更新，请刷新后重试',409) }
  function bump(id) { db.prepare('INSERT INTO loop_boards VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET revision=revision+1').run(id); return snapshot(id) }
  function owner(id,value) { if(value!==null && !db.prepare('SELECT id FROM loop_members WHERE id=? AND room_id=?').get(value,id)) throw loopError('LOOP_MEMBER_INVALID','负责人须为当前团队成员');return value }
  function column(value) { if(!COLUMNS.has(value))throw loopError('LOOP_INPUT_INVALID','工作项状态无效');return value }
  function type(value) { if(!TYPES.has(value))throw loopError('LOOP_INPUT_INVALID','工作项类型无效');return value }
  function create(id,input) {
    writable(id)
    const key=text(input.request_key,128), name=text(input.name,200), selected=column(input.column??'backlog'), assigned=owner(id,input.owner_id??null), kind=type(input.type??'task')
    const previous=db.prepare('SELECT * FROM loop_work_items WHERE room_id=? AND request_key=?').get(id,key)
    if(previous) { if(previous.name!==name||previous.column_id!==selected||previous.owner_id!==assigned||previous.type!==kind)throw loopError('LOOP_IDEMPOTENCY_CONFLICT','请求标识已用于其他工作项',409);return snapshot(id) }
    checkRevision(id,input.expected_revision)
    const at=new Date(clock()).toISOString(), number=db.prepare('SELECT coalesce(max(number),0)+1 AS n FROM loop_work_items WHERE room_id=?').get(id).n
    const position=db.prepare('SELECT coalesce(max(position),-1)+1 AS n FROM loop_work_items WHERE room_id=?').get(id).n
    db.prepare('INSERT INTO loop_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(createId(),id,number,name,selected,assigned,kind,'',position,key,at,at)
    return bump(id)
  }
  function reorder(id,input) {
    checkRevision(id,input.expected_revision)
    const current=snapshot(id).items.filter(item=>!item.tracking), items=input.items
    if(!Array.isArray(items)||items.length!==current.length||new Set(items.map(item=>item?.id)).size!==current.length||items.some(item=>!current.some(row=>row.id===item?.id)))throw loopError('LOOP_INPUT_INVALID','看板排序须包含当前团队的全部工作项')
    for(const [index,item] of items.entries()) db.prepare('UPDATE loop_work_items SET column_id=?,position=?,updated_at=? WHERE id=? AND room_id=?').run(column(item.column),index,new Date(clock()).toISOString(),item.id,id)
    return bump(id)
  }
  function update(id,itemId,input) {
    checkRevision(id,input.expected_revision)
    if(itemId.startsWith('assignment-')||itemId.startsWith('task-'))throw loopError('LOOP_WORK_TRACKED','会话工作由实际执行更新，请在对话中调整')
    const item=snapshot(id).items.find(row=>row.id===itemId)
    if(!item)throw loopError('LOOP_NOT_FOUND','工作项不存在',404)
    const details=input.details===undefined?item.details:input.details
    if(typeof details!=='string'||details.length>10000||details.includes('\0'))throw loopError('LOOP_INPUT_INVALID','工作项说明无效')
    db.prepare('UPDATE loop_work_items SET name=?,owner_id=?,type=?,details=?,updated_at=? WHERE id=? AND room_id=?').run(input.name===undefined?item.name:text(input.name,200),input.owner_id===undefined?item.owner_id:owner(id,input.owner_id),input.type===undefined?item.type:type(input.type),details,new Date(clock()).toISOString(),itemId,id)
    return bump(id)
  }
  return {snapshot,create,reorder,update}
}
