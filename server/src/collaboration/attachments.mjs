import { open,realpath } from 'node:fs/promises'
import { basename,isAbsolute,join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { loopError } from './errors.mjs'
const MAX_BYTES=20*1024*1024
function pdfText(bytes){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./pdf-text-worker.mjs',import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:192}})
    let settled=false
    const timer=setTimeout(()=>finish(loopError('LOOP_PDF_TIMEOUT','PDF 读取超时，请选用较小的文件')),10000)
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(value)}
    worker.once('message',value=>value.error?finish(loopError('LOOP_PDF_UNREADABLE',value.error)):finish(null,value))
    worker.once('error',()=>finish(loopError('LOOP_PDF_UNREADABLE','PDF 无法读取')))
    worker.once('exit',code=>{if(!settled)finish(loopError('LOOP_PDF_UNREADABLE',`PDF 读取进程退出（${code}）`))})
  })
}
export async function readRoomAttachment(input,{extract=true}={}){
  let path=input?.path
  if(typeof path!=='string'||path.length>4096||path.includes('\0'))throw loopError('LOOP_ATTACHMENT_INVALID','请指定服务所在机器上的图片或 PDF 绝对路径')
  if(path.startsWith('~/'))path=join(homedir(),path.slice(2))
  if(!isAbsolute(path))throw loopError('LOOP_ATTACHMENT_INVALID','文件须为服务器上的绝对路径')
  path=await realpath(path).catch(()=>{throw loopError('LOOP_ATTACHMENT_MISSING','文件不存在或无法访问')})
  const file=await open(path,'r')
  let bytes
  try{const info=await file.stat();if(!info.isFile()||info.size>MAX_BYTES)throw loopError('LOOP_ATTACHMENT_INVALID','文件须为不超过 20 MB 的图片或 PDF');const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;while(length<buffer.length){const value=await file.read(buffer,length,buffer.length-length,length);if(!value.bytesRead)break;length+=value.bytesRead}if(length>MAX_BYTES)throw loopError('LOOP_ATTACHMENT_INVALID','文件超过 20 MB');bytes=buffer.subarray(0,length)}finally{await file.close()}
  let media_type
  if(bytes.subarray(0,5).toString()==='%PDF-')media_type='application/pdf'
  else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))media_type='image/png'
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)media_type='image/jpeg'
  else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')media_type='image/webp'
  else if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString()))media_type='image/gif'
  else throw loopError('LOOP_ATTACHMENT_UNSUPPORTED','支持 PNG、JPEG、WebP、GIF 和 PDF 文件')
  const digest=createHash('sha256').update(bytes).digest('hex')
  if(input.digest&&input.digest!==digest)throw loopError('LOOP_ATTACHMENT_CHANGED','文件内容已改变，请重新添加文件')
  const value={path,name:basename(path),media_type,size:bytes.length,digest}
  if(extract&&media_type==='application/pdf')Object.assign(value,await pdfText(bytes))
  return {attachment:value,bytes}
}
export async function prepareRoomAttachments(values=[]){
  if(!Array.isArray(values)||values.length>8)throw loopError('LOOP_ATTACHMENT_INVALID','每条消息最多引用 8 个文件')
  const result=[]
  for(const value of values)result.push((await readRoomAttachment(value)).attachment)
  return result
}
