import { Menu } from '@base-ui/react/menu'
import { AtSign, BookOpen, Crown, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { LoopMember } from '@/lib/api/loop-types'

type MemberListProps = {
  members:LoopMember[]; leaderId?:string; pending:boolean; leaderLocked:boolean
  runtimes:Partial<Record<LoopMember['runtime_id'],'ready'|'unavailable'>>
  activity:Record<string,string>
  onEdit:(member:LoopMember)=>void;onDelete:(member:LoopMember)=>void;onInspect:(member:LoopMember)=>void; onMention:(member:LoopMember)=>void; onLeader:(member:LoopMember)=>void
}
export function RoomMemberList({members,leaderId,pending,leaderLocked,runtimes,activity,onInspect,onMention,onLeader,onEdit,onDelete}:MemberListProps) {
  return <div className="room-members">{members.map(member=>{
    const leader=member.id===leaderId, working=activity[member.id], runtime=runtimes[member.runtime_id]
    const status=working??(runtime==='ready'?'客户端可用':runtime==='unavailable'?'客户端不可用':'正在检测客户端')
    return <div className="room-member-row" key={member.id} data-leader={leader||undefined}>
      <button type="button" className="room-member-profile" aria-label={`查看 ${member.name} 的 Agent 定义`} onClick={()=>onInspect(member)}>
        <span className="room-member-avatar" title={status}><AgentAvatar id={member.id} name={member.name} avatar={member.avatar}/><i aria-hidden="true" data-state={working?'working':runtime??'pending'}/></span>
        <span className="room-member-copy"><span className="room-member-name"><strong title={member.name}>{member.name}</strong>{leader?<span className="room-member-leader">Leader</span>:null}</span><span className="room-member-meta"><small>{member.runtime_id==='claude'?'Claude Code':'Codex'}</small>{working?<small className="room-member-activity">{working}</small>:null}<span className="sr-only">{status}</span></span></span>
      </button>
      <Menu.Root><Menu.Trigger render={<Button size="xs" variant="quiet" isIconOnly className="room-member-actions" aria-label={`${member.name} 的操作`}/>}><MoreHorizontal/></Menu.Trigger>
        <Menu.Portal><Menu.Positioner className="ui-positioner" side="bottom" align="end" sideOffset={5}><Menu.Popup className="room-member-menu room-theme" aria-label={`${member.name} 的操作菜单`}>
          <Menu.Group><Menu.Item onClick={()=>onInspect(member)}><BookOpen/>查看 Agent 定义</Menu.Item><Menu.Item onClick={()=>onMention(member)}><AtSign/>在对话中提及</Menu.Item></Menu.Group>
          <Menu.Separator/><Menu.Group><Menu.Item disabled={pending||!!working} onClick={()=>onEdit(member)}><Pencil/>编辑名字与头像</Menu.Item><Menu.Item title={leaderLocked?'请先结束当前协作再删除':undefined} disabled={pending||!!working||leaderLocked} onClick={()=>onDelete(member)}><Trash2/>删除成员与本地定义</Menu.Item></Menu.Group><Menu.Separator/><Menu.Group><Menu.Item disabled={pending||leader||leaderLocked} title={leaderLocked?'当前协作结束后才能更换 Leader':undefined} onClick={()=>onLeader(member)}><Crown/>{leader?'当前 Leader':'设为 Leader'}</Menu.Item></Menu.Group>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>
    </div>
  })}</div>
}
