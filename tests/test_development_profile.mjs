import assert from 'node:assert/strict';
// 3.1 and 3.5 are stored independently; the chosen app must bring both together.
globalThis.sessionStorage={getItem:()=>null,setItem:()=>{}};
globalThis.location={hash:'#/lab/development'};
const calls=[];
const app={app_key:'apple:a1',alias_keys:['apple:a1','google:g1'],name:'Element Garden [Free] [Puzzle]',kind:'game',source:'apple',developer:'Bright Forge',
 category:'game_puzzle',icon_url:'https://example.com/element.png',difficulty:'보통',summary:'두 원소를 결합해 새로운 식물을 발견합니다.',tags:['원소 조합','발견 도감'],has_ai:true,ai_key:'google:g1',ai_shard:'07',
 store_variants:[{source:'apple',detail_url:'https://apps.apple.com/app/a1'},{source:'google',detail_url:'https://play.google.com/store/apps/details?id=g1'}],
 observations:[{source:'apple',country:'KR',rank:7,date:'2026-10-24'}]};
const responses={
 './data/development/index.json':{schema_version:2,brief_count:1,plan_count:1,items:[{app_key:'google:g1',name:'Element Garden [Free] [Puzzle]',source:'google',kind:'',developer:'',brief:true,plan:true,shard:'15'}]},
 './data/development/items/15.json':{schema_version:2,items:{'google:g1':{app_key:'google:g1',brief:{original_experience_ko:'조합 방식이 흥미롭다.',new_concepts_ko:[{title_ko:'새 게임',core_idea_ko:'원본을 발전시킨 퍼즐',what_to_keep_ko:'조합',what_to_change_ko:'새 규칙',mobile_use_or_play_ko:'조작',key_features_ko:['기본 결합'],solo_mvp_and_effort_ko:'간단한 개발',strengths_limits_ko:'제약'}],recommended_concept_number:1,valuable_elements_ko:['조합 경험']},plan:{selected_concept_title_ko:'새 게임',implementation_approach_ko:'규칙 엔진',mvp_scope_ko:'MVP 범위'}}}},
 './data/ai/items/07.json':{schema_version:1,items:{'google:g1':{app_key:'google:g1',analysis:{summary_ko:'원소 조합 퍼즐',features_ko:['새 원소 만들기'],difficulty_ko:{level:'보통',reason:'조합 데이터 관리 필요'},solo_mvp_ko:{must_have:['조합 버튼']}}}}}
};
globalThis.fetch=async url=>{const u=String(url);calls.push(u);const d=responses[u];assert(d,'unexpected fetch: '+u);return {ok:true,json:async()=>d};};
let refreshes=0;
const dev=await import('../web/js/development.js');
dev.initDevelopmentHandlers(()=>refreshes++,()=>{});
assert.match(dev.renderDevelopment([app]),/개발 설계 자료를 읽는 중/);
await new Promise(r=>setTimeout(r,0));
assert.match(dev.renderDevelopment([app]),/개발 분석/);
await new Promise(r=>setTimeout(r,0));
const markup=dev.renderDevelopment([app]);
assert.match(markup,/https:\/\/example.com\/element.png/);
assert.match(markup,/원소 조합/);
assert.match(markup,/>게임<\/span>/,'empty development.kind cannot overwrite lab.kind');
assert.match(markup,/Bright Forge/,'empty development developer cannot overwrite lab developer');
assert.match(markup,/설계 초안 작성 완료/);
assert.match(markup,/dev-status-complete/);
assert.match(markup,/한국어 개요/);
assert.match(markup,/개발 관점 핵심 요약/);
assert.match(markup,/핵심 기능/);
assert.match(markup,/새 원소 만들기/,'3.1 original features visible above tabs');
assert.match(markup,/혼자 만드는 첫 MVP/);
assert.match(markup,/개발 부담·위험/);
assert.match(markup,/원소 조합 퍼즐/);
assert.match(markup,/개발 난이도/);
assert.match(markup,/보통/);
assert.match(markup,/퍼즐/);
assert.match(markup,/App Store/);
assert.match(markup,/Google Play/);
assert.match(markup,/7위/);
assert.match(markup,/3.1 개발 분석/);
assert.match(markup,/3.5 개발 아이디어·설계 초안/);
assert.match(markup,/조합 방식이 흥미롭다/);
await dev.developmentAction({dataset:{devAction:'report-tab',value:'analysis'}});
const analyzed=dev.renderDevelopment([app]);
assert.match(analyzed,/새 원소 만들기/);
assert.match(analyzed,/소개에서 정리한 핵심 기능/);
assert.match(analyzed,/조합 버튼/);
assert.doesNotMatch(analyzed,/조합 방식이 흥미롭다/);
assert.equal(calls.filter(c=>c==='./data/ai/items/07.json').length,1,'3.1 shard requested once');
await dev.developmentAction({dataset:{devAction:'report-tab',value:'design'}});
assert.match(dev.renderDevelopment([app]),/조합 방식이 흥미롭다/);
assert(refreshes>0);
console.log('[development profile] store aliases, image, genre, difficulty, 3.1/3.5 tabs and lazy shard OK');
