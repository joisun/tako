import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, GripVertical } from 'lucide-react'
import { KanbanProvider, KanbanBoard, KanbanHeader, KanbanCards, KanbanCard } from '@/components/kibo-ui/kanban'
import { Button } from '@/components/ui/button'
import { Input, TextArea } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { LoopMember, RoomBoard, RoomWorkItem, WorkItemColumn } from '@/lib/api/loop-types'

const COLUMNS = [{id:'backlog',name:'待处理'},{id:'working',name:'进行中'},{id:'review',name:'待验收'},{id:'done',name:'已完成'}]
const TYPES:Record<RoomWorkItem['type'],string> = {task:'任务',bug:'缺陷',review:'审阅',note:'记录'}
function ItemDetails({item,members,pending,error,onClose,onSave,onContinue}:{item:RoomWorkItem;members:LoopMember[];pending:boolean;error:string;onClose:()=>void;onSave:(input:{name:string;owner_id:string|null;type:RoomWorkItem['type'];details:string})=>Promise<void>;onContinue:()=>void}) {
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const values=new FormData(event.currentTarget);await onSave({name:String(values.get('name')),owner_id:String(values.get('owner'))||null,type:String(values.get('type')) as RoomWorkItem['type'],details:String(values.get('details'))})}
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><form onSubmit={submit}><DialogHeader><DialogTitle>工作项 R-{item.number}</DialogTitle><DialogDescription>{COLUMNS.find(column=>column.id===item.column)?.name}</DialogDescription></DialogHeader><DialogBody className="room-form">
    <label className="room-field"><span>名称</span><Input name="name" required maxLength={200} defaultValue={item.name}/></label><label className="room-field"><span>负责人</span><select name="owner" className="room-select" defaultValue={item.owner_id??''}><option value="">未分配</option>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label className="room-field"><span>类型</span><select name="type" className="room-select" defaultValue={item.type}>{Object.entries(TYPES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="room-field"><span>说明</span><TextArea name="details" rows={4} maxLength={10000} defaultValue={item.details}/></label>{error?<p role="alert" className="room-error">{error}</p>:null}
    </DialogBody><DialogFooter><Button disabled={pending} onClick={onContinue}>在对话中继续</Button><Button variant="primary" type="submit" isPending={pending}>保存</Button></DialogFooter></form></DialogContent></Dialog>
}
export function RoomBoardView({api,roomId,members,onContinue,readOnly=false}:{api:DashboardApi;roomId:string;readOnly?:boolean;members:LoopMember[];onContinue:(item:RoomWorkItem)=>void}) {
  const client=useQueryClient(),queryKey=['rooms','board',roomId],query=useQuery({queryKey,queryFn:()=>api.roomBoard(roomId)})
  const [draft,setDraft]=useState<RoomWorkItem[]>([]),[search,setSearch]=useState(''),[owner,setOwner]=useState(''),[adding,setAdding]=useState<string|null>(null),[name,setName]=useState('')
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[detailId,setDetailId]=useState<string|null>(null)
  const committed=useRef<RoomBoard>({revision:0,items:[]}),draftRef=useRef<RoomWorkItem[]>([]),dragging=useRef(false),addKey=useRef(crypto.randomUUID()),busy=useRef(false)
  function show(items:RoomWorkItem[]){draftRef.current=items;setDraft(items)}
  useEffect(()=>{if(query.data&&!dragging.current&&!busy.current&&query.data.board.revision>=committed.current.revision){committed.current=query.data.board;show(query.data.board.items)}},[query.data,saving])
  async function mutate(operation:()=>Promise<{board:RoomBoard}>):Promise<boolean>{
    if(busy.current)return false
    busy.current=true;setSaving(true);setError('')
    try {const result=await operation();committed.current=result.board;show(result.board.items);client.setQueryData(queryKey,result);return true}
    catch(cause){show(committed.current.items);setError(cause instanceof Error?cause.message:'保存失败');await query.refetch();return false}
    finally{busy.current=false;setSaving(false)}
  }
  const visible=draft.filter(item=>(!owner||item.owner_id===owner)&&(item.name+' R-'+item.number+' '+item.details).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  function changed(items:RoomWorkItem[]){const ids=new Set(visible.map(item=>item.id)),next=[...items];show(draftRef.current.map(item=>ids.has(item.id)?{...next.shift()!}:item))}
  function saveOrder(){dragging.current=false;const items=draftRef.current.map(item=>({id:item.id,column:item.column}));void mutate(()=>api.saveRoomBoard(roomId,{items,expected_revision:committed.current.revision}))}
  async function add(event:FormEvent){event.preventDefault();if(!name.trim()||!adding)return;const ok=await mutate(()=>api.createRoomWorkItem(roomId,{name:name.trim(),column:adding,request_key:addKey.current,expected_revision:committed.current.revision}));if(ok){setAdding(null);setName('');addKey.current=crypto.randomUUID()}}
  async function move(id:string,column:string){show(draftRef.current.map(item=>item.id===id?{...item,column:column as WorkItemColumn}:item));saveOrder()}
  const selected=draft.find(item=>item.id===detailId)
  return <section className="room-board" aria-label="团队看板"><header className="room-board-toolbar"><div><h2>协作工作项</h2><small>{draft.length} 个工作项</small></div><div className="room-board-filters"><label><Search/><Input aria-label="搜索工作项" placeholder="搜索工作项…" value={search} onChange={event=>setSearch(event.target.value)}/></label><select className="room-select" aria-label="筛选负责人" value={owner} onChange={event=>setOwner(event.target.value)}><option value="">全部负责人</option>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></div></header>
    {readOnly?<p className="room-field-note">团队已解散，看板仅供查看。</p>:null}{query.error||error?<p role="alert" className="room-error">{error||query.error?.message}<Button size="xs" variant="quiet" onClick={()=>{void query.refetch()}}>重试</Button></p>:null}{query.isPending?<p role="status">正在读取看板…</p>:null}
    <div aria-busy={saving} inert={saving||readOnly} className={saving?'room-board-grid is-saving':'room-board-grid'}>
    <KanbanProvider overlayClassName="room-theme room-kanban-overlay" columns={COLUMNS} data={visible} onDataChange={changed} onDragStart={()=>{dragging.current=true;setError('')}} onDragEnd={event=>{if(event.over)saveOrder();else{dragging.current=false;show(committed.current.items)}}} onDragCancel={()=>{dragging.current=false;show(committed.current.items)}}>
      {column=><KanbanBoard key={column.id} id={column.id} className="room-kanban-column"><KanbanHeader className="room-kanban-header"><span className="room-column-dot" data-column={column.id}/><h3>{column.name}</h3><small>{visible.filter(item=>item.column===column.id).length}</small><Button size="xs" variant="quiet" isIconOnly aria-label={`在${column.name}添加工作项`} disabled={saving||!!query.error||query.isPending} onClick={()=>{setAdding(column.id);setName('');addKey.current=crypto.randomUUID()}}><Plus/></Button></KanbanHeader>
        <KanbanCards<RoomWorkItem> id={column.id} className="room-kanban-cards">{item=><KanbanCard key={item.id} {...item} className="room-kanban-card"><div className="room-kanban-meta"><span>R-{item.number}</span><span>{TYPES[item.type]}</span><GripVertical/></div><button type="button" className="room-kanban-title" onClick={()=>{setDetailId(item.id);setError('')}}>{item.name}</button><footer><span>{members.find(member=>member.id===item.owner_id)?.name??'未分配'}</span><select aria-label={`R-${item.number} 状态`} value={item.column} disabled={saving} onChange={event=>{void move(item.id,event.target.value)}} onKeyDown={event=>event.stopPropagation()}>{COLUMNS.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></footer></KanbanCard>}</KanbanCards>
        {adding===column.id?<form className="room-kanban-add-form" onSubmit={event=>{void add(event)}}><Input autoFocus aria-label="新工作项名称" placeholder="工作项名称" value={name} onChange={event=>{setName(event.target.value);addKey.current=crypto.randomUUID()}} maxLength={200}/><div><Button size="xs" type="submit" isPending={saving} disabled={!name.trim()}>添加</Button><Button size="xs" disabled={saving} variant="quiet" onClick={()=>setAdding(null)}>取消</Button></div></form>:<Button size="sm" className="room-kanban-add" variant="quiet" disabled={saving||query.isPending||!!query.error} onClick={()=>{setAdding(column.id);setName('');addKey.current=crypto.randomUUID()}}><Plus/>添加工作项</Button>}
      </KanbanBoard>}
    </KanbanProvider></div>
    {selected?<ItemDetails key={selected.id} item={selected} members={members} pending={saving} error={error} onClose={()=>setDetailId(null)} onContinue={()=>{onContinue(selected);setDetailId(null)}} onSave={async input=>{if(await mutate(()=>api.updateRoomWorkItem(roomId,selected.id,{...input,expected_revision:committed.current.revision})))setDetailId(null)}}/>:null}
  </section>
}
