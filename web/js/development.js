// Read-only Gemini 3.5 development studies. Source charts and 3.1 results stay intact.
import {esc,attr,detailsHref,safeUrl,SOURCE_LABEL,CATEGORY_LABEL,FEED_LABEL,COUNTRY_LABEL,formatDate} from './data.js';
import {searchScope,searchResults,searchMatch,deepSearchState} from './lab_search.js';
let index=null,failed='',loading=false;
let selected='',opened=new Set(),comparison=[],query='',reportTab='design';
let typingTimer;
const details=new Map();
const aiDetails=new Map(),aiPending=new Set();
let refresh=()=>{},notify=()=>{};
export function initDevelopmentHandlers(onRefresh,onNotify){refresh=onRefresh;notify=onNotify;}
function loadJSON(url){return fetch(url,{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('분석 자료를 불러올 수 없습니다.');return r.json();});}
function startLoad(){
 if(index||loading)return;
 loading=true;
 loadJSON('./data/development/index.json').then(result=>{
  if(result?.schema_version!==2||!Array.isArray(result.items))throw Error('개발 설계 인덱스가 올바르지 않습니다.');
  index=result;failed='';if(!selected)selected=result.items[0]?.app_key||'';
 }).catch(()=>{failed='아직 개발 설계 자료가 없습니다. 다음 자동 분석 후 생성됩니다.';}).finally(()=>{loading=false;if(location.hash.startsWith('#/lab/development'))refresh();});
}
function getDetail(row){
 if(!row||details.has(row.app_key)||opened.has(row.app_key))return;
 opened.add(row.app_key);
 loadJSON(`./data/development/items/${encodeURIComponent(row.shard)}.json`).then(payload=>{
   const found=payload?.schema_version===2?payload.items?.[row.app_key]:null;
   if(!found||found.app_key!==row.app_key)throw Error('개발 자료가 일치하지 않습니다.');
   details.set(row.app_key,found);
 }).catch(()=>{details.set(row.app_key,{error:'상세 자료를 읽지 못했습니다.'});}).finally(()=>{
   opened.delete(row.app_key);
   if(location.hash.startsWith('#/lab/development'))refresh();
 });
}
const el=(v)=>esc(String(v??''));
function section(title,values){
 if(!values||Array.isArray(values)&&!values.length)return '';
 return `<section class="dev-section"><h3>${el(title)}</h3>${Array.isArray(values)?`<ul>${values.map(x=>`<li>${el(x)}</li>`).join('')}</ul>`:`<p>${el(values)}</p>`}</section>`;
}
// Development candidates reference the same 3.1 index/shards used by the analysis tab.
// Load only the selected candidate's AI file; never refetch or generate AI content.
function getAI(labItem){
 if(!labItem?.has_ai||!labItem.ai_shard)return;
 const key=labItem.ai_key||labItem.app_key;
 if(aiDetails.has(key)||aiPending.has(key))return;
 aiPending.add(key);
 loadJSON(`./data/ai/items/${encodeURIComponent(labItem.ai_shard)}.json`).then(data=>{
  const record=data?.items?.[key];
  if(!record?.analysis||record.app_key!==key)throw Error('3.1 분석 자료를 확인할 수 없습니다.');
  aiDetails.set(key,record);
 }).catch(()=>aiDetails.set(key,{error:'3.1 원문을 읽지 못했습니다.'})).finally(()=>{
  aiPending.delete(key);
  if(location.hash.startsWith('#/lab/development'))refresh();
 });
}
function storeLinks(row){
 const variants=row.store_variants?.length?row.store_variants:[row];
 return `<div class="dev-store-links">${variants.map(v=>{
  const url=safeUrl(v.detail_url),label=SOURCE_LABEL[v.source]||v.source||'원본';
  const cls=['apple','google','itch'].includes(v.source)?v.source:'other';
  return url?`<a class="dev-source-badge dev-source-${cls}" href="${attr(url)}" target="_blank" rel="noopener noreferrer">${el(label)} ↗</a>`:`<span class="dev-source-badge dev-source-${cls}">${el(label)}</span>`;
 }).join('')}</div>`;
}
// Itch feed names like 'new' are not genres. Use only recorded category
// or explicit bracketed genre labels from the original item title.
function genreLabel(row){
 const category=CATEGORY_LABEL[row.category];
 if(category&&row.category!=='all_games'&&row.category!=='all_apps')return category;
 const known={'Visual Novel':'비주얼 노벨','Puzzle':'퍼즐','Simulation':'시뮬레이션','Strategy':'전략','Action':'액션','Adventure':'어드벤처','Platformer':'플랫포머','RPG':'RPG','Survival':'생존','Card Game':'카드 게임','Shooter':'슈팅','Horror':'공포','Other':'기타'};
 const match=[...String(row.name||'').matchAll(/\[([^\]]+)\]/g)].map(x=>x[1]).find(x=>known[x]);
 return match?known[match]:(row.category&&FEED_LABEL[row.category]?'장르 미기록':category||'장르 미기록');
}
function observationSummary(row){
 const seen=(row.observations||[]).slice(0,3);
 return seen.length?`<div class="dev-observation"><strong>수집 관측</strong><div>${seen.map(o=>{
  const source=SOURCE_LABEL[o.source]||o.source||'';
  const country=COUNTRY_LABEL[o.country]||o.country||'';
  return `<span>${el(source)} · ${el(country)}${o.rank!=null?` · ${el(o.rank)}위`:''} <small>${el(formatDate(o.date))}</small></span>`;
 }).join('')}</div></div>`:'';
}
function statusBadge(entry){
 return entry.plan
  ? '<span class="dev-status-badge dev-status-complete">✓ 설계 초안 작성 완료</span>'
  : '<span class="dev-status-badge dev-status-brief">검토 진행 중</span>';
}
function analysisList(values,emptyText){
 return Array.isArray(values)&&values.length
  ? `<ul class="lab-ai-list">${values.map(v=>`<li>${el(v)}</li>`).join('')}</ul>`
  : `<p class="small-copy">${el(emptyText)}</p>`;
}
function renderOverview(row,ai){
 const analysis=ai?.analysis||{},level=analysis.difficulty_ko||{},mvp=analysis.solo_mvp_ko||{};
 const icon=safeUrl(row.icon_url);
 const title=row.kind==='game'?'게임':row.kind==='app'?'앱':'앱·게임';
 const summary=analysis.summary_ko||row.summary||'3.1 한국어 개요를 확인할 수 없습니다.';
 return `<section class="panel dev-overview" aria-label="선택한 앱 기본정보">
  <div class="dev-overview-top">
    <div class="dev-cover-frame">${icon?`<img src="${attr(icon)}" alt="${attr(row.name)} 이미지" loading="lazy" referrerpolicy="no-referrer">`:'<div class="dev-cover-missing" role="img" aria-label="이미지 미수집"><span>▧</span><small>이미지 미수집</small></div>'}</div>
    <div class="dev-overview-identity"><div class="dev-overview-eyebrow"><p class="eyebrow">APP PROFILE / GEMINI 3.1</p>${statusBadge(row)}</div><h2>${el(row.name)}</h2><p class="dev-publisher">${el(row.developer||'제작사 정보 미수집')}</p>
      <div class="dev-meta-tags"><span class="dev-meta-type">${el(title)}</span><span class="dev-meta-type">${el(genreLabel(row))}</span><span class="dev-difficulty">개발 난이도 <b>${el(level.level||row.difficulty||'판단 어려움')}</b><small>AI 참고</small></span></div>
      ${storeLinks(row)}
    </div>
  </div>
  <div class="dev-overview-body">
    <section class="lab-ai-section dev-korean-summary"><h3>한국어 개요</h3><p class="lab-ai-paragraph">${el(summary)}</p><p class="small-copy">Gemini 3.1의 한국어 개요를 동일한 원문으로 표시합니다.</p></section>
    <section class="lab-ai-quick" aria-label="개발 관점 핵심 요약"><div class="lab-ai-quick-title"><h3>개발 관점 핵심 요약</h3><span>Gemini 3.1 참고 · 동일한 핵심 기능과 MVP</span></div>
      <div class="lab-ai-quick-grid"><div><h4>핵심 기능</h4>${analysisList((analysis.features_ko||[]).slice(0,2),'정리된 핵심 기능 없음')}</div>
        <div><h4>혼자 만드는 첫 MVP</h4>${analysisList((mvp.must_have||[]).slice(0,3),'MVP 제안 없음')}</div>
        <div><h4>개발 부담·위험</h4>${analysisList((mvp.risks||[]).slice(0,2),'위험 분석 없음')}</div></div>
    </section>
    ${observationSummary(row)}
  </div>
 </section>`;
}
function renderAnalysis(doc,entry){
 if(!entry.has_ai)return '<div class="dev-report-empty">3.1 분석이 없는 후보입니다.</div>';
 if(!doc)return '<div class="dev-report-empty">3.1 상세 분석을 불러오는 중입니다.</div>';
 if(doc.error)return `<div class="dev-report-empty">${el(doc.error)}</div>`;
 const a=doc.analysis||{},difficulty=a.difficulty_ko||{},mvp=a.solo_mvp_ko||{};
 const ideas=Array.isArray(a.ideas_ko)?a.ideas_ko:[];
 return `<div class="dev-study-content"><p class="lab-disclaimer">Gemini 3.1 분석입니다. 수집한 스토어 정보에 기초한 분석과 개발 제안이며 실제 내부 구현이 확인된 자료는 아닙니다.</p>
  ${section('한국어 개요',a.summary_ko)}
  ${section('소개에서 정리한 핵심 기능',a.features_ko)}
  ${section('눈여겨볼 특징',a.noteworthy_ko)}
  ${section('개발 참고 사항',a.development_ko)}
  ${section('주요 구현 시스템',a.systems_ko)}
  ${section('개발 난이도와 판단 근거',[difficulty.level&&`난이도: ${difficulty.level}`,difficulty.reason].filter(Boolean))}
  ${section('MVP 먼저 구현',mvp.must_have)}
  ${section('MVP 후순위',mvp.defer)}
  ${section('개발 위험',mvp.risks)}
  ${ideas.length?`<section class="dev-section"><h3>응용 아이디어</h3>${ideas.map(idea=>`<div class="dev-original-idea"><strong>${el(idea.title||'아이디어')}</strong><p>${el(idea.concept||'')}</p>${idea.first_step?`<small>첫 단계: ${el(idea.first_step)}</small>`:''}</div>`).join('')}</section>`:''}
  ${section('종합 조언',a.recommendation_ko)}
  ${section('확인되지 않은 사항',a.source_limitations_ko)}
  ${section('보관된 원본 소개',doc.source_description)}
 </div>`;
}
function conceptCard(concept,i,recommended){
 if(!concept||typeof concept!=='object')return '';
 return `<article class="dev-concept-card ${i+1===recommended?'is-recommended':''}">
  <div class="dev-concept-card-head"><span class="dev-concept-number">아이디어 ${i+1}</span>${i+1===recommended?'<span class="dev-concept-picked">추천 방향</span>':''}</div>
  <h4>${el(concept.title_ko||'기획명 미정')}</h4><p class="dev-concept-idea">${el(concept.core_idea_ko)}</p>
  <dl><dt>원본에서 이어받을 점</dt><dd>${el(concept.what_to_keep_ko)}</dd>
  <dt>새로 바꿀 점</dt><dd>${el(concept.what_to_change_ko)}</dd>
  <dt>모바일 사용·플레이 흐름</dt><dd>${el(concept.mobile_use_or_play_ko)}</dd></dl>
  ${section('특징적인 기능',concept.key_features_ko)}
  <p class="dev-concept-sub"><strong>혼자 만드는 MVP</strong> ${el(concept.solo_mvp_and_effort_ko)}</p>
  <p class="dev-concept-sub"><strong>장점과 주의점</strong> ${el(concept.strengths_limits_ko)}</p>
 </article>`;
}
function renderDesign(doc,entry){
 if(!doc)return '<div class="dev-report-empty">3.5 개발 기획서를 불러오는 중입니다.</div>';
 if(doc.error)return `<div class="dev-report-empty">${el(doc.error)}</div>`;
 const brief=doc.brief||{},plan=doc.plan||{};
 const concepts=Array.isArray(brief.new_concepts_ko)?brief.new_concepts_ko:[];
 return `<div class="dev-study-content dev-v8-content">
  <div class="dev-report-head"><div class="dev-report-title"><p class="eyebrow">GEMINI 3.5 HIGH · 개발 검토 및 설계 초안</p>${statusBadge(entry)}</div><button type="button" class="button ghost small" data-dev-action="download" data-key="${attr(entry.app_key)}">JSON 저장 ↧</button></div>
  <p class="lab-disclaimer">수집 자료와 Gemini 3.1의 해석을 바탕으로 만든 신작 아이디어 및 개발 설계 <strong>초안</strong>입니다. 실제 원작 플레이·소스 분석·구현 검증을 마친 자료가 아닙니다.</p>
  <section class="dev-v8-intro"><h3>원본에서 눈여겨볼 점</h3><p>${el(brief.original_experience_ko)}</p>
   ${section('이어받을 장점',brief.valuable_elements_ko)}${section('확인된 사실과 자료의 한계',brief.source_facts_and_limitations_ko)}</section>
  <section class="dev-v8-ideas"><div class="dev-v8-section-head"><div><p class="eyebrow">NEW IDEAS</p><h3>새로운 개발 아이디어 3개</h3></div><span>원본과 관련된 다른 앱·게임 기획</span></div>
   <div class="dev-concepts">${concepts.map((c,i)=>conceptCard(c,i,brief.recommended_concept_number)).join('')}</div>
   <div class="dev-choice-summary">${section('아이디어 비교',brief.concept_comparison_ko)}${section('추천 이유',brief.why_recommended_ko)}</div>
   ${section('개발 전 확인할 질문',brief.next_questions_ko)}</section>
  <section class="dev-v8-plan"><div class="dev-v8-section-head"><div><p class="eyebrow">DEVELOPMENT DRAFT</p><h3>선정 기획 · 개발 설계 초안</h3></div><span>구현 전에 검토할 초안</span></div>
   <div class="dev-selected-title"><strong>${el(plan.selected_concept_title_ko||'선정 기획')}</strong><p>${el(plan.project_goal_and_audience_ko)}</p></div>
   ${section('원본과의 연결 및 차별화',plan.source_relation_and_difference_ko)}
   ${section('핵심 사용자 경험',plan.core_user_experience_ko)}
   <section class="dev-section"><h3>핵심 기능과 구현 방향</h3><div class="dev-feature-plans">${(plan.features_ko||[]).map(f=>`<div class="dev-feature-plan"><strong>${el(f.feature_ko)}</strong><p>${el(f.user_action_and_behavior_ko)}</p><small>${el(f.practical_implementation_ko)}</small></div>`).join('')}</div></section>
   <section class="dev-section"><h3>주요 화면과 사용 흐름</h3><div class="dev-screen-flow">${(plan.screens_and_flow_ko||[]).map((x,i)=>`<div class="dev-screen-item"><span>${i+1}</span><div><strong>${el(x.screen_ko)}</strong><p>${el(x.contents_and_actions_ko)}</p></div></div>`).join('')}</div></section>
   ${section('기술 선택과 구현 구조',plan.implementation_approach_ko)}
   ${section('데이터 및 저장 설계',plan.data_and_storage_ko)}
   ${section('MVP에서 먼저 만들 것',plan.mvp_scope_ko)}
   <section class="dev-section"><h3>개발 단계</h3><div class="dev-build-steps">${(plan.development_steps_ko||[]).map((step,i)=>`<div><b>${i+1}. ${el(step.stage_ko)}</b><p>${el(step.deliverable_and_check_ko)}</p></div>`).join('')}</div></section>
   ${section('향후 확장 방향',plan.possible_extensions_ko)}
   ${section('개발 위험과 미결정 사항',plan.risks_and_open_decisions_ko)}
   <p class="dev-draft-note">${el(plan.draft_status_ko||'실제 개발·플레이 테스트가 완료되지 않은 설계 초안입니다.')}</p>
  </section>
 </div>`;
}
function renderReport(doc,entry,ai){
 return `<div class="dev-result">${renderOverview(entry,ai)}<article class="panel dev-report">
  <div class="dev-report-tabs" role="tablist" aria-label="선택한 앱의 개발 분석 보기">
   <button type="button" role="tab" aria-selected="${reportTab==='analysis'}" class="${reportTab==='analysis'?'is-active':''}" data-dev-action="report-tab" data-value="analysis">3.1 개발 분석</button>
   <button type="button" role="tab" aria-selected="${reportTab==='design'}" class="${reportTab==='design'?'is-active':''}" data-dev-action="report-tab" data-value="design">3.5 개발 아이디어·설계 초안</button>
  </div><div class="dev-report-tabpanel" role="tabpanel">${reportTab==='analysis'?renderAnalysis(ai,entry):renderDesign(doc,entry)}</div>
  <div class="dev-report-foot"><a class="button ghost small" href="${attr(detailsHref(entry.app_key,{from:'lab',labtab:'development'}))}">수집 상세 보기 →</a></div>
 </article></div>`;
}

function renderCompare(){
 const rows=comparison.map(key=>index.items.find(r=>r.app_key===key)).filter(Boolean);
 rows.forEach(getDetail);
 return `<section class="panel dev-compare"><h3>선택한 후보 비교 (${rows.length}/3)</h3>
 ${rows.length?`<div class="dev-compare-grid">${rows.map(row=>{
  const r=details.get(row.app_key);const b=r?.brief||{},p=r?.plan||{};const concept=(b.new_concepts_ko||[])[(b.recommended_concept_number||1)-1]||{};
  return `<div><strong>${el(row.name)}</strong><p>${el(concept.core_idea_ko||'자료 읽는 중')}</p><b>MVP</b><ul>${(p.features_ko||[]).map(x=>`<li>${el(x.feature_ko)}</li>`).join('')}</ul><b>위험</b><ul>${(p.risks_and_open_decisions_ko||[]).map(x=>`<li>${el(x)}</li>`).join('')}</ul></div>`;
 }).join('')}</div>`:'<p class="small-copy">왼쪽 목록에서 비교할 후보를 최대 3개 선택하세요.</p>'}</section>`;
}
export const developmentQuery=()=>query;
export function developmentInput(target){
 if(!target.matches?.('[data-dev-search]'))return false;
 query=target.value;const pos=target.selectionStart;
 clearTimeout(typingTimer);
 typingTimer=setTimeout(()=>{
  if(!location.hash.startsWith('#/lab/development'))return;
  refresh();const field=document.querySelector('[data-dev-search]');
  if(field){field.focus();try{field.setSelectionRange(pos,pos);}catch{}}
 },220);
 return true;
}
export function renderDevelopment(labItems=[]){
 if(!index&&!loading&&!failed)startLoad();
 if(loading)return '<div class="center-loading"><span class="loading-spinner"></span><p>개발 설계 자료를 읽는 중입니다.</p></div>';
 if(failed)return `<div class="panel dev-preview">${el(failed)} <button class="button ghost small" data-dev-action="retry">다시 확인</button></div>`;
 const sourceRows=index?.items||[];
 if(!sourceRows.length)return '<div class="panel dev-preview">아직 3.5 분석 자료가 없습니다. 다음 자동 분석부터 쌓입니다.</div>';
 const lookup=new Map();for(const item of labItems)for(const key of item.alias_keys||[item.app_key])lookup.set(key,item);
 const candidates=sourceRows.map(row=>{
  const lab=lookup.get(row.app_key)||{};
  // The 3.5 index is a lightweight pointer, not an authoritative app profile.
  // Its empty kind/metadata must never erase canonical 3.1/store information.
  const merged={...lab};
  for(const [key,value] of Object.entries(row)){
   if(value!==null&&value!==undefined&&value!==''||!(key in merged))merged[key]=value;
  }
  merged.app_key=row.app_key; // Fetch the exact 3.5 brief/plan record.
  return merged;
 });
 const rows=searchResults(candidates,query);
 const status=deepSearchState();
 const scopeControls=`<div class="dev-search-toolbar"><label class="lab-search-label">개발 기획서 검색<input type="search" data-dev-search value="${attr(query)}" placeholder="앱 이름, 기능, MVP, 기술 구조"></label><label class="lab-search-label">검색 범위<select data-lab-filter="searchScope" class="field-select"><option value="basic" ${searchScope()==='basic'?'selected':''}>기본 검색</option><option value="full" ${searchScope()==='full'?'selected':''}>상세 내용까지</option></select></label></div>${searchScope()==='full'?`<p class="lab-search-guide">${status.state==='loading'?'상세 AI 자료를 읽는 중입니다.':status.missing?'일부 상세 자료를 불러오지 못했습니다.':'Gemini 3.1·3.5 전체 분석 내용까지 검색합니다.'}</p>`:'<p class="lab-search-guide">기본 검색: 이름 · 제작사 · 분류 · 기능 태그 · AI 핵심 요약</p>'}`;
 if(!rows.length)return `<div class="dev-heading"><h2>개발 설계실</h2></div>${scopeControls}<div class="panel dev-preview">검색 조건에 일치하는 개발 기획서가 없습니다.</div>`;
 const row=rows.find(x=>x.app_key===selected)||rows[0];
 selected=row.app_key;getDetail(row);getAI(row);
 return `<div class="dev-heading"><div><h2>개발 설계실</h2><p class="small-copy">Gemini 3.5 High · 개발 검토서+설계 초안 ${index.plan_count}쌍</p></div></div>
 ${scopeControls}<div class="dev-search-count">검색 결과 ${rows.length}개 / 전체 ${sourceRows.length}개 개발 후보</div>
 <div class="dev-layout"><aside class="panel dev-sidebar" aria-label="개발 분석 후보 목록">
 ${rows.map(item=>`<div class="dev-candidate ${item.app_key===selected?'is-active':''}">
  <button type="button" data-dev-action="select" data-key="${attr(item.app_key)}" aria-current="${item.app_key===selected?'true':'false'}"><span class="dev-candidate-top">${safeUrl(item.icon_url)?`<img class="dev-candidate-icon" src="${attr(safeUrl(item.icon_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span class="dev-candidate-icon dev-candidate-icon-fallback">▧</span>'}<span><strong>${el(item.name)}</strong><small>${el(SOURCE_LABEL[item.source]||item.source)} · ${el(genreLabel(item))}${item.difficulty?' · '+el(item.difficulty):''}</small></span></span><span class="dev-candidate-status">${statusBadge(item)}</span>${query?(()=>{const match=searchMatch(item,query);return match?`<span class="lab-search-hit"><strong>${el(match.label)} 일치</strong> · ${el(match.snippet)}</span>`:'';})():''}</button>
  <label class="dev-select-compare"><input type="checkbox" data-dev-action="compare" data-key="${attr(item.app_key)}" ${comparison.includes(item.app_key)?'checked':''}> 비교</label></div>`).join('')}</aside>
 <div class="dev-main">${renderReport(details.get(selected),row,aiDetails.get(row.ai_key||row.app_key))}${renderCompare()}</div></div>`;
}
export async function developmentAction(target){
 const action=target.dataset.devAction;
 if(!action)return false;
 const key=target.dataset.key;
 if(action==='retry'){failed='';index=null;loading=false;refresh();return true;}
 if(action==='select'){selected=key;refresh();return true;}
 if(action==='report-tab'&&['analysis','design'].includes(target.dataset.value)){reportTab=target.dataset.value;refresh();return true;}
 if(action==='compare'){
   const checked=target.checked;
   if(checked&&!comparison.includes(key)){
     if(comparison.length>=3){target.checked=false;notify('후보 비교는 최대 3개까지 가능합니다.');return true;}
     comparison.push(key);
   }else if(!checked)comparison=comparison.filter(x=>x!==key);
   refresh();return true;
 }
 if(action==='download'){
   const payload=details.get(key);
   if(!payload||payload.error){notify('아직 자료를 읽지 못했습니다.');return true;}
   const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
   const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='app-trend-development-'+key.replace(/[^a-z0-9_-]/gi,'_')+'.json';
   document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
 }
 return false;
}
