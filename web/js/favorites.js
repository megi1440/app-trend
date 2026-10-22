const KEY='app-trend:favorites:v1';
function normalize(entry) {
  if (!entry || typeof entry!=='object' || typeof entry.app_key!=='string' || entry.app_key.length>220) return null;
  const status = ['관심','살펴보는 중','개발 후보'].includes(entry.status) ? entry.status : '관심';
  return {
    app_key:entry.app_key, name:String(entry.name||entry.app_key).slice(0,200),
    source:String(entry.source||'').slice(0,30), note:String(entry.note||'').slice(0,3000),
    status, added_at: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.added_at)) ? entry.added_at : new Date().toISOString().slice(0,10)
  };
}
export function getFavorites() {
  try { const raw=JSON.parse(localStorage.getItem(KEY)||'[]'); return Array.isArray(raw)?raw.map(normalize).filter(Boolean):[]; }
  catch { return []; }
}
function persist(rows) { localStorage.setItem(KEY,JSON.stringify(rows)); window.dispatchEvent(new Event('favorites-updated')); }
export function hasFavorite(key) { return getFavorites().some(r=>r.app_key===key); }
export function getFavorite(key) { return getFavorites().find(r=>r.app_key===key); }
export function toggleFavorite(item) {
  const rows=getFavorites(), idx=rows.findIndex(r=>r.app_key===item.app_key);
  if(idx>=0){rows.splice(idx,1);persist(rows);return false;}
  rows.unshift(normalize({app_key:item.app_key,name:item.name,source:item.app_key.split(':')[0],note:'',status:'관심'}));
  persist(rows);return true;
}
export function updateFavorite(key, attrs) {
  const rows=getFavorites(), idx=rows.findIndex(r=>r.app_key===key);
  if(idx<0)return false;
  rows[idx]=normalize({...rows[idx],...attrs,app_key:key});persist(rows);return true;
}
export function exportFavorites() {
  const content=JSON.stringify({version:1,exported_at:new Date().toISOString(),favorites:getFavorites()},null,2);
  const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`app-trend-관심목록-${new Date().toISOString().slice(0,10)}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function importFavorites(file) {
  if (!file || file.size>2_000_000) throw new Error('백업 파일이 너무 큽니다.');
  const raw=JSON.parse(await file.text());
  if(raw?.version!==1||!Array.isArray(raw.favorites)||raw.favorites.length>5000) throw new Error('지원하지 않는 관심 목록 파일입니다.');
  const merged=new Map(getFavorites().map(item=>[item.app_key,item]));
  for(const value of raw.favorites){const obj=normalize(value);if(obj)merged.set(obj.app_key,obj);}
  persist([...merged.values()]);return merged.size;
}
