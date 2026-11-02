import { Menu } from '@base-ui/react/menu'
import { Copy,Hash,MoreHorizontal,Square,Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogBody,DialogFooter } from '@/components/ui/dialog'
import type { LoopRoom } from '@/lib/api/loop-types'
import type { DashboardApi } from '@/lib/api/dashboard-api'
export function TeamSidebarItem({team,selected,onSelect,onAction}:{team:LoopRoom;selected:boolean;onSelect:()=>void;onAction:(action:'copy'|'dissolve'|'delete')=>void}){
  return <div className="team-nav-row" data-selected={selected||undefined}><button type="button" className="room-nav" onClick={onSelect}><Hash/><span>{team.title}{team.config?.dissolved_at?' · 已解散':''}</span></button><Menu.Root><Menu.Trigger render={<Button variant="quiet" size="xs" isIconOnly aria-label={`${team.title} 的团队操作`}/>}><MoreHorizontal/></Menu.Trigger><Menu.Portal><Menu.Positioner className="ui-positioner" side="bottom" align="end" sideOffset={5}><Menu.Popup className="room-member-menu room-theme"><Menu.Group><Menu.Item onClick={()=>onAction('copy')}><Copy/>复制房间</Menu.Item><Menu.Item disabled={!!team.config?.dissolved_at} onClick={()=>onAction('dissolve')}><Square/>解散团队</Menu.Item><Menu.Item onClick={()=>onAction('delete')}><Trash2/>删除团队</Menu.Item></Menu.Group></Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root></div>
}
export function TeamLifecycleDialog({api,team,action,onClose,onSaved}:{api:DashboardApi;team:LoopRoom;action:'dissolve'|'delete';onClose:()=>void;onSaved:()=>void}){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),label=action==='delete'?'删除团队':'解散团队'
  async function confirm(){setPending(true);setError('');try{if(action==='delete')await api.deleteRoom(team.id);else await api.dissolveRoom(team.id);onSaved();onClose()}catch(cause){setError(cause instanceof Error?cause.message:'操作失败');setPending(false)}}
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)onClose()}}><DialogContent className="room-dialog room-theme" showCloseButton={!pending}><DialogHeader><DialogTitle>{label}「{team.title}」？</DialogTitle><DialogDescription>{action==='delete'?'停止协作并从 Teams 列表移除；原生会话、历史资料和备份保留。':'停止此团队的协作，保留团队与历史资料供查看。'}</DialogDescription></DialogHeader>{error?<DialogBody><p className="room-error" role="alert">{error}</p></DialogBody>:null}<DialogFooter><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" className="room-delete-button" isPending={pending} onClick={()=>{void confirm()}}>{label}</Button></DialogFooter></DialogContent></Dialog>
}
