const parse=value=>value?JSON.parse(value):null
// Native IDs remain authoritative. Team metadata is joined in one bounded query per page.
export function createTeamSessionProjection({db}){
  return function project(sessions){
    const ids=[...new Set(sessions.flatMap(session=>[session.session_id,session.native_parent?.session_id].filter(Boolean)))]
    if(!ids.length)return sessions
    const rows=db.prepare(`SELECT r.*,t.title AS task_title,t.goal,t.workspace,t.room_id,team.title AS team_name,team.config_json AS team_config,
      m.name AS member_name,m.runtime_id,m.avatar_json FROM loop_runs r JOIN loop_tasks t ON t.id=r.task_id
      JOIN loop_rooms team ON team.id=t.room_id LEFT JOIN loop_members m ON m.id=r.member_id
      WHERE r.session_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC`).all(JSON.stringify(ids))
    function association(session){
      return rows.find(row=>{
        const snapshot=parse(row.member_snapshot_json),provider=row.runtime_id??snapshot?.runtime_id
        if(row.session_id!==session.session_id||provider!==session.provider)return false
        const reference=parse(row.input_json)?.native_session
        return reference?reference.store_id===session.store_id&&reference.provider===session.provider:session.workspace===row.workspace
      })
    }
    return sessions.map(session=>{
      const direct=association(session),row=direct??(session.native_parent?association({...session.native_parent,workspace:session.workspace}):null)
      if(!row)return session
      const snapshot=parse(row.member_snapshot_json),configuration=parse(row.team_config)
      const name=row.member_name??snapshot?.name??'已移除成员',avatar=parse(row.avatar_json)??snapshot?.avatar??null
      const title=row.task_title.split('\n')[0].slice(0,160)
      return {...session,...(direct?{title,preview:row.goal.slice(0,500)}:{}),team:{id:row.room_id,name:row.team_name,deleted:!!configuration?.deleted_at,dissolved:!!configuration?.dissolved_at,task_id:row.task_id,task_title:row.task_title,member_id:row.member_id,alias:name,avatar,leader:configuration?.leader_id===row.member_id}}
    })
  }
}
