// Regression checks for homepage and non-Lab chart views (real collected JSON).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.location={hash:'#/home'};
globalThis.window={location,dispatchEvent(){}};
globalThis.document={getElementById(){return null},querySelectorAll(){return []}};
globalThis.fetch=async url=>{
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch {return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {renderHome,renderExplore,renderIndie,availableExploreCategories,normalizeExploreCategory}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const base=()=>({country:'US',source:'google',price:'top_free',category:'all_apps',sort:'popular',limit:30,feed:'featured',range:30,query:'',filtersOpen:false,detailContext:{}});
let home=renderHome(base());
assert.match(home,/오늘의 앱·게임 흐름/);
assert.match(home,/수집 자료 현황/);
assert.match(home,/home-status-button/);
assert.match(home,/요청 실패/);
assert.match(home,/수집 미지원/);
assert.match(home,/App Store/);
assert.match(home,/Google Play/);
assert.match(home,/앱에서 발견/);
assert.match(home,/게임에서 발견/);
assert.ok((home.match(/home-candidate/g)||[]).length>=2,'at least one observed candidate for apps and games');
// Changing country to ALL must not silently show US-only charts.
home=renderHome({...base(),country:'ALL'});
for (const country of ['미국','일본','한국']) assert.ok(home.includes(country),`all-country homepage must show ${country}`);
assert.equal((home.match(/class="panel home-mini"/g)||[]).length,12,'three countries × two types × two stores');
// Paid charts exist only for all_apps/all_games; no false empty-results when switching from puzzle.
let ui={...base(),category:'game_puzzle',price:'top_paid'};
assert.deepEqual(availableExploreCategories('game',ui),['all_games']);
assert.equal(normalizeExploreCategory('game',ui),'all_games');
let markup=renderExplore('game',ui);
assert.ok(markup.includes('전체 게임 유료 순위'));
assert.ok(markup.includes('Loop') || markup.includes('App Store') || markup.includes('Google Play'));
assert.ok(!markup.includes('<option value="game_puzzle"'));
ui={...base(),category:'app_lifestyle',price:'top_paid'};
assert.equal(normalizeExploreCategory('app',ui),'all_apps');
markup=renderExplore('app',ui);
assert.ok(markup.includes('전체 앱 유료 순위'));
assert.ok(!markup.includes('<option value="app_lifestyle"'));
// Failed collection retains a dated previous successful chart, and never labels it current.
const failedGroup=store.groups.find(g=>g.source==='apple'&&g.category==='all_apps'&&g.chart==='top_paid'&&g.is_stale);
assert(failedGroup,'at least one failed source uses a previous snapshot in test data');
ui={...base(),country:failedGroup.country,source:'apple',price:'top_paid',category:'all_apps'};
markup=renderExplore('app',ui);
assert.ok(markup.includes('이전 정상 기록'));
assert.ok(markup.includes(failedGroup.data_date.replaceAll('-','.')));
assert.ok(markup.includes('최근 수집이 실패'));
// Apple arcade is skipped by configuration; omit unavailable category from Apple-only dropdown.
ui={...base(),country:'KR',source:'apple',category:'all_games'};
assert.ok(!availableExploreCategories('game',ui).includes('game_arcade'));
ui.source='google';
assert.ok(availableExploreCategories('game',ui).includes('game_arcade'));
// Cross-route search cannot hide rows in apps, games or indie views.
for(const [kind,category] of [['app','all_apps'],['game','all_games']]){
  const standard=renderExplore(kind,{...base(),category});
  const poisoned=renderExplore(kind,{...base(),category,query:'unmatched-unique-phrase-123456789'});
  assert.equal(poisoned,standard,`global search leaking into ${kind} exploration`);
}
assert.equal(renderIndie(base()),renderIndie({...base(),query:'unmatched-unique-phrase-123456789'}));
// "consistent" candidates must be supported by the SAME country, store, chart, category.
const testGroup=store.groups.find(g=>g.source==='google'&&g.country==='US'&&g.category==='all_apps'&&g.chart==='top_free'&&g.items.length);
assert.ok(testGroup);
const testItem=testGroup.items[0];
const old=store.candidates.get(testItem.app_key);
try{
  store.candidates.set(testItem.app_key,[{reason_code:'consistent_30d',evidence:{source:'google',country:'JP',category:'all_apps',chart:'top_free'}}]);
  let s=renderExplore('app',{...base(),sort:'consistent'});
  assert.ok(s.includes('꾸준한 관측'));
  // Direct test by isolating group items temporarily (restored immediately).
  const copy=testGroup.items;testGroup.items=[testItem];
  try{
    s=renderExplore('app',{...base(),sort:'consistent'});
    assert.ok(s.includes('꾸준한 관측 기록이 없습니다'), 'other-country signal should not match');
    store.candidates.set(testItem.app_key,[{reason_code:'consistent_30d',evidence:{source:'google',country:'US',category:'all_apps',chart:'top_free'}}]);
    s=renderExplore('app',{...base(),sort:'consistent'});
    assert.ok(!s.includes('꾸준한 관측 기록이 없습니다'), 'same-chart signal should match');
  }finally{testGroup.items=copy;}
}finally{if(old)store.candidates.set(testItem.app_key,old);else store.candidates.delete(testItem.app_key);}
console.log('[main v1.13] home, source/date/status, paid category, search isolation, same-chart signals OK');
