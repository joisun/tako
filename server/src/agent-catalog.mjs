import { readdir, readFile, realpath, stat, lstat, mkdir, mkdtemp, open, link, rm, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument } from '../vendor/yaml.mjs'
import { parse as parseToml } from '../vendor/toml.mjs'

const MAX_DEFINITION_BYTES = 256 * 1024
const MARKETS = Object.freeze([
  { id:'ecc', name:'ECC · Everything Claude Code', repository:'affaan-m/ECC', ref:'main', license:'MIT', url:'https://github.com/affaan-m/ECC', directories:['agents'] },
  { id:'agency-agents', name:'Agency Agents', repository:'msitarzewski/agency-agents', ref:'main', license:'MIT', url:'https://github.com/msitarzewski/agency-agents', directories:['engineering','design','product','project-management','testing','specialized','support','marketing','sales','finance'] },
])
const sourceInfo = ({directories,...source}) => source
const marketSource = id => { const source=MARKETS.find(item=>item.id===id);if(!source)throw catalogError('未知的 Agent 市场来源',404);return source }

const catalogError = (message, statusCode = 400) => Object.assign(new Error(message), { code: 'AGENT_CATALOG_ERROR', statusCode })
const hash = value => createHash('sha256').update(value).digest('hex')
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : []

export function parseAgentDefinition(contents, { format, source, fallbackName }) {
  if (Buffer.byteLength(contents) > MAX_DEFINITION_BYTES) throw catalogError('Agent定义超过大小限制')
  let data, instructions, normalizedMetadata = false
  if (format === 'toml') {
    data = parseToml(contents)
    instructions = data.developer_instructions
  } else {
    const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
    if (!match) throw catalogError('Markdown Agent需要name和description front matter')
    let document = parseDocument(match[1])
    // Existing global Claude definitions include single-line descriptions with unquoted colons.
    // Normalize that observed form in memory; preserve the file and instruction body verbatim.
    if (document.errors.length && /^description:[ \t]+[^"'|>]/m.test(match[1])) {
      document = parseDocument(match[1].replace(/^description:[ \t]+(.+)$/m, (_, value) => `description: ${JSON.stringify(value)}`))
      normalizedMetadata = document.errors.length === 0
    }
    if (document.errors.length) throw catalogError('Agent front matter无效')
    data = document.toJS(); instructions = match[2].trim()
  }
  if (!data || typeof data !== 'object' || typeof instructions !== 'string' || !instructions.trim()) throw catalogError('Agent定义缺少有效的角色指令')
  const origin = data.undercontrol_source ?? data.rillo_source
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName,
    description: typeof data.description === 'string' ? data.description.slice(0, 8000) : '',
    instructions: instructions.trim(), model: typeof data.model === 'string' ? data.model : null,
    tools: list(data.tools), skills: list(data.skills), color: typeof data.color === 'string' ? data.color : null,
    source: { ...source, digest: hash(contents), normalized_metadata: normalizedMetadata, ...(origin ? { origin, license:origin.license, revision:origin.revision, url:origin.url } : {}) },
  }
}

export function createAgentCatalog({ home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex'), fetchImpl = fetch, clock = Date.now, additionalLocalDefinitions=async()=>({definitions:[],errors:[]}) } = {}) {
  const marketCache = new Map(), marketPending = new Map()
  const definitionCache = new Map()
  async function local() {
    const profiles = new Map(), errors = [], visited = new Set()
    // Codex's actual runtime copy wins over the shared source for the Codex variant.
    for (const root of [join(home, '.agents', 'agents'), join(home, '.claude', 'agents'), join(codexHome, 'agents')]) {
      let canonical
      try { canonical = await realpath(root) } catch (error) { if (error.code !== 'ENOENT') errors.push({ source: root, message: '无法读取目录' }); continue }
      if (visited.has(canonical)) continue
      visited.add(canonical)
      let entries
      try { entries = await readdir(canonical, { withFileTypes: true }) } catch { errors.push({ source: root, message: '无法读取目录' }); continue }
      for (const entry of entries.slice(0, 1000)) {
        if (!entry.isFile() || !['.md','.toml'].includes(extname(entry.name)) || /^(?:README|AGENTS|SKILL)\./i.test(entry.name)) continue
        const path = join(canonical, entry.name), slug = basename(entry.name, extname(entry.name))
        try {
          if ((await stat(path)).size > MAX_DEFINITION_BYTES) throw catalogError('Agent定义超过大小限制')
          const format = extname(path) === '.toml' ? 'toml' : 'markdown'
          const definition = parseAgentDefinition(await readFile(path, 'utf8'), { format, fallbackName: slug, source: { kind: 'local', path, format, label: '本地全局 Agent' } })
          const existing = profiles.get(slug) ?? { id: `local:${slug}`, slug, name: definition.name, description: definition.description, variants: {} }
          existing.variants[format === 'toml' ? 'codex' : 'claude'] = definition
          profiles.set(slug, existing)
        } catch (error) { errors.push({ source: path, message: error.code === 'AGENT_CATALOG_ERROR' ? error.message : '定义解析失败' }) }
      }
    }
    const additional=await additionalLocalDefinitions()
    return { definitions: [...profiles.values()].map(profile => ({ ...profile, runtimes: Object.keys(profile.variants) })).concat(additional.definitions), errors:errors.concat(additional.errors) }
  }
  async function remoteJson(url) {
    let response
    try { response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) }) }
    catch { throw catalogError('无法连接 Agent 市场，请检查网络后重试；本地定义仍可使用',503) }
    if (!response.ok) throw catalogError(response.status === 403 || response.status === 429 ? 'Agent目录请求受限，请稍后重试；本地定义仍可使用' : '开源Agent目录暂时不可用', 503)
    try { return await response.json() } catch { throw catalogError('Agent 市场返回了无效目录，请稍后重试',503) }
  }
  async function marketplace(sourceId='agency-agents',{refresh=false}={}) {
    const market=marketSource(sourceId),cached=marketCache.get(sourceId)
    if(marketPending.has(sourceId))return marketPending.get(sourceId)
    if(!refresh&&cached&&cached.expires>clock())return cached.value
    const request=(async()=>{
      const commit=await remoteJson(`https://api.github.com/repos/${market.repository}/commits/${market.ref}`)
      if(!/^[a-f0-9]{40}$/i.test(commit.sha)||!commit.commit?.tree?.sha)throw catalogError('Agent 市场返回了无效版本',503)
      const tree=await remoteJson(`https://api.github.com/repos/${market.repository}/git/trees/${commit.commit.tree.sha}?recursive=1`)
      if(tree.truncated||!Array.isArray(tree.tree))throw catalogError('Agent目录列表不完整，请稍后重试',503)
      const directories=new Set(market.directories)
      const definitions=tree.tree.filter(entry=>entry.type==='blob'&&directories.has(entry.path.split('/')[0])&&entry.path.endsWith('.md')&&!/README/i.test(entry.path)&&(market.id!=='ecc'||entry.path.split('/').length===2)).map(entry=>{
        const slug=basename(entry.path,'.md')
        return {id:`${market.id}:${commit.sha}:${entry.path}`,slug,name:market.id==='ecc'?slug.replaceAll('-',' '):slug.replace(/^[^-]+-/,'').replaceAll('-',' '),description:entry.path.split('/')[0],runtimes:['codex','claude'],source:{kind:'github',label:market.name,repository:market.repository,revision:commit.sha,path:entry.path,license:market.license,url:`https://github.com/${market.repository}/blob/${commit.sha}/${entry.path}`}}
      })
      const value={definitions,errors:[],source:{...sourceInfo(market),revision:commit.sha},fetched_at:new Date(clock()).toISOString()}
      const previous=cached?.value.source.revision!==commit.sha?cached?.value.definitions??[]:cached?.previous??[]
      marketCache.set(sourceId,{value,previous,expires:clock()+10*60*1000})
      return value
    })()
    marketPending.set(sourceId,request)
    try{return await request}finally{marketPending.delete(sourceId)}
  }
  async function get(id, runtimeId) {
    if(typeof id!=='string'||!id)throw catalogError('请选择 Agent 定义')
    if (id.startsWith('local:')||id.startsWith('managed:')) {
      const profile = (await local()).definitions.find(value => value.id === id)
      if (!profile) throw catalogError('本地Agent定义已不存在，请刷新目录', 404)
      const definition = profile.variants[runtimeId] ?? Object.values(profile.variants)[0]
      return { ...definition, model: !profile.variants[runtimeId] || definition.model === 'inherit' ? null : definition.model, id, slug: profile.slug, runtime_id: runtimeId,
        native_format: profile.variants[runtimeId]?.source.format ?? null }
    }
    const market=marketSource(id.split(':')[0])
    if (definitionCache.has(id)) return { ...definitionCache.get(id), model: runtimeId === 'claude' && definitionCache.get(id).model !== 'inherit' ? definitionCache.get(id).model : null, runtime_id: runtimeId }
    const listing=await marketplace(market.id)
    const item=[...listing.definitions,...(marketCache.get(market.id)?.previous??[])].find(value=>value.id===id)
    if (!item) throw catalogError('请选择目录中存在的Agent定义，请刷新目录', 404)
    let response
    try { response = await fetchImpl(`https://raw.githubusercontent.com/${market.repository}/${item.source.revision}/${item.source.path}`, { signal: AbortSignal.timeout(15000) }) }
    catch { throw catalogError('无法连接 Agent 定义来源，请检查网络后重试',503) }
    if (!response.ok) throw catalogError('无法读取所选Agent定义', 503)
    if (Number(response.headers?.get('content-length')) > MAX_DEFINITION_BYTES) throw catalogError('Agent定义超过大小限制')
    const definition = { ...parseAgentDefinition(await response.text(), { format: 'markdown', source: item.source, fallbackName: item.slug }), id, slug: item.slug }
    definitionCache.set(id, definition)
    return { ...definition, model: runtimeId === 'claude' && definition.model !== 'inherit' ? definition.model : null, runtime_id: runtimeId }
  }
  async function importLocal(id, runtimeId = 'codex') {
    const market=MARKETS.find(source=>typeof id==='string'&&id.startsWith(source.id+':'))
    if (!market) throw catalogError('只能将市场角色添加到本地')
    const definition = await get(id, 'claude'), slug = market.id==='ecc'?`ecc-${definition.slug}`:definition.slug
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(slug)) throw catalogError('Agent文件标识无效')
    const existingProfile = (await local()).definitions.find(value=>value.id===`local:${slug}`)
    if (existingProfile && Object.values(existingProfile.variants).some(value=>value.source.origin?.id!==id)) throw catalogError('同名Agent定义已存在，不覆盖',409)
    const root = join(home,'.agents','agents')
    await mkdir(root,{recursive:true})
    const canonical = await realpath(root), destination = join(canonical,`${slug}.md`)
    const metadata = { name:definition.name, description:definition.description, ...(definition.model ? { model:definition.model } : {}), tools:definition.tools, skills:definition.skills,
      undercontrol_source:{ id, ...definition.source } }
    const contents = '---\n'+Object.entries(metadata).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n')+'\n---\n'+definition.instructions+'\n'
    const temp = await mkdtemp(join(canonical,'.undercontrol-import-'))
    let imported = true
    try {
      const file = await open(join(temp,'definition.md'),'wx',0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      try { await link(join(temp,'definition.md'),destination) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (!(await lstat(destination)).isFile()) throw catalogError('同名Agent文件已存在，不覆盖',409)
        const existing = parseAgentDefinition(await readFile(destination,'utf8'),{format:'markdown',source:{},fallbackName:slug})
        if (existing.source.origin?.id !== id || existing.instructions !== definition.instructions || existing.source.origin?.digest !== definition.source.digest) throw catalogError('同名Agent定义已存在，不覆盖',409)
        imported = false
      }
    } finally { await rm(temp,{recursive:true,force:true}) }
    const profile = await get(`local:${slug}`,runtimeId)
    return { definition:profile, imported, path:destination }
  }
  async function deletionFiles(id) {
    if(!id?.startsWith('local:'))return []
    const slug=id.slice(6)
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(slug))throw catalogError('Agent 标识无效')
    const files=new Map()
    for(const root of [join(home,'.agents','agents'),join(home,'.claude','agents'),join(codexHome,'agents'),join(home,'.codex-api','agents')]) {
      const canonical=await realpath(root).catch(error=>{if(error.code==='ENOENT')return null;throw error})
      if(!canonical)continue
      for(const extension of ['.md','.toml']) {
        const path=join(canonical,slug+extension),info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error})
        if(!info)continue
        if(!info.isFile()||info.size>MAX_DEFINITION_BYTES)throw catalogError('定义路径已改变，请人工检查后重试',409)
        files.set(path,{path,digest:hash(await readFile(path))})
      }
    }
    return [...files.values()].sort((a,b)=>a.path.localeCompare(b.path))
  }
  async function stageDeletion(files) {
    for(const file of files) {
      if(!(await lstat(file.path)).isFile()||hash(await readFile(file.path))!==file.digest)throw catalogError('Agent 定义已改变，请重新确认删除',409)
      await rename(file.path,file.staged)
      if(hash(await readFile(file.staged))!==file.digest)throw catalogError('Agent 定义在删除时发生变化，已停止',409)
    }
  }
  async function finishDeletion(files,committed) {
    for(const file of files) {
      const exists=await lstat(file.staged).catch(error=>{if(error.code==='ENOENT')return null;throw error})
      if(!exists)continue
      if(committed){await rm(file.staged);continue}
      // Hard-link restoration refuses to overwrite a concurrently recreated definition.
      await link(file.staged,file.path)
      await rm(file.staged)
    }
  }
  return Object.freeze({ local, marketplace, get, importLocal, deletionFiles, stageDeletion, finishDeletion, sources: () => [{ id: 'local', name: '本地全局 Agent' }, ...MARKETS.map(sourceInfo)] })
}
