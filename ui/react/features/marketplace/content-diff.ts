export interface DiffLine {kind:'same'|'added'|'removed';text:string}
// Limit the matrix so a large definition never stalls the interaction thread.
export function contentDiff(before:string,after:string):{lines:DiffLine[];simplified:boolean}{
  const a=before.split('\n'),b=after.split('\n')
  if(a.length*b.length>1000000)return{lines:[...a.slice(0,3000).map(text=>({kind:'removed' as const,text})),...b.slice(0,3000).map(text=>({kind:'added' as const,text}))],simplified:true}
  const width=b.length+1,table=new Uint32Array((a.length+1)*width)
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1])
  const lines:DiffLine[]=[];let i=0,j=0
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){lines.push({kind:'same',text:a[i]});i++;j++;continue}
    if(j<b.length&&(i===a.length||table[i*width+j+1]>table[(i+1)*width+j])){lines.push({kind:'added',text:b[j++]});continue}
    lines.push({kind:'removed',text:a[i++]})
  }
  return{lines,simplified:false}
}
