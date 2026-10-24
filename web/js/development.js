// Read-only Gemini 3.5 development studies. Source charts and 3.1 results stay intact.
import {esc,attr,detailsHref} from './data.js';
import {searchScope,searchResults,searchMatch,deepSearchState} from './lab_search.js';
let index=null,failed='',loading=false;
let selected='',opened=new Set(),comparison=[],query='';
let typingTimer;
const details=new Map();
let refresh=()=>{},notify=()=>{};
export function initDevelopmentHandlers(onRefresh,onNotify){refresh=onRefresh;notify=onNotify;}
function loadJSON(url){return fetch(url,{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('분석 자료를 불러올 수 없습니다.');return r.json();});}
function startLoad(){
 if(index||loading)return;
 loading=true;
 loadJSON('./data/development/index.json').then(result=>{
  if(result?.schema_version!==1||!Array.isArray(result.items))throw Error('개발 설계 인덱스가 올바르지 않습니다.');
  index=result;failed='';if(!selected)selected=result.items[0]?.app_key||'';
 }).catch(()=>{failed='아직 개발 설계 자료가 없습니다. 다음 자동 분석 후 생성됩니다.';}).finally(()=>{loading=false;if(location.hash.startsWith('#/lab/development'))refresh();});
}
function getDetail(row){
 if(!row||details.has(row.app_key)||opened.has(row.app_key))return;
 opened.add(row.app_key);
 loadJSON(`./data/development/items/${encodeURIComponent(row.shard)}.json`).then(payload=>{
   const found=payload?.schema_version===1?payload.items?.[row.app_key]:null;
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
function renderReport(doc,entry){
 if(!doc)return `<div class="panel dev-preview">분석 내용을 불러오는 중입니다.</div>`;
 if(doc.error)return `<div class="panel dev-preview">${el(doc.error)}</div>`;
 const brief=doc.brief||{},plan=doc.plan;
 return `<article class="panel dev-report">
   <div class="dev-report-head"><div><p class="eyebrow">GEMINI 3.5 FLASH-LITE</p><h2>${el(entry.name)}</h2><p class="small-copy">${el(entry.developer||'제작사 미확인')} · ${el(entry.source)}</p></div>
     <button type="button" class="button ghost small" data-dev-action="download" data-key="${attr(entry.app_key)}">JSON 저장 ↧</button></div>
   <p class="lab-disclaimer">확인된 스토어 설명과 3.1 분석을 참고해 작성한 AI 개발 제안입니다. 원본 앱의 내부 구조나 성공 원인을 확인한 자료가 아닙니다.</p>
   ${section('검토 이유',brief.reason_to_study_ko)}
   ${section('확인된 핵심 경험',brief.core_experience_ko)}
   ${section('차별화 아이디어',brief.originality_direction_ko)}
   ${section('1인 개발 적합성',brief.solo_feasibility_ko)}
   ${section('MVP 주요 기능',brief.mvp_features_ko)}
   ${section('기술적 위험',brief.technical_risks_ko)}
   ${section('개발 전 확인할 내용',brief.verify_before_build_ko)}
   ${plan?`<div class="dev-plan-label">상세 개발 설계서</div>
    ${section('프로젝트 개념',plan.project_concept_ko)}
    ${section('대상 사용자',plan.target_user_ko)}
    ${section('MVP 범위',plan.mvp_scope_ko)}
    ${section('화면·사용 흐름',plan.screen_flow_ko)}
    ${section('기술 구조',plan.architecture_ko)}
    ${section('데이터 구조',plan.data_model_ko)}
    ${section('개발 순서',plan.milestones_ko)}
    ${section('차별화 방향',plan.differentiation_ko)}
    ${section('위험 요소',plan.risks_ko)}
    ${section('확인되지 않은 사항',plan.evidence_limitations_ko)}`:''}
   <a class="button ghost small" href="${attr(detailsHref(entry.app_key,{from:'lab',labtab:'development'}))}">원본 앱 상세 보기 →</a>
 </article>`;
}
function renderCompare(){
 const rows=comparison.map(key=>index.items.find(r=>r.app_key===key)).filter(Boolean);
 rows.forEach(getDetail);
 return `<section class="panel dev-compare"><h3>선택한 후보 비교 (${rows.length}/3)</h3>
 ${rows.length?`<div class="dev-compare-grid">${rows.map(row=>{
  const r=details.get(row.app_key);const b=r?.brief||{},p=r?.plan||{};
  return `<div><strong>${el(row.name)}</strong><p>${el(b.originality_direction_ko||'자료 읽는 중')}</p><b>MVP</b><ul>${(p.mvp_scope_ko||b.mvp_features_ko||[]).map(x=>`<li>${el(x)}</li>`).join('')}</ul><b>위험</b><ul>${(p.risks_ko||b.technical_risks_ko||[]).map(x=>`<li>${el(x)}</li>`).join('')}</ul></div>`;
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
 const candidates=sourceRows.map(row=>({...lookup.get(row.app_key),...row}));
 const rows=searchResults(candidates,query);
 const status=deepSearchState();
 const scopeControls=`<div class="dev-search-toolbar"><label class="lab-search-label">개발 기획서 검색<input type="search" data-dev-search value="${attr(query)}" placeholder="앱 이름, 기능, MVP, 기술 구조"></label><label class="lab-search-label">검색 범위<select data-lab-filter="searchScope" class="field-select"><option value="basic" ${searchScope()==='basic'?'selected':''}>기본 검색</option><option value="full" ${searchScope()==='full'?'selected':''}>상세 내용까지</option></select></label></div>${searchScope()==='full'?`<p class="lab-search-guide">${status.state==='loading'?'상세 AI 자료를 읽는 중입니다.':status.missing?'일부 상세 자료를 불러오지 못했습니다.':'Gemini 3.1·3.5 전체 분석 내용까지 검색합니다.'}</p>`:'<p class="lab-search-guide">기본 검색: 이름 · 제작사 · 분류 · 기능 태그 · AI 핵심 요약</p>'}`;
 if(!rows.length)return `<div class="dev-heading"><h2>개발 설계실</h2></div>${scopeControls}<div class="panel dev-preview">검색 조건에 일치하는 개발 기획서가 없습니다.</div>`;
 const row=rows.find(x=>x.app_key===selected)||rows[0];
 selected=row.app_key;getDetail(row);
 return `<div class="dev-heading"><div><h2>개발 설계실</h2><p class="small-copy">Gemini 3.5 · 개발 검토서 ${index.brief_count}개 · 상세 설계서 ${index.plan_count}개</p></div></div>
 ${scopeControls}<div class="dev-search-count">검색 결과 ${rows.length}개 / 전체 ${sourceRows.length}개 개발 후보</div>
 <div class="dev-layout"><aside class="panel dev-sidebar" aria-label="개발 분석 후보 목록">
 ${rows.map(item=>`<div class="dev-candidate ${item.app_key===selected?'is-active':''}">
  <button type="button" data-dev-action="select" data-key="${attr(item.app_key)}" aria-current="${item.app_key===selected?'true':'false'}"><strong>${el(item.name)}</strong><small>${item.plan?'상세 설계 완료':'개발 검토서'} · ${el(item.source)}</small>${query?(()=>{const match=searchMatch(item,query);return match?`<span class="lab-search-hit"><strong>${el(match.label)} 일치</strong> · ${el(match.snippet)}</span>`:'';})():''}</button>
  <label class="dev-select-compare"><input type="checkbox" data-dev-action="compare" data-key="${attr(item.app_key)}" ${comparison.includes(item.app_key)?'checked':''}> 비교</label></div>`).join('')}</aside>
 <div class="dev-main">${renderReport(details.get(selected),row)}${renderCompare()}</div></div>`;
}
export async function developmentAction(target){
 const action=target.dataset.devAction;
 if(!action)return false;
 const key=target.dataset.key;
 if(action==='retry'){failed='';index=null;loading=false;refresh();return true;}
 if(action==='select'){selected=key;refresh();return true;}
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
