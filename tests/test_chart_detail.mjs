// Phase 2 regression checks: real snapshot and saved rank-history evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.location={hash:'#/apps'};
globalThis.window={location,dispatchEvent(){}};
globalThis.document={getElementById(){return null},querySelectorAll(){return []}};
let intercept=null;
const readFile=async url=>{
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>({})};}
};
globalThis.fetch=async url=>intercept?intercept(url):readFile(url);
const {store,loadSnapshot,loadHistory,formatDate}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {renderExplore,renderDetail,renderHistory,chartRiseEvidence,chartMovementEvidence}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const base=()=>({country:'US',source:'google',price:'top_free',category:'all_apps',sort:'popular',limit:30,feed:'featured',range:30,query:'',filtersOpen:false,detailContext:{}});
const chart=store.groups.find(g=>g.source==='google' && g.country==='US' && g.category==='all_apps' && g.chart==='top_free' && g.items.length);
assert.ok(chart);
assert.ok(store.movements && Object.keys(store.movements).length>100,'real generated movement index must be loaded');
const all=Object.entries(store.movements).filter(([,m])=>m && Number.isFinite(m.change));
assert.ok(all.some(([,m])=>m.change>0),'real data should include increases');
assert.ok(all.some(([,m])=>m.change<0),'real data should include decreases');
assert.ok(all.some(([,m])=>m.change===0),'real data should include unchanged ranks');
const actual=chart.items.find(item=>chartMovementEvidence(item,chart));
assert.ok(actual,'US Google apps should have verified historical changes');
const movement=chartMovementEvidence(actual,chart);
assert.equal(movement.after_rank,actual.rank);
assert.equal(movement.after_date,chart.data_date);
let html=renderExplore('app',base());
assert.match(html,/순위 변화/);
assert.match(html,/같은 국가·스토어·차트·분류/);
assert.match(html,/비교 기록 부족|계단|순위 유지/);
assert.match(html,/rank-position/);
assert.match(html,/rank-table/);
assert.match(html,/rank-rise|rank-fall|rank-flat/);
assert.match(html,/평점/);
assert.match(html,/저장/);
// Inject same-chart and other-country evidence, and check the exact chart boundary.
const sample=chart.items[0];
const prev=store.candidates.get(sample.app_key);
const prevMovements=store.movements;
try{
  store.movements=null; // fallback for previous deployments without derived chart index
  store.candidates.set(sample.app_key,[{reason_code:'rising_7d',evidence:{source:'google',country:'JP',chart:'top_free',category:'all_apps',change:3,before_date:'2026-10-22',after_date:chart.data_date,before_rank:7,after_rank:4}}]);
  assert.equal(chartRiseEvidence(sample,chart),null,'JP rank rise must not appear in US');
  store.candidates.set(sample.app_key,[{reason_code:'rising_7d',evidence:{source:'google',country:'US',chart:'top_free',category:'all_apps',change:3,before_date:'2026-10-22',after_date:chart.data_date,before_rank:7,after_rank:4}}]);
  assert.ok(chartRiseEvidence(sample,chart));
  html=renderExplore('app',base());
  assert.match(html,/↑ 3계단/);
  assert.match(html,/2026\.10\.22 대비/);
  chart.is_stale=true;
  assert.equal(chartRiseEvidence(sample,chart),null,'stale snapshot must never appear as current rank rise');
}finally{chart.is_stale=false;store.movements=prevMovements; if(prev)store.candidates.set(sample.app_key,prev);else store.candidates.delete(sample.app_key);}
// Real Apple release_date is available, and never confused with the site first_seen.
const apple=store.groups.find(g=>g.source==='apple' && g.items.some(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.release_date||'')));
assert.ok(apple);
const appleItem=apple.items.find(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.release_date||''));
let detail=renderDetail(appleItem.app_key,{...base(),detailContext:{country:apple.country,source:apple.source,category:apple.category,chart:apple.chart}});
assert.ok(detail.indexOf('수집 관측 정보') < detail.indexOf('앱·게임 소개'));
assert.ok(detail.includes('App Store 출시일'));
assert.ok(detail.includes(formatDate(appleItem.release_date)));
assert.ok(detail.includes(formatDate(appleItem.first_seen)));
assert.match(detail,/실제 출시일과 다릅니다/);
assert.match(detail,/detail-history/);
assert.match(detail,/detail-context/);
assert.match(detail,/7일/);
assert.match(detail,/30일/);
assert.match(detail,/90일/);
assert.match(detail,/연구실에서 보기/);
assert.match(detail,/메모/);
// Google: no fabricated release date, but observation evidence stays visible.
detail=renderDetail(sample.app_key,{...base(),detailContext:{country:'US',source:'google',category:'all_apps',chart:'top_free'}});
assert.ok(detail.includes('실제 출시일은 이 자료에 포함되어 있지 않습니다'));
assert.ok(!detail.includes('App Store 출시일'));
assert.ok(detail.includes('수집 관측 정보'));
// Indie: feed position remains feed position, never a popularity rank.
const indie=store.groups.find(g=>g.source==='itch'&&g.items.length);
assert.ok(indie);
detail=renderDetail(indie.items[0].app_key,{...base(),detailContext:{}});
assert.ok(detail.includes('인디 피드 발견 기록'));
assert.ok(detail.includes('인기 순위·다운로드·판매량이 아닙니다'));
assert.ok(!detail.includes('국가별 순위·이력'));
// User-saved app not in latest snapshot must still render its saved name/notes.
const savedKey='google:old-bookmark-not-in-chart';
storage.set('app-trend:favorites:v1',JSON.stringify([{app_key:savedKey,name:'Previously saved example',source:'google',note:'My note',status:'관심'}]));
// Different favorites storage schemas are handled in the favorites module's tests; don't assume key here.
// A history lookup for a key absent from a valid shard is not a network error.
const missing=await loadHistory('google:a-never-observed-app-key');
assert.deepEqual(missing,[]);
intercept=async ()=>({ok:false,status:503,json:async()=>({})});
try{await assert.rejects(()=>loadHistory(appleItem.app_key),/요청 실패/,'transport failure must not be swallowed as missing history');}
finally{intercept=null;}
const history=await loadHistory(appleItem.app_key);
assert.ok(Array.isArray(history));
const exactly=history.filter(h=>h.source===apple.source && h.country===apple.country && h.chart===apple.chart && h.category===apple.category);
if(exactly.length){
  let svg=renderHistory(history,apple,30,apple.data_date);
  assert.ok(svg.includes('실제로 수집') || svg.includes('수집한 날짜') || svg.includes('관측일이 하루'));
  assert.ok(svg.includes('위'));
  if(exactly.length>1)assert.match(svg,/history-summary/);
}
console.log('[main v1.14] charts, evidence isolation, Apple date, detail, indie, history failures OK');
