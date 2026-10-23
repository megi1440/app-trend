// V1.18 — stale bookmark safety, research index membership and bidirectional routes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
globalThis.sessionStorage=localStorage;
let failFirstLab=true, labAttempts=0;
globalThis.fetch=async url=>{
  if(String(url).includes('data/lab/index.json')){
    labAttempts++;
    if(failFirstLab){failFirstLab=false;return {ok:false,status:503,json:async()=>({})};}
  }
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot,detailsHref}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {renderFavorites,renderDetail}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
const fav=await import(pathToFileURL(path.join(root,'web/js/favorites.js')).href);
await loadSnapshot();
const labData=JSON.parse(await fs.readFile(path.join(root,'data/lab/index.json'),'utf8'));
const inLab=new Set(labData.items.map(item=>item.app_key));
const known=[...store.appMap.values()].find(item=>inLab.has(item.app_key)&&item.detail_url);
assert.ok(known);
const oldKey='itch:stale-local-favorite-not-in-lab-index';
assert.ok(!inLab.has(oldKey));
localStorage.setItem('app-trend:favorites:v1',JSON.stringify([
  {app_key:known.app_key,name:known.name,source:known.app_key.split(':')[0],status:'살펴보는 중',note:'미완성 연구 메모',added_at:'2026-10-22',detail_url:known.detail_url},
  {app_key:oldKey,name:'예전 저장 후보',source:'itch',status:'개발 후보',note:'유실되면 안 되는 메모',added_at:'2026-10-12',detail_url:'https://sample.itch.io/oldgame'}
]));
const routeHTML=status=>renderFavorites({favoriteStatus:'all',favoriteLimit:30,labAvailability:status});
const loading=routeHTML({status:'loading',keys:null});
assert.match(loading,/연구실 후보 확인 중/);
assert.ok(!loading.includes('data-lab-action="toggle-compare"'));
const errored=routeHTML({status:'error',keys:null});
assert.match(errored,/연구실 연결 확인 실패/);
assert.match(errored,/data-retry-lab-availability="true"/);
const ready=routeHTML({status:'ready',keys:inLab});
assert.match(ready,/연구실 자료 없음 · 비교 불가/);
assert.equal((ready.match(/data-lab-action="toggle-compare"/g)||[]).length,1,'only actual index member may be compared');
assert.ok(!ready.includes(`data-key="${oldKey}"`));
assert.match(ready,/#\/detail\/[^" ]+\?from=favorites/);
const oldDetail=renderDetail(oldKey,{detailFrom:'favorites',range:30,detailContext:{},labAvailability:{status:'ready',keys:inLab}});
assert.match(oldDetail,/#\/favorites">← 관심 목록으로 돌아가기/);
assert.match(oldDetail,/유실되면 안 되는 메모/);
assert.match(oldDetail,/https:\/\/sample\.itch\.io\/oldgame/);
assert.ok(!oldDetail.includes('data-lab-action="toggle-compare"'));
assert.match(renderDetail(known.app_key,{detailFrom:'lab',detailLabTab:'features',range:30,detailContext:{},labAvailability:{status:'ready',keys:inLab}}),/#\/lab\/features">← 아이디어 연구실로 돌아가기/);
assert.equal(new URLSearchParams(detailsHref(known.app_key,{source:'apple',from:'lab',labtab:'compare'}).split('?')[1]).get('labtab'),'compare');

// Exercise the actual app controller, including a failed lab request and manual retry.
const klass={add(){},remove(){},toggle(){},contains(){return true;}};
const el=()=>({innerHTML:'',textContent:'',value:'',classList:klass,addEventListener(){},setAttribute(){},focus(){},style:{}});
const elements={main:el(),overlay:el(),'global-search':el(),toast:el(),'footer-date':el(),'status-label':el()};
const events={},winEvents={};
globalThis.location={hash:'#/favorites'};
globalThis.window={location,scrollY:138,addEventListener:(event,fn)=>{winEvents[event]=fn;},dispatchEvent(){},scrollTo(...args){this.scrollY=typeof args[0]==='object'?args[0].top:args[1]}};
globalThis.document={getElementById:id=>elements[id]||null,querySelectorAll:()=>[],querySelector:()=>({classList:klass}),addEventListener:(event,fn)=>{events[event]=fn;},activeElement:null};
await import(pathToFileURL(path.join(root,'web/js/app.js')).href);
const waitFor=async fn=>{for(let i=0;i<140;i++){if(fn())return;await new Promise(done=>setTimeout(done,7));}throw Error('async app did not reach expected state')};
await waitFor(()=>elements.main.innerHTML.includes('연구실 연결 확인 실패'));
assert.equal(labAttempts,1);
const click=async (selector,dataset={})=>events.click({target:{closest:()=>({dataset,matches:s=>s===selector,id:''})},preventDefault(){}});
await click('[data-retry-lab-availability]');
await waitFor(()=>elements.main.innerHTML.includes('연구실 자료 없음 · 비교 불가'));
assert.equal(labAttempts,2);
assert.equal(window.scrollY,138,'async check preserves scroll');
await click('[data-lab-action]',{labAction:'toggle-compare',key:oldKey});
assert.match(elements.toast.textContent,/연구실에 없는 후보/);
const detailHash=detailsHref(known.app_key,{from:'favorites'});
location.hash=detailHash;winEvents.hashchange();
assert.match(elements.main.innerHTML,/#\/favorites">← 관심 목록으로 돌아가기/);
const current=store.refs.get(known.app_key)||[];
if(current[0]){
  events.change({target:{id:'detail-context',value:[current[0].group.country,current[0].group.source,current[0].group.chart,current[0].group.category].join('|'),matches:()=>false}});
  assert.ok(location.hash.includes('from=favorites'),'chart selector must retain the originating menu');
}
// Links from a lab tab must keep the tab when opening details and changing chart.
const lab=await import(pathToFileURL(path.join(root,'web/js/lab.js')).href);
location.hash='#/lab/compare';
const labHTML=lab.renderLab('compare',new URLSearchParams());
// The detail URL factory works for all lab tabs (lab may have no compare selections).
location.hash=detailsHref(known.app_key,{from:'lab',labtab:'compare'});winEvents.hashchange();
assert.match(elements.main.innerHTML,/#\/lab\/compare">← 아이디어 연구실로 돌아가기/);
assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('from'),'lab');
assert.ok(labHTML.includes('후보 비교'));
console.log('[V1.18] old favorites and notes preserved, verified lab membership, failed-then-retried index, context routes OK');
