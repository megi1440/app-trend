import assert from 'node:assert/strict';
// Exercise the new tab without Gemini or network access.
const saved = new Map();
globalThis.sessionStorage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
globalThis.location={hash:'#/lab/development'};
let refreshes=0;
const brief={app_key:'apple:app1', original_experience_ko:'참고할 만한 요소',valuable_elements_ko:['특징'],
  new_concepts_ko:[{title_ko:'새 앱',core_idea_ko:'새로운 경험',what_to_keep_ko:'참고 특징',what_to_change_ko:'추가 기능',mobile_use_or_play_ko:'터치 사용',key_features_ko:['기능'],solo_mvp_and_effort_ko:'혼자 구현',strengths_limits_ko:'한계'}],recommended_concept_number:1,why_recommended_ko:'추천 이유'};
const plan={app_key:'apple:app1', selected_concept_title_ko:'새 앱', project_goal_and_audience_ko:'독립적인 프로젝트',
 mvp_scope_ko:'핵심 기능',screens_and_flow_ko:[{screen_ko:'첫 화면',contents_and_actions_ko:'버튼'}],
 features_ko:[{feature_ko:'조작',user_action_and_behavior_ko:'입력',practical_implementation_ko:'구현'}],
 risks_and_open_decisions_ko:['위험'],development_steps_ko:[{stage_ko:'개발',deliverable_and_check_ko:'작동 확인'}]};
const sample={schema_version:2,brief_count:1,plan_count:1,items:[
  {app_key:'apple:app1',name:'Example App',developer:'Studio',source:'apple',brief:true,plan:true,shard:'09'}]};
globalThis.fetch=async url=>{
  const path=String(url);
  assert(['./data/development/index.json','./data/development/items/09.json'].includes(path),`unexpected path ${path}`);
  return {ok:true,json:async()=>path.endsWith('index.json')?sample:{schema_version:2,items:{'apple:app1':{app_key:'apple:app1',brief,plan}}}};
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
assert.match(full,/MVP에서 먼저 만들 것/);
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
