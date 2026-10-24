// Shared, read-only Idea Lab search. Full text is fetched only on explicit request.
// No browser API key and no local favorites/notes leave this browser.
let scope='basic',state='idle',detailTask=null;
const fullTexts=new Map();
let missing=0;
export const searchScope=()=>scope;
export function setSearchScope(value){scope=value==='full'?'full':'basic';}
export const deepSearchState=()=>({state,missing});
const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const fromObject=(object,output=[])=>{
 if(typeof object==='string' && object.trim())output.push(object);
 else if(Array.isArray(object))for(const value of object)fromObject(value,output);
 else if(object&&typeof object==='object')for(const value of Object.values(object))fromObject(value,output);
 return output;
};
function section(label,values,rank){return {label,rank,values:typeof values==='string'?[values]:Array.isArray(values)?values:[]};}
function hitText(value,term){
 const hay=normalized(value),at=hay.indexOf(term);
 if(at<0)return null;
 // Bound visible excerpts. Do not render source HTML.
 const visible=String(value).replace(/\s+/g,' ');
 const start=Math.max(0,at-28);
 const end=Math.min(visible.length,at+term.length+68);
 return (start?'…':'')+visible.slice(start,end)+(end<visible.length?'…':'');
}
export function searchMatch(item,query,{full=scope==='full',development=null}={}){
 const term=normalized(query);if(!term)return {rank:999,label:'',snippet:''};
 const sections=[
  section('이름',[item.name],0),
  section('제작사',[item.developer,...(item.store_variants||[]).map(x=>x.developer)],1),
  section('분류',[item.category,item.kind],1),
  section('기능 태그',item.tags||[],2),
  section('AI 요약',[item.summary],3)
 ];
 if(full&&(state==='ready'||state==='partial')){
  const keys=[item.app_key,...(item.alias_keys||[])];
  for(const key of keys){const documents=fullTexts.get(key);if(!documents)continue;
   if(documents.analysis)sections.push(section('3.1 상세 분석',documents.analysis,4));
   if(documents.brief)sections.push(section('3.5 개발 검토',documents.brief,5));
   if(documents.plan)sections.push(section('3.5 상세 설계',documents.plan,6));
  }
  if(development){
   if(development.brief)sections.push(section('3.5 개발 검토',fromObject(development.brief),5));
   if(development.plan)sections.push(section('3.5 상세 설계',fromObject(development.plan),6));
  }
 }
 for(const group of sections)for(const value of group.values){
  const snippet=hitText(value,term);if(snippet!==null)return {rank:group.rank,label:group.label,snippet};
 }
 return null;
}
export function searchResults(items,query,{full=scope==='full'}={}){
 const term=normalized(query);if(!term)return items;
 const found=[];
 items.forEach((item,position)=>{const match=searchMatch(item,term,{full});if(match)found.push({item,match,position});});
 return found.sort((a,b)=>a.match.rank-b.match.rank||a.position-b.position).map(({item})=>item);
}
const read=async url=>{const response=await fetch(url,{cache:'no-cache'});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();};
export function ensureDeepSearch(items,onReady=()=>{}){
 if(state==='ready'||state==='partial')return Promise.resolve();
 if(detailTask)return detailTask;
 state='loading';missing=0;
 // 3.1 analysis is sharded. Only known AI shards are fetched; not every app page.
 const shards=[...new Set(items.filter(i=>i.has_ai&&i.ai_shard).map(i=>i.ai_shard))];
 const work=shards.map(shard=>read(`./data/ai/items/${encodeURIComponent(shard)}.json`).then(data=>{
  for(const [key,record] of Object.entries(data.items||{})){
   if(record.app_key===key&&record.analysis)fullTexts.set(key,{...(fullTexts.get(key)||{}),analysis:fromObject(record.analysis)});
  }
 }).catch(()=>{missing++;}));
 // Development index may not exist before the first scheduled Gemini 3.5 run.
 work.push(read('./data/development/index.json').then(async idx=>{
  if(idx?.schema_version!==1||!Array.isArray(idx.items))throw Error('index');
  const groups=new Map();for(const row of idx.items)if(row.app_key&&row.shard){
   if(!groups.has(row.shard))groups.set(row.shard,[]);groups.get(row.shard).push(row.app_key);
  }
  await Promise.all([...groups].map(async ([shard,keys])=>{
   try{const json=await read(`./data/development/items/${encodeURIComponent(shard)}.json`);
    for(const key of keys){const doc=json.items?.[key];if(doc?.app_key===key){
      const old=fullTexts.get(key)||{};
      fullTexts.set(key,{...old,brief:fromObject(doc.brief),plan:fromObject(doc.plan)});
    }}
   }catch{missing++;}
  }));
 }).catch(error=>{if(error.message!=='HTTP 404')missing++;}));
 detailTask=Promise.all(work).then(()=>{state=missing?'partial':'ready';}).finally(()=>{detailTask=null;onReady();});
 return detailTask;
}
export function resetDeepSearchForTests(){scope='basic';state='idle';detailTask=null;fullTexts.clear();missing=0;}
