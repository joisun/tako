import { createHash } from 'node:crypto'
import { loopError } from '../errors.mjs'

const parse=value=>JSON.parse(value??'{}')
export function createFormalReports({db,clock}) {
  const now=()=>new Date(clock()).toISOString()
  function latestForRun(runId) {
    const row=db.prepare("SELECT payload_json FROM loop_events WHERE run_id=? AND kind='report_recorded' ORDER BY sequence DESC LIMIT 1").get(runId)
    return row?parse(row.payload_json):null
  }
  function latest(taskId,reportId) {
    const row=db.prepare("SELECT payload_json FROM loop_events WHERE task_id=? AND kind='report_recorded' AND json_extract(payload_json,'$.id')=? ORDER BY sequence DESC LIMIT 1").get(taskId,reportId)
    return row?parse(row.payload_json):null
  }
  function save(candidate,{submission=null,messages=[],answered_message_ids=[],evidence=[],findings=[]}={}) {
    const routing=candidate.routing??parse(candidate.routing_json)
    const owned=routing.assignment_id?db.prepare('SELECT id FROM loop_inbox WHERE id=? AND member_id=?').get(routing.assignment_id,candidate.member_id):null
    const id=owned?.id??routing.inbox_id??candidate.id
    const previous=latest(candidate.task_id,id)
    const content=submission?.summary??messages.filter(value=>value.origin!=='hook').map(value=>value.text).filter(Boolean).join('\n\n')
    if(!content)return previous
    const nativeBody=submission?messages.filter(value=>value.origin!=='hook').map(value=>value.text).filter(Boolean).join('\n\n'):null
    const value={id,task_id:candidate.task_id,member_id:candidate.member_id,run_id:candidate.id,assignment_id:owned?.id??routing.inbox_id??null,content,native_body:nativeBody||null,submission,answered_message_ids:[...new Set(answered_message_ids)],source_messages:messages.filter(value=>value.origin!=='hook').map(value=>({id:value.id,phase:value.phase})),evidence,findings}
    const digest=createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if(previous?.digest===digest)return previous
    const report={...value,version:(previous?.version??0)+1,digest}
    db.prepare('INSERT INTO loop_events(task_id,run_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)').run(candidate.task_id,candidate.id,'report_recorded',JSON.stringify(report),now())
    return report
  }
  function complete(candidate,result) {
    const existing=latestForRun(candidate.id)
    const formal=result.formal_messages??(candidate.parts??[]).filter(part=>part.type==='text'&&part.origin!=='hook'&&(part.phase==='final_answer'||!part.phase))
    if(existing){
      const evidence=result.evidence_checks??existing.evidence,findings=existing.findings.map(finding=>({...finding,review_state:!finding.evidence_ids?.length?'unverified':finding.evidence_ids.some(id=>evidence.find(value=>value.id===id)?.state!=='unchanged_since_read')?'needs_recheck':'evidence_version_current'}))
      const row=db.prepare("SELECT created_at FROM loop_events WHERE run_id=? AND kind='report_recorded' ORDER BY sequence DESC LIMIT 1").get(candidate.id)
      const afterSubmission=formal.filter(message=>!message.observed_at||message.observed_at>=row.created_at)
      return save(candidate,{submission:existing.submission,messages:afterSubmission.length?afterSubmission:existing.native_body?[{text:existing.native_body,origin:'agent'}]:[],answered_message_ids:existing.answered_message_ids,evidence,findings})
    }
    const fallback=!formal.length&&!result.hook_messages?.length&&!(candidate.parts??[]).some(part=>part.origin==='hook')&&result.status==='succeeded'&&result.final_message?[{text:result.final_message,origin:'agent'}]:formal
    return save(candidate,{submission:candidate.submission??null,messages:fallback})
  }
  function index(taskId) {
    const rows=db.prepare("SELECT payload_json FROM loop_events WHERE sequence IN (SELECT max(sequence) FROM loop_events WHERE task_id=? AND kind='report_recorded' GROUP BY json_extract(payload_json,'$.id')) ORDER BY sequence DESC LIMIT 20").all(taskId)
    return rows.map(row=>parse(row.payload_json)).map(({content,native_body,...report})=>{
      const truncated=report.findings.length>8||report.evidence.length>8||(native_body??content).length>600||report.findings.some(finding=>finding.text.length>200)
      report={...report,submission:report.submission?{...report.submission,summary:report.submission.summary.slice(0,600),...(report.submission.findings?{findings:report.submission.findings.slice(0,8).map(finding=>({...finding,text:finding.text.slice(0,200)}))}:{})}:null,evidence:report.evidence.slice(0,8),findings:report.findings.slice(0,8).map(finding=>({...finding,text:finding.text.slice(0,200)}))}
      const snapshots=db.prepare("SELECT payload_json FROM loop_events WHERE run_id=? AND kind='project_versions' ORDER BY sequence").all(report.run_id).map(row=>parse(row.payload_json))
      const start=snapshots.find(value=>value.stage==='start')?.resources,end=snapshots.findLast(value=>value.stage==='end')?.resources
      const evidence_boundary=!start?.length?'no_prepared_projects':!end?'end_not_recorded':start.some((value,index)=>value.unavailable||end[index]?.unavailable||value.head!==end[index]?.head||value.head_after!==value.head||end[index]?.head_after!==end[index]?.head||value.tracked_diff_sha256!==end[index]?.tracked_diff_sha256||value.status_sha256!==end[index]?.status_sha256)?'changed_or_unavailable':'no_recorded_git_change'
      return{...report,excerpt:content.slice(0,600),truncated,characters:(native_body??content).length,evidence_boundary}
    })
  }
  function read(taskId,input) {
    const row=db.prepare("SELECT payload_json FROM loop_events WHERE task_id=? AND kind='report_recorded' AND json_extract(payload_json,'$.id')=? AND (? IS NULL OR json_extract(payload_json,'$.version')=?) ORDER BY sequence DESC LIMIT 1").get(taskId,input.report_id??'',input.version??null,input.version??null)
    const report=row?parse(row.payload_json):null
    if(!report)throw loopError('LOOP_NOT_FOUND','报告不属于当前任务或版本不存在',404)
    const offset=input.offset??0
    if(!Number.isSafeInteger(offset)||offset<0)throw loopError('LOOP_INPUT_INVALID','报告偏移量无效')
    const {content,native_body,...metadata}=report,body=native_body??content
    return{...metadata,summary:content.slice(0,1200),content:body.slice(offset,offset+12000),offset,next_offset:offset+12000<body.length?offset+12000:null}
  }
  return{save,complete,index,read,latestForRun,latest}
}
