// Personal data remains in the browser. Version 1 backups remain readable.
const KEY='app-trend:favorites:v1';
export const FAVORITE_STATUSES=['관심','살펴보는 중','개발 후보','보류'];
// Populated from the real Lab index; never infer links from title alone.
let favoriteAliases=new Map();
const canonicalKey=key=>favoriteAliases.get(key)||key;
const identity=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const publisher=value=>identity(value).replace(/\s*\(apps?\)$/, '')
  .replace(/(?:\s*,?\s*(?:inc\.?|incorporated|ltd\.?|limited|llc|corp\.?|corporation|co\.?))+(?:\s*,?\s*(?:ltd\.?))?$/, '').trim();
// Used only when someone saved BOTH store versions before the Lab index loaded.
function savedPairAliases(rows){
  const byIdentity=new Map(),aliases=new Map();
  for(const row of rows){
    if(!['apple','google'].includes(row.app_key.split(':')[0]))continue;
    const key=JSON.stringify([identity(row.name),publisher(row.developer)]);
    if(!identity(row.name)||!publisher(row.developer))continue;
    const group=byIdentity.get(key)||[];group.push(row);byIdentity.set(key,group);
  }
  for(const group of byIdentity.values()){
    if(group.length!==2||new Set(group.map(r=>r.app_key.split(':')[0])).size!==2)continue;
    const apple=group.find(r=>r.app_key.startsWith('apple:'));
    aliases.set(group.find(r=>r.app_key.startsWith('google:')).app_key,apple.app_key);
  }
  return aliases;
}
function mergeRows(primary,secondary,originalSource=secondary.source){
  const result={...primary};
  for(const field of ['detail_url','icon_url','developer','kind','primary_category','first_seen']){
    if(!result[field]&&secondary[field])result[field]=secondary[field];
  }
  if(secondary.added_at&&secondary.added_at<result.added_at)result.added_at=secondary.added_at;
  if(result.status==='관심'&&secondary.status!=='관심')result.status=secondary.status;
  else if(secondary.status!=='관심'&&secondary.status!==result.status){
    // A unified candidate can keep only one status. Preserve the other in
    // the private note instead of silently discarding a manual decision.
    const label=`[${originalSource==='google'?'Google Play':'Apple App Store'}의 기존 검토 상태: ${secondary.status}]`;
    if(!result.note.includes(label))result.note+=(result.note?'\n\n':'')+label;
  }
  if(secondary.note&&secondary.note!==result.note){
    if(!result.note)result.note=secondary.note;
    else if(!result.note.includes(secondary.note)){
      result.note+=`\n\n[${originalSource==='google'?'Google Play':'Apple App Store'}에서 저장한 메모]\n${secondary.note}`;
    }
  }
  return result;
}
function combineFavorites(entries){
  const rows=entries.map(normalizeFavorite).filter(Boolean);
  const fallback=savedPairAliases(rows);
  const merged=new Map();
  for(const row of rows){
    const key=canonicalKey(fallback.get(row.app_key)||row.app_key);
    const normalized={...row,app_key:key,source:key.split(':')[0]};
    // The original save order is maintained; notes from both sources survive.
    merged.set(key,merged.has(key)?mergeRows(merged.get(key),normalized,row.source):normalized);
  }
  return [...merged.values()];
}
// After the index loads, migrate old saved aliases without changing private notes.
export function setFavoriteAliases(aliases){
  favoriteAliases=new Map(aliases);
  try{
    const raw=JSON.parse(localStorage.getItem(KEY)||'[]');
    if(!Array.isArray(raw))return false;
    const merged=combineFavorites(raw);
    if(JSON.stringify(raw)!==JSON.stringify(merged)){
      persist(merged);return true;
    }
  }catch{}
  return false;
}

const cleanText=(value,max)=>String(value??'').slice(0,max);
function httpUrl(value){
  try{const u=new URL(String(value||''));return u.protocol==='https:'||u.protocol==='http:'?u.href:'';}
  catch{return '';}
}
export function normalizeFavorite(entry){
  if(!entry||typeof entry!=='object'||typeof entry.app_key!=='string'||!entry.app_key.trim()||entry.app_key.length>220)return null;
  const source=entry.app_key.split(':')[0];
  return {
    app_key:entry.app_key,
    name:cleanText(entry.name||entry.app_key,200),
    source:cleanText(entry.source||source,30),
    note:cleanText(entry.note,10000),
    status:FAVORITE_STATUSES.includes(entry.status)?entry.status:'관심',
    added_at:/^\d{4}-\d{2}-\d{2}$/.test(String(entry.added_at))?entry.added_at:new Date().toISOString().slice(0,10),
    // Keep a minimal, optional snapshot. The source app may leave today's charts;
    // this does not create a new observation or claim a rank.
    detail_url:httpUrl(entry.detail_url),
    icon_url:httpUrl(entry.icon_url),
    developer:cleanText(entry.developer,200),
    kind:entry.kind==='app'||entry.kind==='game'?entry.kind:'',
    primary_category:cleanText(entry.primary_category,100),
    first_seen:/^\d{4}-\d{2}-\d{2}$/.test(String(entry.first_seen))?entry.first_seen:''
  };
}
export function getFavorites(){
  try{
    const raw=JSON.parse(localStorage.getItem(KEY)||'[]');
    return Array.isArray(raw)?combineFavorites(raw):[];
  }catch{return [];}
}
function persist(rows){localStorage.setItem(KEY,JSON.stringify(rows));window.dispatchEvent(new Event('favorites-updated'));}
export const hasFavorite=key=>getFavorites().some(item=>item.app_key===canonicalKey(key));
export const getFavorite=key=>getFavorites().find(item=>item.app_key===canonicalKey(key));
export function toggleFavorite(item){
  if(!item||!item.app_key)return false;
  const rows=getFavorites(),key=canonicalKey(item.app_key),idx=rows.findIndex(r=>r.app_key===key);
  if(idx>=0){rows.splice(idx,1);persist(rows);return false;}
  const normalized=normalizeFavorite({...item,app_key:key,source:key.split(':')[0],note:'',status:'관심'});
  if(!normalized)return false;
  rows.unshift(normalized);persist(rows);return true;
}
export function updateFavorite(key,attrs){
  const rows=getFavorites();key=canonicalKey(key);const idx=rows.findIndex(r=>r.app_key===key);
  if(idx<0)return false;
  rows[idx]=normalizeFavorite({...rows[idx],...attrs,app_key:key});persist(rows);return true;
}
export function refreshFavoriteSnapshots(appMap){
  const rows=getFavorites();let changed=false;
  for(const row of rows){
    const current=appMap.get(row.app_key);
    if(!current)continue;
    const updated=normalizeFavorite({...row,
      detail_url:row.detail_url||current.detail_url,
      icon_url:row.icon_url||current.icon_url,
      developer:row.developer||current.developer,
      kind:row.kind||current.kind,
      primary_category:row.primary_category||current.primary_category,
      first_seen:row.first_seen||current.first_seen
    });
    if(updated && JSON.stringify(updated)!==JSON.stringify(row)){
      Object.assign(row,updated);changed=true;
    }
  }
  if(changed)persist(rows);
  return changed;
}
export function filterFavorites(rows,{status='all',sort='recent',query=''}={}){
  const term=String(query||'').trim().toLocaleLowerCase();
  const result=rows.filter(row=>(status==='all'||row.status===status) &&
    (!term||`${row.name} ${row.note} ${row.developer} ${row.primary_category}`.toLocaleLowerCase().includes(term)));
  // Stable sort: the original save order resolves same-day ties.
  if(sort==='oldest')result.sort((a,b)=>a.added_at.localeCompare(b.added_at));
  else if(sort==='name')result.sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  else if(sort==='status')result.sort((a,b)=>FAVORITE_STATUSES.indexOf(a.status)-FAVORITE_STATUSES.indexOf(b.status));
  else result.sort((a,b)=>b.added_at.localeCompare(a.added_at));
  return result;
}
export function exportFavorites(){
  const content=JSON.stringify({version:1,exported_at:new Date().toISOString(),favorites:getFavorites()},null,2);
  const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`app-trend-관심목록-${new Date().toISOString().slice(0,10)}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function importFavorites(file){
  if(!file||file.size>2_000_000)throw new Error('백업 파일이 너무 큽니다.');
  const raw=JSON.parse(await file.text());
  if(raw?.version!==1||!Array.isArray(raw.favorites)||raw.favorites.length>5000)throw new Error('지원하지 않는 관심 목록 파일입니다.');
  const merged=new Map(getFavorites().map(item=>[item.app_key,item]));
  const incoming=combineFavorites(raw.favorites);
  for(const obj of incoming){
    const prev=merged.get(obj.app_key);
    for(const field of ['detail_url','icon_url','developer','kind','primary_category','first_seen']){
      if(prev&&!obj[field])obj[field]=prev[field];
    }
    // When importing a different store's legacy key, retain both notes.
    const differentStore=raw.favorites.some(value=>
      typeof value?.app_key==='string'&&value.app_key!==obj.app_key&&
      canonicalKey(value.app_key)===obj.app_key);
    merged.set(obj.app_key,prev&&differentStore?mergeRows(prev,obj):obj);
  }
  const rows=combineFavorites([...merged.values()]);persist(rows);return rows.length;
}
