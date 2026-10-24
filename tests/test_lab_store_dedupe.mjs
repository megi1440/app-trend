// Cross-store identity regression: one research card, independent source facts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const saved=new Map();
const storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)};
globalThis.sessionStorage=storage;
globalThis.localStorage=storage;
globalThis.location={hash:'#/lab/radar'};
globalThis.window={location,dispatchEvent(){}};
globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};
globalThis.fetch=async url=>{
  try{const content=JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'));
    return {ok:true,json:async()=>content};
  }catch{return {ok:false,status:404,json:async()=>null};}
};
const lab=await import(pathToFileURL(path.join(root,'web/js/lab.js')).href);
const {mergeStoreDuplicates,loadLab,renderLab}=lab;
const raw=JSON.parse(await fs.readFile(path.join(root,'data/lab/index.json'),'utf8'));
const merged=mergeStoreDuplicates(raw.items);
const keySet=new Set(merged.map(i=>i.app_key));
assert.equal(merged.length,keySet.size,'canonical cards unique by key');
assert(merged.length<raw.items.length,'linked Apple + Google records reduce card count');
const pair=merged.find(i=>i.name==='80億分の1 - 人生シミュレーター'&&i.store_variants?.length===2);
assert(pair,'reported Apple + Google duplicate is now one card');
assert.equal(pair.app_key,'apple:6821576483','stable canonical Apple key');
assert.deepEqual(pair.store_variants.map(v=>v.source),['apple','google']);
assert(pair.observations.some(o=>o.source==='apple'&&o.country==='JP'));
assert(pair.observations.some(o=>o.source==='google'&&o.country==='JP'));
assert(pair.signals.some(s=>s.evidence?.source==='google'),'Google evidence remains distinct');
assert(pair.signals.some(s=>s.evidence?.source==='apple'),'Apple evidence remains distinct');
assert.equal(pair.first_seen,'2026-10-22');
assert(pair.store_variants.every(v=>/^https:\/\//.test(v.detail_url)),'both source links preserved');
assert(!merged.find(i=>i.app_key==='google:games.hayo.whilewelive'),'secondary record not a second card');
const linked=merged.filter(i=>i.store_variants?.length===2);
assert(linked.length>=200,`expected many real confirmed cross-store pairs, got ${linked.length}`);
assert.equal(merged.length,raw.items.length-linked.length,'one hidden card per pair');
// Missing publisher, different publisher, same-store, and ambiguous matches are not force-merged.
const mk=(app_key,source,name,developer,opts={})=>({app_key,source,name,developer,
  kind:'game',observations:[],signals:[],tags:[],...opts});
const sample=[
  mk('apple:1','apple',' Example  Game ','Studio (Apps)'),
  mk('google:1','google','Example Game','studio',{has_ai:true,ai_shard:'a',tags:['병합된 태그'],analysed_at:'2026-10-24'}),
  mk('apple:2','apple','Example Game','Different Studio'),
  mk('google:2','google','Example Game','Different Studio LLC',{has_ai:false}),
  mk('apple:3','apple','Example Game',''),mk('google:3','google','Example Game',''),
  mk('apple:4','apple','Same title','Publisher'),mk('google:4','google','Another title','Publisher'),
  mk('apple:5','apple','Ambiguous','Publisher'),mk('google:5','google','Ambiguous','Publisher'),
  mk('google:6','google','Ambiguous','Publisher'),
];
const synthetic=mergeStoreDuplicates(sample);
assert.equal(synthetic.length,sample.length-2,'only two unambiguous named developer matches');
assert.equal(synthetic.find(i=>i.app_key==='apple:1').ai_key,'google:1','Google-only AI remains available');
assert.equal(synthetic.find(i=>i.app_key==='apple:1').ai_shard,'a');
assert.deepEqual(synthetic.find(i=>i.app_key==='apple:1').tags,['병합된 태그']);
assert(synthetic.some(i=>i.app_key==='apple:3')&&synthetic.some(i=>i.app_key==='google:3'),'missing developer does not merge');
assert(synthetic.some(i=>i.app_key==='google:6'),'ambiguous matching does not merge');
const data=await loadLab();
assert.equal(data.items.length,merged.length,'live lab uses merged candidates');
assert.equal(data.map.get('google:games.hayo.whilewelive'),data.map.get('apple:6821576483'),'either source ID resolves to one item');
assert.equal(data.ai_count,raw.ai_count,'original Gemini analyses preserved');
await lab.labAction({dataset:{labAction:'toggle-compare',key:'google:games.hayo.whilewelive'}});
assert.deepEqual(JSON.parse(storage.getItem('app-trend:lab-compare:v1')),
  ['apple:6821576483'],'old Google links compare as the canonical Apple candidate');
await lab.labAction({dataset:{labAction:'toggle-compare',key:'apple:6821576483'}});
assert.deepEqual(JSON.parse(storage.getItem('app-trend:lab-compare:v1')),[],
  'either source ID toggles the one candidate');
const radarMarkup=renderLab('radar');
const totalObserved=data.items.filter(i=>i.observations?.length).length;
const latestObserved=data.items.filter(i=>i.observations?.some(o=>!o.historical)).length;
assert(radarMarkup.includes(`<strong>${totalObserved.toLocaleString('ko-KR')}</strong><span>전체 관측 후보</span>`),
  'hero reports all deduplicated observed candidates');
assert(radarMarkup.includes(`최근 수집 목록 ${latestObserved.toLocaleString('ko-KR')}개`),
  'hero distinguishes latest collected candidates from the historical total');
assert(radarMarkup.includes(`필터 결과 ${totalObserved.toLocaleString('ko-KR')}개`),
  'default radar result count uses the deduplicated observed total');
assert(radarMarkup.includes(`더 보기 (${(totalObserved-24).toLocaleString('ko-KR')}개 남음)`),
  'load more uses the same result count as the radar');
assert(radarMarkup.includes('lab-card'),'merged lab still renders');
assert(renderLab('analysis').includes('개발 분석'),'analysis page still renders');
for(const source of ['apple','google']){
  lab.labChange({matches:selector=>selector==='[data-lab-filter]',dataset:{labFilter:'source'},value:source});
  const since=new Date(Date.parse(`${data.data_date}T00:00:00Z`)-29*86400000).toISOString().slice(0,10);
  const count=data.items.filter(i=>i.observations?.some(o=>o.source===source&&o.date>=since&&o.date<=data.data_date)).length;
  assert(renderLab('radar').includes(`필터 결과 ${count.toLocaleString('ko-KR')}개`),`${source} store filter includes linked candidates once`);
}
lab.labChange({matches:selector=>selector==='[data-lab-filter]',dataset:{labFilter:'source'},value:'all'});
await lab.labAction({dataset:{labAction:'add-export',key:pair.app_key}});
const exported=await lab.buildExport();
assert.equal(exported.items.length,1,'both stores exported as one research candidate');
assert.deepEqual(new Set(exported.items[0].observations.map(o=>o.source)),new Set(['apple','google']),
  'historical observations from both original source keys exported');
assert.equal(exported.items[0].app.store_variants.length,2,'both app store links exported');
const analyzedOnGoogle=data.items.find(i=>i.store_variants?.length===2&&i.ai_key?.startsWith('google:')&&i.has_ai);
assert(analyzedOnGoogle,'real linked record with only Google analysis exists');
await lab.labAction({dataset:{labAction:'clear-export-manual'}});
await lab.labAction({dataset:{labAction:'add-export',key:analyzedOnGoogle.app_key}});
const googleAnalysis=await lab.buildExport();
assert.equal(googleAnalysis.items.length,1);
assert(googleAnalysis.items[0].ai_analysis?.analysis,'Google analysis can load under stable Apple canonical key');
console.log(`[lab store dedupe] ${raw.items.length} source records -> ${merged.length} cards; ${linked.length} Apple/Google pairs, source evidence intact OK`);
