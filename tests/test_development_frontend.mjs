import assert from 'node:assert/strict';
// Exercise the new tab without Gemini or network access.
const saved = new Map();
globalThis.sessionStorage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
globalThis.location={hash:'#/lab/development'};
let refreshes=0;
const brief={app_key:'apple:app1',reason_to_study_ko:'참고할 만한 요소',core_experience_ko:'실제 설명에서 확인',
  originality_direction_ko:'새로운 경험',solo_feasibility_ko:'혼자 구현 제안',
  mvp_features_ko:['기능'],technical_risks_ko:['위험'],verify_before_build_ko:['확인']};
const plan={app_key:'apple:app1',project_concept_ko:'독립적인 프로젝트',target_user_ko:'작은 사용자군',
 mvp_scope_ko:['핵심 기능'],screen_flow_ko:['첫 화면'],architecture_ko:['모듈'],data_model_ko:['데이터'],
 milestones_ko:['개발 순서'],differentiation_ko:['차별화'],risks_ko:['위험'],evidence_limitations_ko:['한계']};
const sample={schema_version:1,brief_count:1,plan_count:1,items:[
  {app_key:'apple:app1',name:'Example App',developer:'Studio',source:'apple',brief:true,plan:true,shard:'09'}]};
globalThis.fetch=async url=>{
  const path=String(url);
  assert(['./data/development/index.json','./data/development/items/09.json'].includes(path),`unexpected path ${path}`);
  return {ok:true,json:async()=>path.endsWith('index.json')?sample:{schema_version:1,items:{'apple:app1':{app_key:'apple:app1',brief,plan}}}};
};
const dev=await import('../web/js/development.js');
dev.initDevelopmentHandlers(()=>refreshes++,()=>{});
const first=dev.renderDevelopment();
assert.match(first,/개발 설계 자료를 읽는 중/);
await new Promise(resolve=>setTimeout(resolve,0));
const second=dev.renderDevelopment();
assert.match(second,/개발 설계실/);
assert.match(second,/Example App/);
await new Promise(resolve=>setTimeout(resolve,0));
const full=dev.renderDevelopment();
assert.match(full,/MVP 범위/);
assert.match(full,/독립적인 프로젝트/);
assert.match(full,/data-dev-action="compare"/);
await dev.developmentAction({dataset:{devAction:'compare',key:'apple:app1'},checked:true});
assert.match(dev.renderDevelopment(),/선택한 후보 비교 \(1\/3\)/);
const lock=await import('../web/js/lab_lock.js');
assert.match(lock.renderLabGate(),/type="password"/);
assert.equal(lock.labIsUnlocked(),false);
assert.equal(await lock.unlockLab('incorrect-pass'),false);
assert.equal(lock.labIsUnlocked(),false);
assert(refreshes>0);
console.log('[development frontend] lazy-load, detail, compare, hashed gate rejection OK');
