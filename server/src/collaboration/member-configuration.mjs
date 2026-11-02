import { loopError } from './errors.mjs'
const HAIR=['dannyPhantom','dougFunny','fonze','full','mrClean','mrT','pixie','turban']
const EYES=['eyes','round','eyesShadow','smiling','smilingShadow']
export function memberConfiguration(input,status){
  const model=input.model??null,effort=input.effort??null
  const selected=status.models.find(item=>item.id===model)
  if(model!==null&&(!selected||!status.model_override_supported))throw loopError('LOOP_MODEL_UNVERIFIED','请选择客户端返回的可用模型')
  const levels=selected?.reasoningLevels??[]
  if(effort!==null&&!levels.some(value=>(typeof value==='string'?value:value.reasoningEffort??value.reasoning_effort)===effort))throw loopError('LOOP_EFFORT_UNVERIFIED','所选模型不支持此推理强度')
  return {model,effort}
}
export function memberAvatar(value){
  if(value==null)return null
  if(typeof value!=='object'||Array.isArray(value)||typeof value.seed!=='string'||value.seed.length>100)throw loopError('LOOP_AVATAR_INVALID','头像配置无效')
  const avatar={style:'micah',version:10,seed:value.seed}
  for(const [key,allowed] of [['hairVariant',HAIR],['eyesVariant',EYES]])if(value[key]!=null){if(!allowed.includes(value[key]))throw loopError('LOOP_AVATAR_INVALID','头像搭配无效');avatar[key]=value[key]}
  for(const key of ['baseColor','hairColor','shirtColor'])if(value[key]!=null){if(!/^[0-9a-f]{6}$/i.test(value[key]))throw loopError('LOOP_AVATAR_INVALID','头像颜色无效');avatar[key]=value[key]}
  return avatar
}
