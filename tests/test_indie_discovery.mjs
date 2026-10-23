import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.location={hash:'#/indie'};
globalThis.window={location,dispatchEvent(){}};
globalThis.document={getElementById(){return null},querySelectorAll(){return []}};
globalThis.fetch=async url=>{
  try {return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch {return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {renderIndie,renderIndieResults,indieCatalog,indieDisplayName,availableIndieFeeds,renderExplore,renderHome}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const ui=()=>({country:'US',source:'google',price:'top_free',category:'all_apps',sort:'popular',limit:30,feed:'all',range:30,query:'',filtersOpen:false,indieQuery:'',indieSort:'feed',indieLimit:30,detailContext:{}});
const feeds=['featured','new','puzzle','idle'];
const expected=new Set(store.groups.filter(g=>g.source==='itch').flatMap(g=>(g.items||[]).map(x=>x.app_key)));
const all=indieCatalog(ui());
assert.equal(all.total,expected.size,'all-feed catalog must union by app_key');
assert.equal(new Set(all.rows.map(x=>x.item.app_key)).size,all.rows.length,'no duplicates in the result');
assert.equal(all.rows.length,expected.size,'no search must display every actual indie game');
assert.ok(all.rows.some(x=>x.feeds.length>1),'overlapping feeds must be kept as labeled multiple sources');
let html=renderIndie(ui());
assert.match(html,/전체 인디/);
assert.match(html,/indie-list-row/);
assert.match(html,/indie-list-image/);
assert.match(html,/indie-list-summary/);
assert.match(html,/첫 관측/);
assert.match(html,/인기 순위가 아닙니다/);
assert.match(html,/data-indie-query/);
assert.match(html,/data-indie-sort/);
assert.match(html,/더 보기/);
assert.equal((html.match(/class="indie-list-row"/g)||[]).length,30,'paged instead of huge unbounded cards');
assert.ok(!html.includes('class="indie-grid"'),'main indie page should not use oversized card grid');
assert.deepEqual(availableIndieFeeds(),feeds);
// Future itch feeds appear automatically without changing UI code.
const added={source:'itch',country:'GLOBAL',feed:'cozy',data_date:store.latest.data_date,items:[{app_key:'itch:future-cozy-demo',name:'Cozy Future [Free]',description:'A future cozy game',icon_url:'',first_seen:store.latest.data_date}]};
store.groups.push(added);
try{
  assert.ok(availableIndieFeeds().includes('cozy'));
  assert.ok(renderIndie(ui()).includes('data-feed="cozy"'));
  assert.equal(indieCatalog(ui()).total,expected.size+1);
}finally{store.groups.pop();}

for(const feed of feeds){
  const state={...ui(),feed};
  const source=store.groups.find(g=>g.source==='itch'&&g.feed===feed);
  assert.equal(indieCatalog(state).rows.length,source.items.length,`feed ${feed} count`);
  assert.match(renderIndie(state),new RegExp(`data-feed="${feed}" aria-pressed="true"`));
}
let state={...ui(),indieLimit:1000};
assert.equal((renderIndieResults(state).match(/class="indie-list-row"/g)||[]).length,expected.size,'more must page through all items');
// Search the actual game name and original description (not the header global search).
const sample=all.rows.find(x=>x.item.description?.length>20&&x.item.name?.length>7);
assert.ok(sample);
state={...ui(),indieQuery:sample.item.name.slice(0,8)};
assert.ok(indieCatalog(state).rows.some(x=>x.item.app_key===sample.item.app_key));
state={...ui(),indieQuery:sample.item.description.slice(0,12)};
assert.ok(indieCatalog(state).rows.some(x=>x.item.app_key===sample.item.app_key));
const ignoredGlobal=renderIndie({...ui(),query:'__UNRELATED_GLOBAL_SEARCH_2345271'});
assert.equal(ignoredGlobal,html,'global search must not silently change indie results');
state={...ui(),indieQuery:'_NOT_EXIST_ANYWHERE_909372'};
assert.equal(indieCatalog(state).rows.length,0);
assert.match(renderIndieResults(state),/해당하는 인디 게임이 없습니다/);
assert.deepEqual(indieCatalog({...ui(),indieSort:'name'}).rows.map(x=>x.item.app_key).slice().sort(),[...expected].sort());
const dated=indieCatalog({...ui(),indieSort:'recent'}).rows.map(x=>x.item.first_seen||'');
assert.deepEqual(dated,[...dated].sort().reverse(),'recent observation must sort by stored first_seen');
const parsed=indieDisplayName('Hello Game [Free] [Puzzle] [Windows]');
assert.equal(parsed.name,'Hello Game');
assert.deepEqual(parsed.metadata,['Free','Puzzle','Windows']);
assert.equal(indieDisplayName('A Game [Chapter 1]').name,'A Game [Chapter 1]','unknown brackets are part of a name');
// Escape user-provided catalog text without removing it from the source data.
const group=store.groups.find(g=>g.source==='itch'&&g.feed==='featured');
const original=group.items[0];
try{
  group.items[0]={...original,name:'<img src=x onerror=alert(1)> [Free]',description:'<script>alert(1)</script>'};
  state={...ui(),feed:'featured'};
  const escaped=renderIndieResults(state);
  assert.ok(escaped.includes('&lt;img'));
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.ok(!escaped.includes('<script>alert(1)</script>'));
}finally{group.items[0]=original;}
// Legacy screens continue using their existing renders.
assert.match(renderExplore('app',ui()),/rank-table/);
assert.match(renderHome(ui()),/인디에서 발견/);
console.log(`[indie v1.15] ${expected.size} real distinct games, 4 feeds, search, sort, pagination, metadata, escaping, other views OK`);
