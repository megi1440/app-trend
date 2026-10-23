// V1.17 regression: exact-chart home rises, per-chart pagination,
// indie-detail return route and retention of indie filter state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.fetch=async url=>{
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {homeCandidates,renderHome,renderExplore,renderIndie,renderDetail,
  exploreGroupKey,exploreGroupLimit,chartMovementEvidence}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const u=()=>({country:'ALL',source:'all',price:'top_free',category:'all_apps',sort:'popular',
  groupLimits:{},feed:'all',range:30,indieQuery:'',indieSort:'feed',indieLimit:30,detailContext:{}});
for(const country of ['US','JP','KR','ALL'])for(const kind of ['app','game']){
  const rows=homeCandidates(kind,country);
  assert.ok(rows.length<=3);
  assert.equal(new Set(rows.map(x=>x.item.app_key)).size,rows.length);
  for(const row of rows){
    assert.equal(row.group.data_date,store.latest.data_date);
    assert.equal(row.group.is_stale,false);
    if(country!=='ALL')assert.equal(row.group.country,country);
    if(row.candidate.reason_code==='rising_7d'){
      const evidence=chartMovementEvidence(row.item,row.group);
      assert.ok(evidence && evidence.change>0,'home rise must come from actual previous/current chart observations');
      assert.deepEqual(row.candidate.evidence,evidence);
      assert.equal(evidence.after_rank,row.item.rank);
    }
    if(row.candidate.reason_code==='newly_seen')assert.equal(row.item.first_seen,store.latest.data_date);
  }
}
assert.ok(homeCandidates('app','US').some(x=>x.candidate.reason_code==='rising_7d'));
assert.match(renderHome(u()),/실제 순위 상승/);
// A rise supported only by another country must not enter a country-only homepage.
const oldMovements=store.movements;
try{
  store.movements=Object.fromEntries(Object.entries(oldMovements).filter(([key,m])=>{
    const parts=key.split('|');return parts[2]!=='US'||Number(m.change)<=0;
  }));
  assert.ok(!homeCandidates('app','US').some(x=>x.candidate.reason_code==='rising_7d'));
  assert.ok(!homeCandidates('game','US').some(x=>x.candidate.reason_code==='rising_7d'));
}finally{store.movements=oldMovements;}
// Charts must remain independent even across three countries and two stores.
const ui=u();const html=renderExplore('app',ui);
const firstKey=html.match(/data-more="true" data-group="([^"]+)"/)?.[1];
assert.ok(firstKey,'at least one group with more than 30 observations');
const charts=store.groups.filter(g=>g.category==='all_apps'&&g.chart==='top_free'&&g.source!=='itch');
const target=charts.find(g=>exploreGroupKey(g)===firstKey);
const another=charts.find(g=>exploreGroupKey(g)!==firstKey);
assert.ok(target&&another);
assert.equal(exploreGroupLimit(ui,target),30);
assert.equal(exploreGroupLimit(ui,another),30);
ui.groupLimits[firstKey]=60;
assert.equal(exploreGroupLimit(ui,target),60);
assert.equal(exploreGroupLimit(ui,another),30);
const changed=renderExplore('app',ui);
assert.match(changed,new RegExp(`data-group="${firstKey.replace(/[|]/g,'\\|')}"`));
// Indie list links mark their origin; homepage links mark home origin.
const indie=store.groups.find(g=>g.source==='itch'&&g.items.length).items[0];
assert.match(renderIndie(u()),/\?from=indie/);
assert.match(renderHome(u()),/\?from=home/);
assert.match(renderDetail(indie.app_key,{...u(),detailFrom:'indie'}),/#\/indie">← 인디 발견으로 돌아가기/);
assert.match(renderDetail(indie.app_key,{...u(),detailFrom:'home'}),/#\/home">← 홈으로 돌아가기/);
assert.match(renderDetail(indie.app_key,u()),/#\/indie">← 인디 발견으로 돌아가기/);

// Exercise the actual navigation/pagination events with a minimal DOM shim.
const events={};const windowEvents={};
const klass={add(){},remove(){},toggle(){},contains(){return true;}};
const el=()=>({innerHTML:'',textContent:'',value:'',classList:klass,addEventListener(){},setAttribute(){},focus(){},style:{}});
const main=el(),overlay=el(),search=el(),toast=el(),footer=el(),status=el();
const elems={'main':main,'overlay':overlay,'global-search':search,'toast':toast,'footer-date':footer,'status-label':status};
globalThis.document={getElementById:id=>elems[id]||null,querySelectorAll:()=>[],querySelector:()=>({classList:klass}),addEventListener:(e,f)=>{events[e]=f;}};
globalThis.location={hash:'#/apps'};
globalThis.window={location,addEventListener:(e,f)=>{windowEvents[e]=f;},dispatchEvent(){},scrollTo(){}};
await import(pathToFileURL(path.join(root,'web/js/app.js')).href);
// Wait for the startup snapshot Promise to finish.
for(let i=0;i<100&&!main.innerHTML.includes('rank-table');i++)await new Promise(r=>setTimeout(r,5));
assert.ok(main.innerHTML.includes('rank-table'),'main app startup must render chart');
const act=(selector,dataset={})=>{
  const target={dataset,matches:x=>x===selector,id:''};
  return events.click({target:{closest:()=>target},preventDefault(){}});
};
const change=(filter,value)=>events.change({target:{dataset:{filter},value,matches:s=>s==='[data-filter]',id:''}});
change('source','all');change('country','ALL');
const parseChartSections=markup=>markup.split('<section class="store-section">').slice(1)
  .map(x=>({key:x.match(/data-more="true" data-group="([^"]+)"/)?.[1]||null,
    rows:(x.match(/class="rank-position/g)||[]).length}));
const before=parseChartSections(main.innerHTML);
const chosen=before.find(x=>x.key);assert.ok(chosen);
const other=before.find(x=>x.key&&x.key!==chosen.key);assert.ok(other);
await act('[data-more]',{group:chosen.key});
const after=parseChartSections(main.innerHTML);
assert.equal(after[before.indexOf(chosen)].rows,Math.min(chosen.rows+30,100),'clicked chart expands only its own rows');
assert.equal(after[before.indexOf(other)].rows,other.rows,'other chart must keep previous row count');
// Indie state must remain unchanged through detail and return.
location.hash='#/indie';windowEvents.hashchange();
assert.match(main.innerHTML,/인디 발견/);
await act('[data-feed]',{feed:'puzzle'});
const sortTarget={dataset:{},value:'name',matches:s=>s==='[data-indie-sort]'};
events.change({target:sortTarget});
const inputTarget={dataset:{},value:'a',matches:s=>s==='[data-indie-query]'};
events.input({target:inputTarget});
// The mock document does not maintain DOM subtrees; force a full render.
windowEvents.hashchange();
const indieBefore=main.innerHTML;
assert.match(indieBefore,/data-feed="puzzle" aria-pressed="true"/);
assert.match(indieBefore,/value="a"/);
assert.match(indieBefore,/<option value="name" selected>/);
const detailURL=indieBefore.match(/href="(#\/detail\/[^\"]+\?from=indie)"/)?.[1];
assert.ok(detailURL);
location.hash=detailURL;windowEvents.hashchange();
assert.match(main.innerHTML,/#\/indie">← 인디 발견으로 돌아가기/);
location.hash='#/indie';windowEvents.hashchange();
assert.match(main.innerHTML,/data-feed="puzzle" aria-pressed="true"/);
assert.match(main.innerHTML,/value="a"/);
assert.match(main.innerHTML,/<option value="name" selected>/);
console.log('[V1.17] country-exact home rank rises, independently paged charts, indie-detail roundtrip and filters OK');
