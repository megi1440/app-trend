// Regression: local-only favorite management, legacy backups, and aging records.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.window={dispatchEvent(){}};
globalThis.location={hash:'#/favorites'};
globalThis.document={getElementById(){return null},querySelectorAll(){return []}};
globalThis.fetch=async url=>{
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const fav=await import(pathToFileURL(path.join(root,'web/js/favorites.js')).href);
const {renderFavorites,renderDetail}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const key='app-trend:favorites:v1';
const known=[...store.appMap.values()].find(x=>x.detail_url && x.icon_url && x.name && x.app_key);
assert.ok(known,'need a collected item with a real URL and image');
// An old v1 record has only name, source, note, status and date.
const older={app_key:known.app_key,name:known.name,source:known.app_key.split(':')[0],note:'지난번 연구한 아이디어',status:'살펴보는 중',added_at:'2026-10-22'};
const oldKey='itch:removed-old-game';
localStorage.setItem(key,JSON.stringify([older,{app_key:oldKey,name:'예전 인디 게임',source:'itch',note:'메모는 반드시 남아야 함',status:'관심',added_at:'2026-10-12'}]));
assert.equal(fav.getFavorites().length,2,'legacy favorites still supported');
assert.equal(fav.refreshFavoriteSnapshots(store.appMap),true,'upgrades legacy metadata from current real app');
const migrated=fav.getFavorite(known.app_key);
assert.equal(migrated.detail_url,known.detail_url);
assert.equal(migrated.icon_url,known.icon_url);
assert.equal(migrated.note,older.note);
assert.equal(migrated.added_at,older.added_at);
assert.equal(fav.refreshFavoriteSnapshots(store.appMap),false,'no unnecessary repeated saves');
// Once the current charts omit an app, its saved snapshot is still usable.
const savedMap=store.appMap,savedRefs=store.refs;
store.refs=new Map([...savedRefs].filter(([k])=>k!==known.app_key));
store.appMap=new Map([...savedMap].filter(([k])=>k!==known.app_key));
try{
  const html=renderFavorites({favoriteStatus:'all',favoriteSort:'recent',favoriteLimit:30});
  assert.match(html,/최신 목록 밖/);
  assert.match(html,/예전 인디 게임/);
  assert.ok(html.includes('원본 페이지 ↗'),'historical candidate keeps known URL');
  const detail=renderDetail(known.app_key,{detailContext:{},range:30});
  assert.match(detail,/지난번 연구한 아이디어/);
  assert.ok(detail.includes('원본 스토어'));
  assert.match(detail,/현재 차트에 없음/);
}finally{store.appMap=savedMap;store.refs=savedRefs;}
let html=renderFavorites({favoriteStatus:'all',favoriteLimit:30});
assert.match(html,/검토 상태/);
assert.match(html,/JSON 백업/);
assert.match(html,/JSON 가져오기/);
assert.match(html,/data-favorite-query/);
assert.match(html,/data-favorite-sort/);
assert.match(html,/data-favorite-status/);
assert.match(html,/보류/);
assert.match(html,/아이디어 노트/);
assert.equal((html.match(/class="fav-list-row"/g)||[]).length,2);
const filtered=renderFavorites({favoriteStatus:'살펴보는 중',favoriteLimit:30});
assert.ok(filtered.includes(known.name));
assert.ok(!filtered.includes('예전 인디 게임'));
assert.match(renderFavorites({favoriteQuery:'메모는 반드시',favoriteLimit:30}),/예전 인디 게임/);
assert.match(renderFavorites({favoriteQuery:'NOT-A-KNOWN-NAME-999',favoriteLimit:30}),/조건에 맞는 저장 후보가 없습니다/);
// Direct status editing never erases notes or the record snapshot.
assert.equal(fav.updateFavorite(oldKey,{status:'보류'}),true);
assert.equal(fav.getFavorite(oldKey).status,'보류');
assert.equal(fav.getFavorite(oldKey).note,'메모는 반드시 남아야 함');
assert.match(renderFavorites({favoriteStatus:'보류',favoriteLimit:30}),/예전 인디 게임/);
// Saving a new app keeps the original store link, never creates a ranking.
const next=[...store.appMap.values()].find(x=>x.app_key!==known.app_key && x.detail_url && x.icon_url);
assert.equal(fav.toggleFavorite(next),true);
assert.equal(fav.getFavorite(next.app_key).detail_url,next.detail_url);
assert.ok(!('rank' in fav.getFavorite(next.app_key)));
assert.equal(fav.toggleFavorite(next),false);
// Escape imported strings and reject unsafe URLs.
const evil={app_key:'itch:unsafe',name:'<img src=x onerror=alert(1)>',note:'<script>alert(1)</script>',detail_url:'javascript:alert(1)',icon_url:'data:text/html,evil',status:'개발 후보'};
const imported={version:1,favorites:[evil]};
const text=JSON.stringify(imported);
assert.equal(await fav.importFavorites({size:text.length,text:async()=>text}),3);
assert.equal(fav.getFavorite('itch:unsafe').detail_url,'');
assert.equal(fav.getFavorite('itch:unsafe').icon_url,'');
html=renderFavorites({favoriteStatus:'개발 후보',favoriteLimit:30});
assert.ok(html.includes('&lt;img'));
assert.ok(html.includes('&lt;script&gt;'));
assert.ok(!html.includes('<script>alert(1)</script>'));
// Re-import an old v1 backup must not wipe the richer snapshot.
const olderBackup=JSON.stringify({version:1,favorites:[older]});
await fav.importFavorites({size:olderBackup.length,text:async()=>olderBackup});
assert.equal(fav.getFavorite(known.app_key).detail_url,known.detail_url);
assert.equal(fav.getFavorite(known.app_key).note,older.note);
// Pagination and ordering use the full saved list, not only loaded chart rows.
const sample=[...store.appMap.values()].filter(x=>x.app_key!==known.app_key).slice(0,32);
for(const item of sample)fav.toggleFavorite(item);
html=renderFavorites({favoriteStatus:'all',favoriteLimit:30});
assert.equal((html.match(/class="fav-list-row"/g)||[]).length,30);
assert.match(html,/data-favorite-more/);
html=renderFavorites({favoriteStatus:'all',favoriteLimit:120});
assert.equal((html.match(/class="fav-list-row"/g)||[]).length,fav.getFavorites().length);
const all=fav.getFavorites();
assert.equal(fav.filterFavorites(all,{sort:'name'}).length,all.length);
assert.ok(all.every(x=>x.status && x.name));
console.log(`[favorites v1.16] legacy migration, status, search, sorting, age-safe links, escaping, backup, pagination, ${all.length} saved rows OK`);
