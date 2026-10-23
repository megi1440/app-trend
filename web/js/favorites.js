// Personal data remains in the browser. Version 1 backups remain readable.
const KEY='app-trend:favorites:v1';
export const FAVORITE_STATUSES=['관심','살펴보는 중','개발 후보','보류'];
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
    note:cleanText(entry.note,3000),
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
    if(!Array.isArray(raw))return [];
    const seen=new Set();
    return raw.map(normalizeFavorite).filter(item=>{
      if(!item||seen.has(item.app_key))return false;
      seen.add(item.app_key);return true;
    });
  }catch{return [];}
}
function persist(rows){localStorage.setItem(KEY,JSON.stringify(rows));window.dispatchEvent(new Event('favorites-updated'));}
export const hasFavorite=key=>getFavorites().some(item=>item.app_key===key);
export const getFavorite=key=>getFavorites().find(item=>item.app_key===key);
export function toggleFavorite(item){
  if(!item||!item.app_key)return false;
  const rows=getFavorites(),idx=rows.findIndex(r=>r.app_key===item.app_key);
  if(idx>=0){rows.splice(idx,1);persist(rows);return false;}
  const normalized=normalizeFavorite({...item,source:item.source||item.app_key.split(':')[0],note:'',status:'관심'});
  if(!normalized)return false;
  rows.unshift(normalized);persist(rows);return true;
}
export function updateFavorite(key,attrs){
  const rows=getFavorites(),idx=rows.findIndex(r=>r.app_key===key);
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
  for(const value of raw.favorites){
    const obj=normalizeFavorite(value);
    if(obj){
      // Older backups may lack snapshots. Don't erase known URLs or images.
      const prev=merged.get(obj.app_key);
      if(prev)for(const field of ['detail_url','icon_url','developer','kind','primary_category','first_seen'])if(!obj[field])obj[field]=prev[field];
      merged.set(obj.app_key,obj);
    }
  }
  persist([...merged.values()]);return merged.size;
}
