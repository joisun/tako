import {createHash} from 'node:crypto'
import {parseDocument} from '../../vendor/yaml.mjs'
export const MAX_DEFINITION_BYTES=256*1024
export const digest=value=>createHash('sha256').update(value).digest('hex')
export const marketError=(message,statusCode=400,code='MARKETPLACE_ERROR')=>Object.assign(new Error(message),{statusCode,code})
export function sourcePath(path){
  if(typeof path!=='string'||path.length>500||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\x00-\x1f\\:]/.test(path))throw marketError('定义路径无效')
  return path
}
const strings=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,40):typeof value==='string'?value.split(',').map(item=>item.trim()).filter(Boolean).slice(0,40):[]
const plain=value=>value.replace(/[*_`#]/g,'').trim()
export function parseDefinition(content,{source,version,path,updated_at=null}){
  sourcePath(path)
  if(typeof content!=='string'||Buffer.byteLength(content)>MAX_DEFINITION_BYTES||content.includes('\0'))throw marketError('定义为空、包含无效字符或超过 256KB')
  let metadata={},body=content
  const front=content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if(front){const parsed=parseDocument(front[1],{uniqueKeys:true});if(parsed.errors.length)throw marketError('Markdown front matter 无效');metadata=parsed.toJS({maxAliasCount:20})??{};body=front[2]}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||!body.trim())throw marketError('定义缺少角色正文')
  const heading=body.match(/^#\s+(.+)$/m)?.[1]
  if(!front&&!heading)throw marketError('没有角色元数据或标题，已跳过')
  const description=typeof metadata.description==='string'?metadata.description:body.split(/\r?\n\s*\r?\n/).find(part=>part.trim()&&!/^\s*(?:#|```|[-*]\s)/.test(part))??''
  const sections=[];const regex=/^#{2,3}\s+(.+)\r?\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm
  for(const match of body.matchAll(regex))sections.push({title:plain(match[1]),text:match[2].trim()})
  const opening=body.replace(/^#[^\n]*\n/,'').trim().split(/\r?\n\s*\r?\n/)[0]??''
  const roleDefinition=typeof metadata.name==='string'||metadata.type==='agent'||/^(?:You are\b|Act as\b|Your role\b|你是|作为)/i.test(opening)||/^#\s+.*\bAgent(?:\s+(?:Personality|Definition|Instructions))?\s*$/im.test(body)
  return {is_agent_definition:roleDefinition,id:source.id+':'+path,source_id:source.id,path,name:(typeof metadata.name==='string'&&metadata.name.trim()?metadata.name.trim():plain(heading??path.split('/').at(-1).replace(/\.md$/i,''))).slice(0,200),description:plain(description).slice(0,1500),description_source:typeof metadata.description==='string'?'frontmatter':'body',category:(typeof metadata.category==='string'?metadata.category:path.includes('/')?path.split('/')[0]:'uncategorized').slice(0,100),tags:[...new Set(strings(metadata.tags??metadata.keywords).map(tag=>tag.slice(0,80)))],responsibilities:sections.filter(section=>/mission|responsibilit|职责|任务/i.test(section.title)),workflow:sections.filter(section=>/workflow|process|工作流|流程/i.test(section.title)),content,instructions:body,version,digest:digest(content),repository:source.repository,source_name:source.name,license:source.license??null,license_text:source.license_text??null,url:`https://github.com/${source.repository}/blob/${version}/${path.split('/').map(encodeURIComponent).join('/')}`,updated_at,featured:metadata.featured===true}
}
