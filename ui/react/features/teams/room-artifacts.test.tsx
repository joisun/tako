import { expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RoomArtifacts } from './room-artifacts'
import { RoomMessages } from './room-messages'
import { createDashboardApi } from '@/lib/api/dashboard-api'
import {MessageScrollerProvider,MessageScroller,MessageScrollerViewport,MessageScrollerContent} from '@/components/ui/message-scroller'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { LoopRun,LoopRoomDetail,LoopTaskDetail } from '@/lib/api/loop-types'

const reference='docs/专业分析维度清单.md'
const run={id:'run-one',action:{action:'deliver',reason:'已交付',artifacts:[reference]},submission:{artifacts:[reference]}} as LoopRun
function setup(preview=vi.fn().mockResolvedValue({artifact:{name:'专业分析维度清单.md',media_type:'text/markdown',size:40,text:'# 专业分析\n\n包含 23 项维度。'}})){
  const api={roomArtifactPreview:preview,roomArtifactUrl:(_room:string,_run:string,path:string,download?:boolean)=>'/files?reference='+encodeURIComponent(path)+(download?'&download=1':'')} as unknown as DashboardApi
  return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><RoomArtifacts api={api} roomId="team-one" run={run}/></QueryClientProvider>)
}
test('delivered files appear once and open a Markdown preview with an original-file download',async()=>{
  setup()
  const buttons=screen.getAllByRole('button',{name:'预览 专业分析维度清单.md'})
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
  expect(await screen.findByRole('heading',{name:'专业分析'})).toBeInTheDocument()
  const links=screen.getAllByRole('link',{name:'下载 专业分析维度清单.md'})
  expect(links.every(link=>link.getAttribute('href')==='/files?reference=docs%2F%E4%B8%93%E4%B8%9A%E5%88%86%E6%9E%90%E7%BB%B4%E5%BA%A6%E6%B8%85%E5%8D%95.md&download=1')).toBe(true)
})
test('a missing delivery file shows its error and can be retried',async()=>{
  const preview=vi.fn().mockRejectedValueOnce(new Error('交付文件已不存在')).mockResolvedValueOnce({artifact:{name:'专业分析维度清单.md',media_type:'text/markdown',size:4,text:'重新读取成功'}})
  setup(preview)
  fireEvent.click(screen.getByRole('button',{name:'预览 专业分析维度清单.md'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('交付文件已不存在')
  fireEvent.click(screen.getByRole('button',{name:'重新读取文件'}))
  expect(await screen.findByText('重新读取成功')).toBeInTheDocument()
})
test('an HTML artifact is shown as source rather than an executable preview',async()=>{
  setup(vi.fn().mockResolvedValue({artifact:{name:'page.html',media_type:'text/plain',size:40,text:'<script>window.artifactExecuted=true</script>'}}))
  fireEvent.click(screen.getByRole('button',{name:'预览 专业分析维度清单.md'}))
  await waitFor(()=>expect(screen.getByText('<script>window.artifactExecuted=true</script>')).toBeInTheDocument())
  expect(document.querySelector('[role=dialog] script')).toBeNull()
  expect(document.querySelector('[role=dialog] iframe')).toBeNull()
})

test('historical runs without native timestamps still expose their registered files',()=>{
  const oldRun={...run,status:'succeeded',member_id:'leader',parts:[{id:'old-tool',type:'tool',label:'Command · echo done',input:'{}',output:'{}',text:'',state:'completed'}]} as LoopRun
  const room={id:'team-one',members:[],messages:[],tasks:[],config:null} as unknown as LoopRoomDetail
  const task={runs:[oldRun],config:{workflow:'conversation'}} as LoopTaskDetail
  render(<QueryClientProvider client={new QueryClient()}><RoomMessages api={createDashboardApi()} room={room} task={task} onInspect={()=>{}}/></QueryClientProvider>)
  expect(screen.getByRole('button',{name:'预览 专业分析维度清单.md'})).toBeInTheDocument()
})

test.each([true,false])('previous task delivery remains accessible with a saved message=%s',hasMessage=>{
  const oldRun={...run,status:'succeeded',member_id:'leader',created_at:'2026-11-01T00:00:00Z',finished_at:'2026-11-01T00:05:00Z',parts:null} as LoopRun
  const room={id:'team-one',members:[],messages:hasMessage?[{id:'old-reply',author:'leader',run_id:run.id,task_id:'old-task',text:'历史文件已交付',created_at:'2026-11-01T00:05:00Z'}]:[],tasks:[],config:null,artifact_runs:[oldRun]} as unknown as LoopRoomDetail
  const task={runs:[],config:{workflow:'conversation'}} as unknown as LoopTaskDetail
  render(<QueryClientProvider client={new QueryClient()}><MessageScrollerProvider><MessageScroller><MessageScrollerViewport><MessageScrollerContent><RoomMessages api={createDashboardApi()} room={room} task={task} onInspect={()=>{}}/></MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider></QueryClientProvider>)
  expect(screen.getAllByRole('button',{name:'预览 专业分析维度清单.md'})).toHaveLength(1)
})
