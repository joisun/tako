import {readJson,sendJson} from '../http-utils.mjs'
import {marketError} from './definition.mjs'
export async function handleMarketplaceRequest({request,response,url,marketplace}){
  const path=url.pathname
  if(!path.startsWith('/api/v1/marketplace'))return false
  if(!marketplace)throw marketError('Marketplace 服务尚未就绪',503)
  const send=value=>{sendJson(response,200,value);return true}
  const body=async()=>{if(!String(request.headers['content-type']).startsWith('application/json'))throw marketError('需要 JSON 请求',415);const input=await readJson(request,{limit:48000});if(!input||typeof input!=='object'||Array.isArray(input))throw marketError('请求内容须为对象');return input}
  const id=url.searchParams.get('id')??''
  if(path==='/api/v1/marketplace/sources'){
    if(request.method==='GET')return send(marketplace.sources())
    if(request.method==='POST')return send(await marketplace.saveSource(await body()))
    if(request.method==='DELETE')return send(await marketplace.deleteSource(await body()))
  }
  if(path==='/api/v1/marketplace/catalog'&&request.method==='GET')return send(await marketplace.catalog(url.searchParams.get('source')??'agency-agents',{force:url.searchParams.get('refresh')==='1'}))
  if(path==='/api/v1/marketplace/definition'&&request.method==='GET')return send({definition:await marketplace.definition(url.searchParams.get('source')??'',url.searchParams.get('path')??'',url.searchParams.get('version'))})
  if(path==='/api/v1/marketplace/installed'&&request.method==='GET')return send(await marketplace.installed())
  if(path==='/api/v1/marketplace/local'&&request.method==='GET')return send(await marketplace.localDefinition(id))
  if(path==='/api/v1/marketplace/compatibility'&&request.method==='GET')return send(marketplace.compatibility())
  if(path==='/api/v1/marketplace/updates'&&request.method==='GET')return send(await marketplace.updates({force:url.searchParams.get('refresh')==='1'}))
  if(path==='/api/v1/marketplace/review'&&request.method==='GET')return send(await marketplace.review(id))
  if(path==='/api/v1/marketplace/session-context'&&request.method==='GET')return send(await marketplace.sessionContext(id))
  const action=path.match(/^\/api\/v1\/marketplace\/(install|update|uninstall)$/)?.[1]
  if(action&&request.method==='POST')return send(await marketplace[action](await body()))
  throw marketError('Marketplace 接口不存在',404)
}
