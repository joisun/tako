import { open,realpath,mkdir,link,rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename,dirname,isAbsolute,join,resolve,relative,sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash,randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { loopError } from './errors.mjs'
const MAX_BYTES=20*1024*1024
export function attachmentMediaType(bytes){
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf'
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg'
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp'
  if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString()))return 'image/gif'
  return null
}
function uploadName(value){
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||Buffer.byteLength(value)>240||/[\\/\x00-\x1f\x7f]/.test(value)||['.','..'].includes(value))throw loopError('LOOP_ATTACHMENT_INVALID','文件名无效')
  return value
}
export async function readRoomAttachmentUpload(request){
  let name
  try{name=uploadName(decodeURIComponent(request.headers['x-file-name']??''))}catch{request.resume();throw loopError('LOOP_ATTACHMENT_INVALID','文件名无效')}
  const declaredType=String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase()
  if(!['image/png','image/jpeg','image/webp','image/gif','application/pdf','application/octet-stream'].includes(declaredType)){request.resume();throw loopError('LOOP_ATTACHMENT_UNSUPPORTED','支持 PNG、JPEG、WebP、GIF 和 PDF 文件',415)}
  if(Number(request.headers['content-length'])>MAX_BYTES){request.resume();throw loopError('REQUEST_BODY_TOO_LARGE','文件超过 20 MiB',413)}
  const chunks=[];let length=0
  // Keep the HTTP socket writable so an oversized chunked upload receives its 413 response.
  for await(const chunk of request.iterator({destroyOnReturn:false})){
    length+=chunk.length
    if(length>MAX_BYTES){request.resume();throw loopError('REQUEST_BODY_TOO_LARGE','文件超过 20 MiB',413)}
    chunks.push(chunk)
  }
  if(!length)throw loopError('LOOP_ATTACHMENT_INVALID','文件不能为空')
  const bytes=Buffer.concat(chunks,length)
  const media_type=attachmentMediaType(bytes)
  if(!media_type||declaredType!=='application/octet-stream'&&media_type!==declaredType)throw loopError('LOOP_ATTACHMENT_UNSUPPORTED','文件内容与声明的图片或 PDF 类型不符',415)
  return{name,media_type,bytes}
}
export async function saveRoomAttachmentUpload(root,roomId,{name,media_type,bytes}){
  uploadName(name)
  if(!isAbsolute(root??''))throw loopError('LOOP_INTERNAL_WORKSPACE_UNAVAILABLE','附件存储目录尚未初始化',503)
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw loopError('LOOP_ATTACHMENT_INVALID','文件须为不超过 20 MiB 的图片或 PDF')
  if(attachmentMediaType(bytes)!==media_type)throw loopError('LOOP_ATTACHMENT_UNSUPPORTED','文件内容与声明的类型不符',415)
  await mkdir(dirname(root),{recursive:true,mode:0o700})
  root=join(await realpath(dirname(root)),basename(root))
  await mkdir(root,{recursive:true,mode:0o700})
  if(await realpath(root)!==root)throw loopError('LOOP_ATTACHMENT_INVALID','附件目录不能指向其他位置')
  const roomDirectory=join(root,roomId)
  await mkdir(roomDirectory,{recursive:true,mode:0o700})
  if(await realpath(roomDirectory)!==roomDirectory)throw loopError('LOOP_ATTACHMENT_INVALID','附件目录不能指向其他位置')
  const digest=createHash('sha256').update(bytes).digest('hex'),directory=join(roomDirectory,digest)
  await mkdir(directory,{recursive:true,mode:0o700})
  if(await realpath(directory)!==directory)throw loopError('LOOP_ATTACHMENT_INVALID','附件目录不能指向其他位置')
  const temporary=join(directory,`.${randomUUID()}.tmp`),path=join(directory,name)
  try{
    const file=await open(temporary,'wx',0o400)
    try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
    await link(temporary,path).catch(error=>{if(error.code!=='EEXIST')throw error})
  }finally{await rm(temporary,{force:true})}
  return (await readRoomAttachment({path,digest},{managedRoot:root,roomId})).attachment
}
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
export async function readRoomAttachment(input,{extract=true,managedRoot=null,roomId=null}={}){
  let path=input?.path
  if(typeof path!=='string'||path.length>4096||path.includes('\0'))throw loopError('LOOP_ATTACHMENT_INVALID','请指定服务所在机器上的图片或 PDF 绝对路径')
  if(path.startsWith('~/'))path=join(homedir(),path.slice(2))
  if(!isAbsolute(path))throw loopError('LOOP_ATTACHMENT_INVALID','文件须为服务器上的绝对路径')
  const requested=resolve(path)
  path=await realpath(path).catch(()=>{throw loopError('LOOP_ATTACHMENT_MISSING','文件不存在或无法访问')})
  let expectedDigest=input.digest
  if(managedRoot){
    const root=await realpath(managedRoot).catch(()=>resolve(managedRoot)),child=relative(root,path),requestedChild=relative(root,requested)
    const within=value=>value!==''&&!isAbsolute(value)&&value!=='..'&&!value.startsWith(`..${sep}`)
    if(within(child)||within(requestedChild)){
      const parts=child.split(sep)
      if(path!==requested||parts.length!==3||roomId&&parts[0]!==roomId||!/^[a-f0-9]{64}$/.test(parts[1]))throw loopError('LOOP_ATTACHMENT_INVALID','上传的文件引用无效')
      expectedDigest=parts[1]
      if(input.digest&&input.digest!==expectedDigest)throw loopError('LOOP_ATTACHMENT_CHANGED','上传的文件摘要已改变')
    }
  }
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  let bytes
  try{const info=await file.stat();if(!info.isFile()||info.size>MAX_BYTES)throw loopError('LOOP_ATTACHMENT_INVALID','文件须为不超过 20 MB 的图片或 PDF');const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;while(length<buffer.length){const value=await file.read(buffer,length,buffer.length-length,length);if(!value.bytesRead)break;length+=value.bytesRead}if(length>MAX_BYTES)throw loopError('LOOP_ATTACHMENT_INVALID','文件超过 20 MB');bytes=buffer.subarray(0,length)}finally{await file.close()}
  const media_type=attachmentMediaType(bytes)
  if(!media_type)throw loopError('LOOP_ATTACHMENT_UNSUPPORTED','支持 PNG、JPEG、WebP、GIF 和 PDF 文件')
  const digest=createHash('sha256').update(bytes).digest('hex')
  if(expectedDigest&&expectedDigest!==digest)throw loopError('LOOP_ATTACHMENT_CHANGED','文件内容已改变，请重新添加文件')
  const value={path,name:basename(path),media_type,size:bytes.length,digest}
  if(extract&&media_type==='application/pdf')Object.assign(value,await pdfText(bytes))
  return {attachment:value,bytes}
}
export async function prepareRoomAttachments(values=[],options={}){
  if(!Array.isArray(values)||values.length>8)throw loopError('LOOP_ATTACHMENT_INVALID','每条消息最多引用 8 个文件')
  const result=[]
  for(const value of values)result.push((await readRoomAttachment(value,options)).attachment)
  return result
}
