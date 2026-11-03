import { Task,TaskTrigger,TaskContent,TaskItem,TaskItemFile } from '@/components/ai-elements/task'
import { Button } from '@/components/ui/button'
import type { LoopRun } from '@/lib/api/loop-types'
export function TeamRunTask({run,label,status,author,pending,onReconcile}:{run:LoopRun;label:string;status:string;author:string;pending:boolean;onReconcile:()=>void}){
  const submission=run.submission??run.result?.submission
  return <Task className="room-run" data-state={run.status}><TaskTrigger title={<><strong>{label}</strong><small>{status}</small><span>{author}</span></>}/><TaskContent>{run.routing?.assignment?<TaskItem>{run.routing.assignment}</TaskItem>:null}{run.error_code?<code>{run.error_code}</code>:null}<TaskItem>{submission?.summary??run.result?.final_message}</TaskItem>{submission?.artifacts.map(path=><TaskItemFile key={path}>{path}</TaskItemFile>)}{run.session_id?<Button size="xs" variant="quiet" onClick={()=>{void navigator.clipboard.writeText(run.session_id!)}}>复制 Session ID</Button>:null}{run.status==='unknown'?<Button size="xs" disabled={pending} onClick={onReconcile}>确认旧进程已退出</Button>:null}</TaskContent></Task>
}
