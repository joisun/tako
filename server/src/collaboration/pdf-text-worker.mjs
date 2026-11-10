import { parentPort,workerData } from 'node:worker_threads'
import { getDocumentProxy } from '../../vendor/unpdf.mjs'
let pdf
try{
  pdf=await getDocumentProxy(new Uint8Array(workerData),{maxImageSize:16777216,isEvalSupported:false,useSystemFonts:false})
  if(pdf.numPages>200)throw new Error('PDF 超过 200 页，请拆分后引用')
  let text=''
  for(let page=1;page<=pdf.numPages&&text.length<120000;page++){
    const document=await pdf.getPage(page),content=await document.getTextContent()
    text+=`\n[第 ${page} 页]\n`+content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('')
  }
  parentPort.postMessage({text:text.slice(0,120000),truncated:text.length>=120000,total_pages:pdf.numPages})
}catch(error){parentPort.postMessage({error:error.message??'PDF 无法读取'})}finally{await pdf?.loadingTask.destroy()}
