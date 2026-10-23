// Final UI integration checks, using the real current snapshot (no mocks for ranking evidence).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=rel=>fs.readFile(path.join(root,rel),'utf8');
globalThis.localStorage={getItem:()=>null,setItem(){}};
globalThis.sessionStorage=globalThis.localStorage;
globalThis.fetch=async url=>{
  try{return {ok:true,status:200,json:async()=>JSON.parse(await read(String(url).replace(/^\.\//,'')))}}
  catch{return {ok:false,status:404,json:async()=>({})}}
};
const {loadSnapshot}=await import('../web/js/data.js');
const {renderHome,renderExplore,homeCandidates}=await import('../web/js/views.js');
await loadSnapshot();
const ui={country:'US',source:'google',price:'top_free',category:'all_apps',sort:'popular',groupLimits:{},filtersOpen:false};
const home=renderHome(ui);
assert.ok(!home.includes('undefined'),'home evidence must never display undefined labels');
const rises=['app','game'].flatMap(kind=>homeCandidates(kind,'US'))
  .filter(row=>row.candidate.reason_code==='rising_7d');
assert.ok(rises.length>0,'current data should contain actual rank rises');
for(const row of rises){
  assert.equal(typeof row.candidate.evidence.before_rank,'number');
  assert.equal(typeof row.candidate.evidence.after_rank,'number');
  assert.ok(home.includes(`${row.candidate.evidence.before_rank}위`));
  assert.ok(home.includes(`${row.candidate.evidence.after_rank}위`));
}
const collapsed=renderExplore('app',ui);
const expanded=renderExplore('app',{...ui,filtersOpen:true});
assert.match(collapsed,/aria-controls="filter-panel" aria-expanded="false"/);
assert.match(expanded,/aria-controls="filter-panel" aria-expanded="true"/);
for(const file of ['index.html','web/index.html']){
  const html=await read(file);
  assert.match(html,/id="csv-button"[^>]+aria-label="CSV 자료 내보내기"/);
  assert.match(html,/id="status-button"[^>]+aria-label="데이터 수집 상태 확인"/);
  for(const page of ['home','apps','games','indie','lab','favorites'])
    assert.match(html,new RegExp(`data-page="${page}"`));
}
const mainCss=await read('web/css/main.css');
const labCss=await read('web/css/lab.css');
assert.match(mainCss,/\.rank-table tbody tr\{display:grid/,'mobile chart uses readable grid rows');
assert.match(mainCss,/@media\(prefers-reduced-motion:reduce\)/,'reduced motion is supported');
assert.match(labCss,/\.lab-analysis-toolbar\{grid-template-columns:minmax\(0,1fr\)/,'narrow lab filters stack');
console.log('[final UI] real rank evidence labels, mobile chart/filter styling, header accessibility and both published entrypoints OK');
