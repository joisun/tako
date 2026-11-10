import { beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RoomComposer } from './room-composer'
import type { DashboardApi } from '@/lib/api/dashboard-api'

const png = new File([new Uint8Array([137,80,78,71,13,10,26,10])], '截图.png', {type:'image/png'})
const saved = {path:'/managed/截图.png',name:'截图.png',media_type:'image/png',size:8,digest:'a'.repeat(64)}
beforeEach(()=>{
  URL.createObjectURL=vi.fn(()=> 'blob:attachment-preview')
  URL.revokeObjectURL=vi.fn()
})
function setup(upload=vi.fn().mockResolvedValue({attachment:saved}),send=vi.fn().mockResolvedValue(true)) {
  render(<RoomComposer api={{uploadRoomAttachment:upload} as unknown as DashboardApi} roomId="team-one" members={[]} pending={false} onSend={send}/>)
  return {upload,send}
}

test('pasted screenshot becomes a removable attachment and can be sent without text',async()=>{
  const {upload,send}=setup()
  const editor=await screen.findByRole('textbox',{name:'发送团队消息'})
  fireEvent.paste(editor,{clipboardData:{files:[png],getData:()=>'',items:[]}})
  await screen.findByRole('button',{name:'移除 截图.png'})
  await waitFor(()=>expect(screen.getByRole('button',{name:'发送'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'发送'}))
  await waitFor(()=>expect(send).toHaveBeenCalledWith('',expect.any(String),[],[saved]))
  expect(upload).toHaveBeenCalledWith('team-one',png,expect.any(AbortSignal))
  await waitFor(()=>expect(screen.queryByRole('button',{name:'移除 截图.png'})).not.toBeInTheDocument())
})

test('failed upload stays visible and retries the original file before sending',async()=>{
  const upload=vi.fn().mockRejectedValueOnce(new Error('文件保存失败')).mockResolvedValueOnce({attachment:saved})
  const {send}=setup(upload)
  const editor=await screen.findByRole('textbox',{name:'发送团队消息'})
  fireEvent.drop(editor.closest('form')!,{dataTransfer:{files:[png],types:['Files']}})
  await screen.findByText('文件保存失败')
  expect(screen.getByRole('button',{name:'发送'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'重试 截图.png'}))
  await waitFor(()=>expect(screen.getByRole('button',{name:'发送'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'发送'}))
  await waitFor(()=>expect(send).toHaveBeenCalledWith('',expect.any(String),[],[saved]))
})

test('an oversized file is rejected before upload',async()=>{
  const {upload}=setup()
  const large=new File([new Uint8Array(20*1024*1024+1)],'large.png',{type:'image/png'})
  const input=screen.getByLabelText('选择附件')
  fireEvent.change(input,{target:{files:[large]}})
  expect(await screen.findByRole('alert')).toHaveTextContent('20 MB')
  expect(upload).not.toHaveBeenCalled()
})

test('mixed spreadsheet clipboard keeps text instead of attaching the rendered image',async()=>{
  const {upload}=setup()
  const editor=await screen.findByRole('textbox',{name:'发送团队消息'})
  fireEvent.paste(editor,{clipboardData:{files:[png],getData:(type:string)=>type==='text/plain'?'产品\t数量\n报告\t23':''}})
  await waitFor(()=>expect(editor).toHaveTextContent('产品'))
  expect(upload).not.toHaveBeenCalled()
  expect(screen.queryByRole('button',{name:'移除 截图.png'})).not.toBeInTheDocument()
})

test('failed send retains attachments and the request identity for retry',async()=>{
  const send=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  setup(undefined,send)
  const editor=await screen.findByRole('textbox',{name:'发送团队消息'})
  fireEvent.paste(editor,{clipboardData:{files:[png],getData:()=>'',items:[]}})
  await waitFor(()=>expect(screen.getByRole('button',{name:'发送'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'发送'}))
  await waitFor(()=>expect(send).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button',{name:'移除 截图.png'})).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'发送'}))
  await waitFor(()=>expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1])
})

test('a removed upload cannot reappear when its response arrives',async()=>{
  let finish!:(value:unknown)=>void
  const upload=vi.fn((_room:string,_file:File,_signal?:AbortSignal)=>new Promise(resolve=>{finish=resolve}))
  setup(upload)
  const editor=await screen.findByRole('textbox',{name:'发送团队消息'})
  fireEvent.paste(editor,{clipboardData:{files:[png],getData:()=>'',items:[]}})
  expect(screen.getByRole('button',{name:'发送'})).toBeDisabled()
  fireEvent.click(await screen.findByRole('button',{name:'移除 截图.png'}))
  expect(upload.mock.calls[0]?.[2]?.aborted).toBe(true)
  finish({attachment:saved})
  await waitFor(()=>expect(screen.queryByRole('button',{name:'移除 截图.png'})).not.toBeInTheDocument())
})
