import { store, esc, attr, safeUrl, formatDate, SOURCE_LABEL, COUNTRY_LABEL, CATEGORY_LABEL,
         APP_CATEGORIES, GAME_CATEGORIES, FEED_LABEL, REASON_LABEL,
         groupsFor, detailsHref, candidateSentence, candidateFor } from './data.js';
import { getFavorites, hasFavorite, getFavorite, filterFavorites, FAVORITE_STATUSES } from './favorites.js';

export const countryButtons = (selected, showAll=true) => `<div class="country-bar"><span class="tiny-label">국가</span><div class="chips">${[
    ['US','🇺🇸 미국'],['JP','🇯🇵 일본'],['KR','🇰🇷 한국'],...(showAll?[['ALL','3개국 비교']]:[])
  ].map(([id,label])=>`<button type="button" data-country="${id}" class="chip ${selected===id?'selected':''}" aria-pressed="${selected===id}">${label}</button>`).join('')}</div></div>`;
const heading=(eyebrow,title,desc,side='')=>`<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="subtext">${esc(desc)}</p></div>${side}</div>`;
export const empty=(title='아직 표시할 데이터가 없습니다.',desc='다음 수집 결과를 확인해 주세요.')=>`<div class="empty-state"><strong>${esc(title)}</strong><p>${esc(desc)}</p></div>`;
export const icon=(item,cls='')=>safeUrl(item?.icon_url)?`<img class="app-icon ${cls}" src="${attr(safeUrl(item.icon_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="app-icon fallback ${cls}" aria-hidden="true">✦</span>`;
const star=(item)=>`<button type="button" class="icon-button ${hasFavorite(item.app_key)?'saved':''}" data-fav="${attr(item.app_key)}" title="${hasFavorite(item.app_key)?'관심 목록에서 빼기':'관심 목록에 추가'}" aria-label="${hasFavorite(item.app_key)?'관심 목록에서 빼기':'관심 목록에 추가'}">${hasFavorite(item.app_key)?'★':'☆'}</button>`;
const sourceTag=(source)=>`<span class="info-tag blue">${esc(SOURCE_LABEL[source]||source)}</span>`;
const staleTag=(g)=>g.is_stale?`<span class="info-tag warn">이전 데이터 · ${formatDate(g.data_date)}</span>`:'';
const description=(item,max=135)=>item?.description?esc(item.description.slice(0,max))+(item.description.length>max?'…':''):'원본 페이지에서 게임·앱 소개를 확인할 수 있습니다.';

// App/Google chart groups are intentionally never mixed into one ranking.
// A missing or stale collection is surfaced with its original evidence date.
function groupCollectionStatus(group) {
  return (store.status?.groups||[]).find(s=>s.source===group.source && s.country===group.country && s.category===group.category && s.chart===group.chart && (s.feed||null)===(group.feed||null));
}
function groupAvailability(group) {
  const status=groupCollectionStatus(group);
  if(status?.status==='skipped')return 'unsupported';
  if(status?.status==='failed' && !(group.items||[]).length)return 'failed';
  if(group.is_stale && (group.items||[]).length)return 'previous';
  if(!(group.items||[]).length)return 'empty';
  return 'current';
}
const availabilityMessage=(state)=>state==='unsupported'?'수집 설정상 미지원':state==='failed'?'최근 요청 실패':state==='previous'?'이전 정상 기록':state==='empty'?'관측 자료 없음':'최신 관측';

// Home highlights are based on independently verified observations, never a
// combined popularity score. Each rank change belongs to one exact chart.
export function homeCandidates(kind, country='US') {
  const chosen=[], used=new Set();
  const matchesKind=g=>g.source!=='itch' && (kind==='game'?g.category==='all_games':g.category==='all_apps');
  const relevant=store.groups.filter(g=>matchesKind(g) && g.chart==='top_free' &&
    (country==='ALL'||g.country===country) && !g.is_stale && g.data_date===store.latest?.data_date);
  const add=(row)=>{
    if(!row || used.has(row.item.app_key))return false;
    used.add(row.item.app_key);chosen.push(row);return true;
  };
  // Use actual before/after ranks from the derived movement index. One app
  // shown in two countries is still only one home candidate.
  const rising=[];
  for(const group of relevant)for(const item of (group.items||[])){
    const evidence=chartMovementEvidence(item,group);
    if(!evidence || Number(evidence.change)<=0)continue;
    rising.push({item,group,candidate:{app_key:item.app_key,reason_code:'rising_7d',evidence}});
  }
  rising.sort((a,b)=>Number(b.candidate.evidence.change)-Number(a.candidate.evidence.change)||
    Number(a.item.rank)-Number(b.item.rank)||a.item.app_key.localeCompare(b.item.app_key));
  // Prefer showing both platforms when records exist, rather than repeating
  // a single store. All rank changes remain explicitly chart-local.
  if(rising.length){
    add(rising[0]);
    add(rising.find(x=>x.group.source!==chosen[0].group.source && !used.has(x.item.app_key))||
      rising.find(x=>!used.has(x.item.app_key)));
  }
  // Reserve room for an actually first-observed app when one exists. "First
  // observed" must not be presented as a verified store release date.
  const newly=[];
  for(const group of relevant)for(const item of (group.items||[])){
    if(item.first_seen===store.latest?.data_date && !used.has(item.app_key))
      newly.push({group,item,candidate:{app_key:item.app_key,reason_code:'newly_seen',evidence:{first_seen:item.first_seen}}});
  }
  newly.sort((a,b)=>Number(a.item.rank)-Number(b.item.rank)||a.item.app_key.localeCompare(b.item.app_key));
  if(newly.length && chosen.length<3)add(newly[0]);
  if(chosen.length>=3)return chosen.slice(0,3);
  // If fewer real rises or new observations exist, use other recorded signals.
  const reasons=['multi_country','consistent_30d','overseas_interest','newly_seen'];
  for(const reason of reasons)for(const c of (store.trends?.candidates||[])){
    if(chosen.length>=3)break;
    if(c.reason_code!==reason || used.has(c.app_key))continue;
    const ev=c.evidence||{};
    const matching=relevant.find(g=> (g.items||[]).some(x=>x.app_key===c.app_key) &&
      (!ev.source||g.source===ev.source) && (!ev.country||g.country===ev.country) &&
      (!ev.chart||g.chart===ev.chart) && (!ev.category||g.category===ev.category) &&
      (!ev.countries||ev.countries.includes(g.country)));
    if(!matching)continue;
    const item=matching.items.find(x=>x.app_key===c.app_key);
    add({candidate:c,group:matching,item});
  }
  return chosen.slice(0,3);
}
function homeCandidateCard({candidate,group,item}) {
  // The movements index stores before/after ranks, not chart coordinates.
  // Add the observed chart context only to the display sentence; do not
  // mutate the original movement evidence or infer missing dates.
  const displayCandidate=candidate.reason_code==='rising_7d'
    ? {...candidate,evidence:{...candidate.evidence,source:group.source,country:group.country,chart:group.chart,category:group.category}}
    : candidate;
  return `<article class="panel discovery-card home-candidate">
    <div class="card-topline"><span class="info-tag ${candidate.reason_code==='rising_7d'?'green':'blue'}">${esc(candidate.reason_code==='rising_7d'?'실제 순위 상승':REASON_LABEL[candidate.reason_code]||'관측 기록')}</span>${star(item)}</div>
    <a class="card-content" href="${attr(detailsHref(item.app_key,group))}">${icon(item)}<div style="min-width:0"><div class="card-title">${esc(item.name)}</div><div class="card-meta">${esc(SOURCE_LABEL[group.source]||group.source)} · ${esc(CATEGORY_LABEL[group.category]||'')}</div></div></a>
    <p class="card-note">${esc(candidateSentence(displayCandidate))}</p><div class="card-bottom"><span class="small-copy">${esc(COUNTRY_LABEL[group.country]||'')} · ${formatDate(group.data_date)}</span><a class="text-link" href="${attr(detailsHref(item.app_key,group))}">자세히 →</a></div>
  </article>`;
}
function homeMini(kind,source,country,limit) {
  const cat=kind==='app'?'all_apps':'all_games';
  const g=groupsFor({kind,country,source,category:cat,chart:'top_free'})[0];
  if(!g)return `<section class="panel home-mini"><div class="home-mini-head"><strong>${esc(SOURCE_LABEL[source])}</strong><span class="info-tag warn">자료 없음</span></div>${empty('순위표 없음','수집된 차트가 없습니다.')}</section>`;
  const av=groupAvailability(g);
  const rows=(g.items||[]).slice(0,limit).map(item=>`<div class="mini-row"><span class="rank-number">${esc(item.rank)}</span>${icon(item)}<a title="${attr(item.name)}" href="${attr(detailsHref(item.app_key,g))}">${esc(item.name)}</a></div>`).join('');
  return `<section class="panel home-mini"><div class="home-mini-head"><strong>${esc(SOURCE_LABEL[source])}</strong><span class="info-tag ${av==='previous'?'warn':av==='unsupported'||av==='failed'?'red':''}">${esc(availabilityMessage(av))}</span></div>
    ${rows||empty(av==='unsupported'?'수집 미지원':av==='failed'?'수집 실패':'관측 자료 없음',av==='unsupported'?'이 차트는 수집 설정에서 제외되어 있습니다.':av==='failed'?'이전 정상 기록도 없습니다.':'이 차트에는 기록된 앱·게임이 없습니다.')}
    <div class="home-mini-foot">관측일 ${formatDate(g.data_date)} ${av==='previous'?'· 현재 요청 실패, 이전 자료 표시':''}</div></section>`;
}
export function renderHome(ui) {
  const latest=store.latest||{};
  const statuses=store.status?.groups||[];
  const success=statuses.filter(x=>x.status==='success').length;
  const failed=statuses.filter(x=>x.status==='failed').length;
  const skipped=statuses.filter(x=>x.status==='skipped').length;
  const previous=store.groups.filter(g=>g.is_stale && (g.items||[]).length).length;
  const statusView=`<section class="panel home-coverage" aria-label="수집 자료 상태"><div class="home-coverage-head"><div><strong>수집 자료 현황</strong><p class="small-copy">전체 그룹 ${statuses.length}개 · 최신 자료 기준 ${formatDate(latest.data_date)}</p></div><button class="button ghost small" type="button" id="home-status-button">상세 확인 →</button></div><div class="home-coverage-stats"><span><b>${success}</b> 정상 수집</span><span><b>${failed}</b> 요청 실패</span><span><b>${previous}</b> 이전 기록 사용</span><span><b>${skipped}</b> 수집 미지원</span></div>${failed||skipped?`<p class="small-copy home-coverage-note">요청 실패와 수집 미지원은 별개입니다. 이전 데이터가 있으면 날짜를 표시하고 유지합니다.</p>`:''}</section>`;
  const countries=ui.country==='ALL'?['US','JP','KR']:[ui.country];
  const sections=countries.map(country=>`<div class="home-country-section"><div class="home-country-label">${esc(COUNTRY_LABEL[country]||country)} · 무료 인기 차트</div><div class="home-chart-kinds">${[['app','📱 앱','apps'],['game','🎮 게임','games']].map(([kind,label,href])=>`<section class="home-chart-kind"><div class="home-chart-title"><strong>${label}</strong><a class="text-link" href="#/${href}">전체 보기 →</a></div><div class="home-source-grid">${homeMini(kind,'apple',country,ui.country==='ALL'?3:5)}${homeMini(kind,'google',country,ui.country==='ALL'?3:5)}</div></section>`).join('')}</div></div>`).join('');
  const indie=store.groups.find(g=>g.source==='itch'&&g.feed==='featured');
  return `<section class="hero"><div><p class="eyebrow">APP & GAME OBSERVATIONS</p><h1>오늘의 앱·게임 흐름</h1><p class="subtext">관측된 순위와 발견 기록으로 눈여겨볼 앱과 게임을 찾아보세요. 국가·스토어별 순위는 따로 표시합니다.</p></div><div class="hero-decor" aria-hidden="true">✧</div></section>
    ${statusView}
    <div class="section-heading"><div><h2>✨ 눈여겨볼 앱과 게임</h2><p>실제 관측 근거가 있는 후보만 표시합니다. 순위 상승과 처음 관측은 신규 출시를 의미하지 않습니다.</p></div><a class="text-link" href="#/lab/radar">연구실에서 더 찾기 →</a></div>
    <div class="home-discovery-columns">${[['app','📱 앱에서 발견','apps'],['game','🎮 게임에서 발견','games']].map(([kind,label,href])=>`<section class="home-discovery-column"><div class="home-discovery-head"><h3>${label}</h3><a class="text-link" href="#/${href}">탐색하기 →</a></div><div class="home-discovery-list">${homeCandidates(kind,ui.country).map(homeCandidateCard).join('')||empty('해당 유형에 발견 근거가 없습니다.','다음 수집 결과를 확인해 주세요.')}</div></section>`).join('')}</div>
    <div class="section-heading"><div><h2>🔎 인기 순위 빠르게 보기</h2><p>같은 국가에서도 App Store와 Google Play의 순위를 합산하지 않습니다.</p></div>${countryButtons(ui.country)}</div>
    <div class="home-chart-groups">${sections}</div>
    <div class="section-heading"><div><h2>💡 인디에서 발견</h2><p>itch.io 추천 피드의 실제 수집 목록입니다. 피드 위치는 인기 순위가 아닙니다.</p></div><a class="text-link" href="#/indie">인디 더 보기 →</a></div>
    <section class="indie-grid">${(indie?.items||[]).slice(0,4).map(item=>indieCard(item,'featured')).join('')||empty('인디 추천 피드 자료가 없습니다.','다음 수집 결과를 확인해 주세요.')}</section>
    <p class="small-copy" style="margin-top:25px">※ '처음 발견'은 이 사이트의 첫 수집일입니다. 순위만으로 인기 원인·다운로드·개발 난이도를 단정하지 않습니다.</p>`;
}

// Every chart has its own pagination state, including its store and country.
export const exploreGroupKey=g=>[g.source,g.country,g.chart,g.category].join('|');
export const exploreGroupLimit=(ui,g)=>Math.max(30,Number(ui.groupLimits?.[exploreGroupKey(g)])||30);
function select(name, options, value){return `<select class="field-select" data-filter="${name}" aria-label="${name}">${options.map(([key,label])=>`<option value="${attr(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select>`;}
// Only offer categories for combinations present in the collected snapshot.
// Unsupported skipped-only groups (e.g. Apple Arcade) are not selectable.
export function availableExploreCategories(kind,ui) {
  const all=kind==='game'?'all_games':'all_apps';
  if(ui.price==='top_paid')return [all];
  const known=kind==='game'?GAME_CATEGORIES:APP_CATEGORIES;
  const prefix=kind==='game'?'game_':'app_';
  const found=store.groups.filter(g=>g.source!=='itch' && g.chart===ui.price && (ui.country==='ALL'||g.country===ui.country) && (ui.source==='all'||g.source===ui.source) && (g.category===all||g.category?.startsWith(prefix)) && groupAvailability(g)!=='unsupported');
  const names=new Set(found.map(g=>g.category));
  return [...known.filter(c=>names.has(c)),...[...names].filter(c=>!known.includes(c)).sort()];
}
export function normalizeExploreCategory(kind,ui) {
  const all=kind==='game'?'all_games':'all_apps';
  const choices=availableExploreCategories(kind,ui);
  if(ui.price==='top_paid' || !choices.includes(ui.category))ui.category=choices.includes(all)?all:choices[0]||all;
  return ui.category;
}
// A chart movement is shown only when the recorded evidence belongs to exactly
// the same store, country, chart and category. Absence is NOT a flat rank.
export function chartRiseEvidence(item, group) {
  return (store.candidates.get(item.app_key)||[]).find(c=>
    c.reason_code==='rising_7d' && Number(c.evidence?.change)>0 &&
    c.evidence?.source===group.source && c.evidence?.country===group.country &&
    c.evidence?.chart===group.chart && c.evidence?.category===group.category &&
    c.evidence?.after_date===group.data_date && !group.is_stale
  )||null;
}
function movementKey(item,group) {
  return [item.app_key,group.source,group.country,group.chart,group.category].join('|');
}
export function chartMovementEvidence(item,group) {
  if(group.is_stale)return null;
  if(store.movements!==null){
    const movement=store.movements[movementKey(item,group)];
    return movement && movement.after_date===group.data_date && Number(movement.after_rank)===Number(item.rank)?movement:null;
  }
  // Historical builds without movements.json: only verified rising trend signals.
  const candidate=chartRiseEvidence(item,group);
  return candidate?candidate.evidence:null;
}
function rankMovement(item,group) {
  const e=chartMovementEvidence(item,group);
  if(!e)return '<span class="rank-unverified" title="이 조건에서 비교할 두 관측일이 없습니다. 순위가 같거나 하락했다는 뜻이 아닙니다.">비교 기록 부족</span>';
  const change=Number(e.change);
  const direction=change>0?'rank-rise':change<0?'rank-fall':'rank-flat';
  const words=change>0?`↑ ${change}계단`:change<0?`↓ ${Math.abs(change)}계단`:'순위 유지';
  const before=Number(e.before_rank);
  const after=Number(e.after_rank);
  const label=`${formatDate(e.before_date)} ${before}위 → ${formatDate(e.after_date)} ${after}위`;
  return `<span class="${direction}" title="${attr(label)}"><b>${esc(words)}</b><small>${esc(formatDate(e.before_date))} 대비${e.gap_days>1?` · ${esc(e.gap_days)}일 간격`:''}</small></span>`;
}
function chartRow(item,g) {
  const rating=Number(item.rating);
  const ratingText=item.rating!==null && item.rating!==undefined && Number.isFinite(rating)?`★ ${rating.toFixed(1)}`:'미확인';
  const first=item.first_seen===g.data_date&&!g.is_stale?'<span class="rank-first-seen" title="이 사이트의 최초 관측이며 실제 출시일이 아닙니다">첫 관측</span>':'';
  return `<tr><td class="rank-cell"><span class="rank-position ${Number(item.rank)<=3?'top-rank':''}">${esc(item.rank)}</span></td>
    <td class="item-col"><a class="item-name-link" href="${attr(detailsHref(item.app_key,g))}">${icon(item)}<span class="item-text"><span class="item-primary">${esc(item.name)}</span><span class="item-secondary">${esc(item.developer||'개발사 미확인')}</span></span></a>${first}</td>
    <td class="category-col"><span class="small-copy">${esc(item.primary_category||CATEGORY_LABEL[g.category]||'미확인')}</span></td>
    <td class="rating-cell"><span class="rating-value ${item.rating==null?'muted':''}">${ratingText}</span></td>
    <td class="movement-cell">${rankMovement(item,g)}</td><td class="save-cell">${star(item)}</td></tr>`;
}
function groupListRows(group,ui) {
  const items=[...(group.items||[])];
  const signals=item=>store.candidates.get(item.app_key)||[];
  const sameChart=c=>c.evidence?.source===group.source && c.evidence?.country===group.country && c.evidence?.category===group.category && c.evidence?.chart===group.chart;
  const rising=item=>chartMovementEvidence(item,group)?.change>0?chartMovementEvidence(item,group):null;
  if(ui.sort==='rising')return items.filter(rising).sort((a,b)=>(rising(b)?.change||0)-(rising(a)?.change||0)||a.rank-b.rank);
  if(ui.sort==='new')return items.filter(item=>item.first_seen===store.latest.data_date && !group.is_stale).sort((a,b)=>a.rank-b.rank);
  if(ui.sort==='consistent')return items.filter(item=>signals(item).some(c=>c.reason_code==='consistent_30d'&&sameChart(c))).sort((a,b)=>a.rank-b.rank);
  return items.sort((a,b)=>a.rank-b.rank);
}
export function renderExplore(kind,ui) {
  const isGame=kind==='game';
  const categoryList=availableExploreCategories(kind,ui);
  const activeCat=categoryList.includes(ui.category)?ui.category:categoryList[0]||(isGame?'all_games':'all_apps');
  const results=groupsFor({kind,country:ui.country,source:ui.source,category:activeCat,chart:ui.price});
  const renderG=g=>{
    const items=groupListRows(g,ui), displayed=items.slice(0,exploreGroupLimit(ui,g)), state=groupAvailability(g);
    const notice=state==='previous'?`<p class="source-notice warn">최근 수집이 실패해 ${formatDate(g.data_date)}의 마지막 정상 순위를 표시합니다. 오늘 순위로 해석하지 마세요.</p>`:state==='failed'?'<p class="source-notice error">최근 수집 요청이 실패했고, 보존된 순위도 없습니다.</p>':state==='unsupported'?'<p class="source-notice">이 스토어·장르 조합은 수집 설정상 미지원입니다.</p>':'';
    return `<section class="store-section"><div class="store-head"><h3>${esc(COUNTRY_LABEL[g.country]||g.country)} · ${esc(SOURCE_LABEL[g.source]||g.source)} · ${esc(CATEGORY_LABEL[g.category]||g.category)}</h3><div class="chips"><span class="info-tag ${state==='previous'?'warn':state==='failed'||state==='unsupported'?'red':''}">${esc(availabilityMessage(state))}</span><span class="info-tag">관측 ${formatDate(g.data_date)}</span></div></div>
      <div class="panel results-panel"><div class="results-header"><div><strong>${esc(CATEGORY_LABEL[g.category]||g.category)} ${g.chart==='top_paid'?'유료':'무료'} 순위</strong><p class="subtext">${esc(SOURCE_LABEL[g.source]||g.source)} · 이 차트 ${items.length}개 · ${g.chart==='top_paid'?'유료':'무료'} · ${formatDate(g.data_date)} 기준</p></div></div>${notice}
      ${items.length?`<div class="table-scroll"><table class="rank-table"><thead><tr><th scope="col">순위</th><th scope="col">앱·게임</th><th scope="col">분류</th><th scope="col">평점</th><th scope="col">순위 변화</th><th scope="col">저장</th></tr></thead><tbody>${displayed.map(item=>chartRow(item,g)).join('')}</tbody></table></div>${items.length>displayed.length?`<div class="table-foot"><button class="button ghost small" data-more="true" data-group="${attr(exploreGroupKey(g))}">더 보기 (${items.length-displayed.length}개 남음)</button></div>`:''}`:empty(state==='unsupported'?'수집 미지원':state==='failed'?'수집 실패':ui.sort==='rising'?'이 차트에 확인된 순위 상승이 없습니다.':ui.sort==='new'?'이번 수집일에 처음 발견된 항목이 없습니다.':ui.sort==='consistent'?'확인된 꾸준한 관측 기록이 없습니다.':'선택한 조건에 관측 자료가 없습니다.', state==='unsupported'?'이 차트는 현재 수집 대상이 아닙니다.':state==='failed'?'데이터 수집 상태에서 실패 내용을 확인할 수 있습니다.':ui.sort!=='popular'?'선택한 국가·스토어·차트 안에서 근거가 확인된 항목만 표시합니다.':'이 차트의 수집 기록이 없습니다.')}
      <div class="rank-method-note">순위 변화는 같은 국가·스토어·차트·분류의 실제 관측일만 비교합니다. 중간 수집일이 빠졌다면 관측일 간격을 표시하고, 기록이 없으면 추정하지 않습니다.</div>
      </div></section>`;
  };
  const countryOptions=[['US','🇺🇸 미국'],['JP','🇯🇵 일본'],['KR','🇰🇷 한국'],['ALL','🌏 3개국 비교']];
  return `${heading('APP & GAME CHARTS',isGame?'게임 탐색':'앱 탐색',isGame?'장르별 실제 관측 순위와 변화를 국가·스토어별로 살펴보세요.':'카테고리별 실제 관측 순위를 국가·스토어별로 살펴보세요.',`<button class="button ghost filter-toggle" data-toggle-filters="true" aria-controls="filter-panel" aria-expanded="${Boolean(ui.filtersOpen)}">☷ 조건 선택</button>`)}
    <div class="explore-layout"><aside class="panel filters ${ui.filtersOpen?'mobile-open':''}" id="filter-panel"><h2>조건 선택</h2>
      <div class="filter-group"><label class="filter-label">국가</label>${select('country',countryOptions,ui.country)}</div>
      <div class="filter-group"><label class="filter-label">스토어</label>${select('source',[['google','Google Play'],['apple','App Store'],['all','전체 스토어 (각각 표시)']],ui.source)}</div>
      <div class="filter-group"><label class="filter-label">종류</label><div class="segmented"><button data-price="top_free" class="${ui.price==='top_free'?'selected':''}" aria-pressed="${ui.price==='top_free'}">무료</button><button data-price="top_paid" class="${ui.price==='top_paid'?'selected':''}" aria-pressed="${ui.price==='top_paid'}">유료</button></div></div>
      <div class="filter-group"><label class="filter-label">${isGame?'게임 장르':'앱 카테고리'}</label>${select('category',(categoryList.length?categoryList:[activeCat]).map(x=>[x,CATEGORY_LABEL[x]||x]),activeCat)}</div>
      <div class="filter-group"><label class="filter-label">탐색 방식</label>${select('sort',[['popular','인기순'],['rising','확인된 순위 상승'],['new','이번에 처음 관측'],['consistent','꾸준한 관측']],ui.sort)}</div>
      <p class="filter-help">선택 가능한 카테고리는 실제 수집 차트 기준입니다. 유료 차트는 전체 앱·전체 게임만 지원합니다.</p>
    </aside><div style="min-width:0">${results.length?results.map(renderG).join(''):empty('수집된 순위표가 없습니다.','현재 국가·스토어·종류에서 제공하는 차트가 없습니다. 조건을 변경해 주세요.')}<p class="small-copy">※ 스토어·국가·차트별 순위는 합산하지 않습니다. 비교 가능한 같은 차트의 관측 근거만 변화로 표시합니다.</p></div></div>`;
}

export function indieCard(item,feed) {
  const url=detailsHref(item.app_key)+'?from=home';
  return `<article class="panel indie-card"><a href="${attr(url)}">${safeUrl(item.icon_url)?`<img class="indie-cover" src="${attr(safeUrl(item.icon_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<div class="indie-cover-placeholder">✧</div>`}</a>
      <div class="indie-body"><a href="${attr(url)}"><div class="card-title">${esc(item.name)}</div></a><div class="card-meta">itch.io · ${esc(FEED_LABEL[feed]||'인디 게임')}</div><div class="card-bottom"><a class="text-link" href="${attr(url)}">살펴보기 →</a>${star(item)}</div></div></article>`;
}
// Indie discovery is an observed itch.io feed catalog, not a popularity chart.
// Merge overlapping feed entries by app_key; preserve each original feed label.
const INDIE_FEED_ORDER={featured:0,new:1,puzzle:2,idle:3};
export function availableIndieFeeds(){
  return [...new Set(store.groups.filter(g=>g.source==='itch').map(g=>g.feed).filter(Boolean))].sort((a,b)=>(INDIE_FEED_ORDER[a]??999)-(INDIE_FEED_ORDER[b]??999)||a.localeCompare(b));
}
const INDIE_TAGS=/\s+\[([^\]\n]+)\]/g;
export function indieDisplayName(name) {
  const raw=String(name||'');
  const chunks=raw.match(/(?:\s+\[[^\]\n]+\])+$/);
  if(!chunks)return {name:raw,metadata:[]};
  const tags=[...chunks[0].matchAll(INDIE_TAGS)].map(m=>m[1].trim()).filter(Boolean);
  // Remove suffix metadata only if it resembles the known itch.io RSS title suffix.
  // Unknown bracketed parts may be part of the actual game title.
  const known=t=>/^(?:free|\$[\d,.]+|\d+% off|windows|macos|linux|android|web|html5|other|puzzle|action|adventure|strategy|simulation|platformer|visual novel|role playing|rpg|survival|horror|educational|interactive fiction|racing|sports|shooter|rhythm|card game|board game|casual|fighting|soundtrack|tool|physical game)$/i.test(t);
  if(!tags.length||!tags.some(known)||!tags.every(known))return {name:raw,metadata:[]};
  return {name:raw.slice(0,-chunks[0].length),metadata:tags};
}
export function indieCatalog(ui) {
  const feeds=availableIndieFeeds();
  const chosen=[...feeds,'all'].includes(ui.feed)?ui.feed:'all';
  const selected=chosen==='all'?feeds:[chosen];
  const entries=new Map();
  for(const feed of selected){
    const group=store.groups.find(g=>g.source==='itch'&&g.feed===feed);
    for(const item of (group?.items||[])){
      if(!entries.has(item.app_key))entries.set(item.app_key,{item,feeds:[],groups:[]});
      const row=entries.get(item.app_key);
      if(!row.feeds.includes(feed))row.feeds.push(feed);
      row.groups.push(group);
      // Prefer a usable description or thumbnail from any observed feed.
      if((!row.item.description&&item.description)||(!row.item.icon_url&&item.icon_url))row.item=item;
    }
  }
  const query=String(ui.indieQuery||'').trim().toLocaleLowerCase();
  const rows=[...entries.values()].filter(row=>{
    if(!query)return true;
    const x=row.item;
    return [x.name,x.description,...row.feeds.map(f=>FEED_LABEL[f]||f)].join(' ').toLocaleLowerCase().includes(query);
  });
  const sort=ui.indieSort||'feed';
  if(sort==='recent')rows.sort((a,b)=>String(b.item.first_seen||'').localeCompare(String(a.item.first_seen||''))||indieDisplayName(a.item.name).name.localeCompare(indieDisplayName(b.item.name).name,'ko'));
  else if(sort==='name')rows.sort((a,b)=>indieDisplayName(a.item.name).name.localeCompare(indieDisplayName(b.item.name).name,'ko'));
  // Feed order is stable, original RSS order; neither is an app popularity rank.
  return {rows,total:entries.size,chosen};
}
function indieListRow({item,feeds,groups}) {
  const url=detailsHref(item.app_key)+'?from=indie',img=safeUrl(item.icon_url);
  const display=indieDisplayName(item.name);
  const title=esc(display.name||item.name);
  const meta=display.metadata.slice(0,3).map(tag=>`<span class="indie-meta-tag">${esc(tag==='Free'?'무료':tag)}</span>`).join('');
  const stale=groups.every(g=>g?.is_stale);
  return `<article class="indie-list-row">
    <a class="indie-list-image" href="${attr(url)}" aria-label="${attr(display.name||item.name)} 상세 보기">${img?`<img src="${attr(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span aria-hidden="true">✧</span>'}</a>
    <div class="indie-list-info">
      <a class="indie-list-title" href="${attr(url)}" title="${attr(item.name)}">${title}</a>
      <p class="indie-list-summary">${item.description?esc(item.description):'<span class="indie-no-summary">원본 소개 미수집</span>'}</p>
      <div class="indie-list-tags">${feeds.map(feed=>`<span class="indie-feed-tag">${esc(FEED_LABEL[feed]||feed)}</span>`).join('')}${meta}</div>
    </div>
    <div class="indie-list-end"><span class="indie-list-first">첫 관측 <strong>${formatDate(item.first_seen)}</strong></span>${stale?'<span class="info-tag warn">이전 기록</span>':''}<div class="indie-list-actions"><a class="text-link" href="${attr(url)}">살펴보기 →</a>${star(item)}</div></div>
  </article>`;
}
export function renderIndieResults(ui){
  const {rows,total,chosen}=indieCatalog(ui);
  const shown=rows.slice(0,Math.max(1,Number(ui.indieLimit)||30));
  const searchTerm=String(ui.indieQuery||'').trim().normalize('NFKC').toLocaleLowerCase();
  const fresh=new Set(store.groups.filter(g=>g.source==='itch').flatMap(g=>(g.items||[]).map(i=>i.app_key)));
  const archived=searchTerm&&chosen==='all'?(store.labArchive||[]).filter(item=>item.source==='itch'&&!fresh.has(item.app_key)&&
    [item.name,item.developer,item.summary,...(item.tags||[])].join(' ').normalize('NFKC').toLocaleLowerCase().includes(searchTerm)).slice(0,50):[];
  const groups=store.groups.filter(g=>g.source==='itch'&&(chosen==='all'||g.feed===chosen));
  const dates=[...new Set(groups.map(g=>g.data_date).filter(Boolean))].sort();
  const state=groups.some(g=>g.is_stale)?' · 일부 이전 기록 포함':'';
  const headingDate=dates.length===1?formatDate(dates[0]):dates.length?`${formatDate(dates[0])}~${formatDate(dates.at(-1))}`:'관측일 없음';
  const title=chosen==='all'?'전체 인디':FEED_LABEL[chosen]||chosen;
  return `<section class="panel indie-results-panel"><div class="indie-results-head"><div><h2>${esc(title)} <span class="indie-count">현재 피드 ${rows.length}개${archived.length?` · 보관 분석 ${archived.length}개`:``}</span></h2><p class="small-copy">${chosen==='all'?`${groups.length}개 피드에서 중복을 제거한 ${total}개 게임`:`해당 피드 ${total}개 게임`} · 관측 ${headingDate}${state}</p></div><span class="indie-view-mode">☷ 목록 보기</span></div>
    ${archived.length?`<div class="indie-archive-search"><h3>보관된 인디 분석 ${archived.length}개</h3><p class="small-copy">현재 itch.io 피드에는 보이지 않지만 연구실에 분석이 보관되어 있습니다. 최신 피드에 등장했다고 표시하지 않습니다.</p><div class="indie-list">${archived.map(item=>`<article class="indie-list-row"><span class="indie-list-image">${safeUrl(item.icon_url)?`<img src="${attr(safeUrl(item.icon_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span aria-hidden="true">✧</span>'}</span><div class="indie-list-info"><strong class="indie-list-title">${esc(indieDisplayName(item.name).name)}</strong><p class="indie-list-summary">${esc(item.summary||'AI 분석 내용 보관')}</p><div class="indie-list-tags"><span class="indie-feed-tag">현재 피드 미관측</span></div></div><div class="indie-list-end">${item.has_ai?`<a class="text-link" href="#/lab/analysis?app=${encodeURIComponent(item.app_key)}">개발 분석 →</a>`:''}${safeUrl(item.detail_url)?`<a class="text-link" href="${attr(safeUrl(item.detail_url))}" target="_blank" rel="noopener noreferrer">원본 ↗</a>`:''}</div></article>`).join('')}</div></div>`:''}
    ${rows.length?`<div class="indie-list" aria-label="인디 게임 목록">${shown.map(indieListRow).join('')}</div>${shown.length<rows.length?`<div class="indie-list-more"><button type="button" class="button ghost small" data-indie-more="true">더 보기 (${rows.length-shown.length}개 남음)</button></div>`:''}`:archived.length?'<p class="small-copy" style="margin-top:10px">현재 피드에서 일치하는 항목이 없습니다. 위의 보관된 분석 자료를 확인하세요.</p>':empty('해당하는 인디 게임이 없습니다.','검색어나 피드 조건을 바꾸어 확인해 주세요.')}</section>`;
}
export function renderIndie(ui) {
  const feeds=availableIndieFeeds();
  const active=[...feeds,'all'].includes(ui.feed)?ui.feed:'all';
  return `${heading('INDIE DISCOVERIES','인디 발견','itch.io에서 실제 수집된 인디 게임을 작은 목록으로 빠르게 살펴보세요.')}
    <section class="panel indie-tools" aria-label="인디 탐색 조건">
      <div class="indie-tools-top"><strong>게임 찾기</strong><span class="small-copy">피드 출처는 인기 순위가 아닙니다.</span></div>
      <div class="chips indie-feed-tabs" role="group" aria-label="수집 피드 선택">${[['all','전체 인디'],...feeds.map(f=>[f,FEED_LABEL[f]||f])].map(([f,label])=>`<button type="button" class="chip ${active===f?'selected':''}" data-feed="${f}" aria-pressed="${active===f}">${esc(label)}</button>`).join('')}</div>
      <div class="indie-tools-bottom"><label class="indie-query-label">게임 이름·소개 검색<input type="search" data-indie-query="true" value="${attr(ui.indieQuery||'')}" placeholder="예: 퍼즐, 요리, 호러" autocomplete="off"></label>
        <label class="indie-sort-label">정렬<select data-indie-sort="true"><option value="feed" ${(ui.indieSort||'feed')==='feed'?'selected':''}>수집 피드 순서</option><option value="recent" ${ui.indieSort==='recent'?'selected':''}>최근 첫 관측</option><option value="name" ${ui.indieSort==='name'?'selected':''}>이름순</option></select></label></div>
    </section><div id="indie-results">${renderIndieResults(ui)}</div>
    <p class="small-copy indie-disclaimer">※ 첫 관측일은 우리 사이트가 처음 수집한 날짜이며 실제 출시일이 아닙니다. itch.io 피드 표시 위치는 인기 순위·매출·다운로드 순위가 아닙니다.</p>`;
}
// A saved candidate can outlive the 90-day research index. Never imply that
// comparing it is supported until the actual index has been checked.
function labLinks(key,ui,{detail=false}={}){
  const status=ui.labAvailability?.status;
  const cls=detail?'button ghost':'text-link';
  if(status==='loading'||status==='idle')return '<span class="lab-link-state">연구실 후보 확인 중…</span>';
  if(status==='error')return '<span class="lab-link-state lab-link-error">연구실 연결 확인 실패</span>'+(detail?'<button type="button" class="text-link" data-retry-lab-availability="true">다시 확인</button>':'');
  if(status==='ready'&&!ui.labAvailability.keys?.has(key))return '<span class="lab-link-state" title="현재 연구실 인덱스에 없는 후보입니다. 저장된 원본과 메모는 유지됩니다.">연구실 자료 없음 · 비교 불가</span>';
  const href=`#/lab/analysis?app=${encodeURIComponent(key)}`;
  return `<a class="${cls}" href="${attr(href)}">${detail?'연구실에서 보기':'연구실 보기'}</a><button type="button" class="${cls}" data-lab-action="toggle-compare" data-key="${attr(key)}">+ 비교</button>`;
}
export function renderFavorites(ui={}) {
  const saved=getFavorites();
  const status=ui.favoriteStatus||'all',sort=ui.favoriteSort||'recent',query=ui.favoriteQuery||'';
  const rows=filterFavorites(saved,{status,sort,query});
  const visible=rows.slice(0,ui.favoriteLimit||30);
  const statusButtons=[['all','전체',saved.length],...FAVORITE_STATUSES.map(s=>[s,s,saved.filter(x=>x.status===s).length])];
  const toolbar=`<section class="panel favorites-tools" aria-label="관심 목록 필터">
    <div class="favorites-toolbar-top"><label class="fav-search-label">저장한 후보 검색<input type="search" data-favorite-query="true" value="${attr(query)}" placeholder="앱 이름, 메모, 개발사 검색" autocomplete="off"></label>
      <label class="fav-sort-label">정렬<select class="field-select" data-favorite-sort="true"><option value="recent" ${sort==='recent'?'selected':''}>최근 저장순</option><option value="oldest" ${sort==='oldest'?'selected':''}>오래된 저장순</option><option value="name" ${sort==='name'?'selected':''}>이름순</option><option value="status" ${sort==='status'?'selected':''}>검토 상태순</option></select></label></div>
    <div class="fav-status-tabs" aria-label="검토 상태 필터">${statusButtons.map(([key,label,count])=>`<button type="button" class="fav-status-tab ${status===key?'selected':''}" data-favorite-filter="${attr(key)}" aria-pressed="${status===key}">${esc(label)} <span>${count}</span></button>`).join('')}</div>
  </section>`;
  const list=visible.map(row=>{
    const variants=store.labVariants?.get(row.app_key)||[];
    const current=store.appMap.get(row.app_key)||variants.map(v=>store.appMap.get(v.app_key)).find(Boolean);
    // Prefer today's collected record, but use the private snapshot when absent.
    const item={...row,...current,app_key:row.app_key,detail_url:current?.detail_url||row.detail_url,icon_url:current?.icon_url||row.icon_url,name:current?.name||row.name};
    const missing=!current;
    const storeBadges=variants.length>1?`<span class="lab-store-badges">${variants.map(v=>`<span class="lab-store-badge lab-store-${attr(v.source)}">${esc(SOURCE_LABEL[v.source]||v.source)}</span>`).join('')}</span>`:'';
    const external=safeUrl(item.detail_url);
    return `<article class="fav-list-row">
      <div class="fav-list-icon">${icon(item)}</div>
      <div class="fav-list-body">
        <div class="fav-list-titleline"><a class="item-primary" href="${attr(detailsHref(row.app_key,{from:'favorites'}))}">${esc(item.name||row.name)}</a>${missing?'<span class="info-tag warn">최신 목록 밖</span>':''}</div>
        <div class="fav-list-meta">${storeBadges||esc(SOURCE_LABEL[row.source]||row.source)}${item.developer?` · ${esc(item.developer)}`:''} · 저장 ${formatDate(row.added_at)}${row.first_seen?` · 첫 관측 ${formatDate(row.first_seen)}`:''}</div>
        ${row.note?`<p class="fav-list-note">${esc(row.note)}</p>`:`<p class="fav-list-note fav-placeholder">아직 아이디어 메모가 없습니다.</p>`}
        <div class="fav-list-links"><a class="text-link" href="${attr(detailsHref(row.app_key,{from:'favorites'}))}">상세·메모</a>${external?`<a class="text-link" href="${attr(external)}" target="_blank" rel="noopener noreferrer">원본 페이지 ↗</a>`:''}${labLinks(row.app_key,ui)}</div>
      </div>
      <div class="fav-list-manage"><label>검토 상태<select class="field-select" data-favorite-status="${attr(row.app_key)}">${FAVORITE_STATUSES.map(s=>`<option value="${attr(s)}" ${row.status===s?'selected':''}>${esc(s)}</option>`).join('')}</select></label><button class="icon-button saved" type="button" data-fav="${attr(row.app_key)}" title="관심 목록에서 제외" aria-label="${attr(item.name||row.name)} 관심 목록에서 제외">★</button></div>
    </article>`;
  }).join('');
  return `${heading('YOUR IDEAS','관심 목록','눈에 띈 후보를 저장하고 검토 상태·아이디어 메모를 이어서 관리합니다.')}
    <div class="fav-toolbar"><span class="small-copy">${saved.length}개 저장됨 · 이 브라우저에만 보관</span><div><button class="button ghost small" id="favorites-import">↥ JSON 가져오기</button><button class="button outline-blue small" id="favorites-export">↧ JSON 백업</button></div><input id="favorites-file" class="sr-only" type="file" accept="application/json,.json"></div>
    ${saved.length?`${toolbar}<section class="panel fav-list-panel"><div class="fav-list-head"><strong>검토 후보 ${rows.length}개</strong><span class="small-copy">상태는 목록에서 변경하고, 아이디어 노트는 상세에서 편집할 수 있습니다.${ui.labAvailability?.status==='error'?' <button type="button" class="text-link" data-retry-lab-availability="true">연구실 연결 다시 확인</button>':''}</span></div>${list||empty('조건에 맞는 저장 후보가 없습니다.','검색어나 검토 상태를 변경해 보세요.')} ${visible.length<rows.length?`<div class="fav-more"><button type="button" class="button ghost" data-favorite-more="true">더 보기 (${visible.length}/${rows.length})</button></div>`:''}</section>`:empty('아직 저장한 앱·게임이 없습니다.','앱 탐색·게임 탐색·인디 발견에서 ☆ 버튼을 눌러 보세요.')}
    <p class="small-copy fav-storage-note">※ 메모·상태는 공개 서버에 업로드하지 않습니다. 다른 PC로 옮기려면 JSON 백업을 이용하세요. ‘최신 목록 밖’은 수집 목록에서 보이지 않는다는 뜻이며 앱 삭제·서비스 종료를 의미하지 않습니다.</p>`;
}
export function renderDetail(key,ui) {
  const item=store.appMap.get(key)||getFavorite(key);
  if(!item)return `${heading('DETAIL','자료를 찾을 수 없습니다.','현재 수집 목록에 이 앱·게임이 없습니다.')}<a class="button ghost" href="#/home">홈으로</a>`;
  const refs=store.refs.get(key)||[];
  const preferred=refs.find(({group})=> group.country===ui.detailContext.country && group.source===ui.detailContext.source && group.category===ui.detailContext.category && group.chart===ui.detailContext.chart) || refs[0];
  const g=preferred?.group||{};
  const fav=getFavorite(key);
  const isIndie=key.startsWith('itch:');
  const source=key.split(':')[0];
  const external=safeUrl(item.detail_url);
  const linkedStores=store.labVariants?.get(key)||[];
  const linkedStoreLinks=linkedStores.length>1?`<div class="lab-store-badges detail-store-badges">${linkedStores.map(v=>`<a class="lab-store-badge lab-store-${attr(v.source)}" href="${attr(detailsHref(v.app_key,{from:ui.detailFrom||'lab',labtab:ui.detailLabTab||'radar'}))}">${esc(SOURCE_LABEL[v.source]||v.source)} 상세</a>${safeUrl(v.detail_url)?`<a class="small-copy" href="${attr(safeUrl(v.detail_url))}" target="_blank" rel="noopener noreferrer">↗ 스토어</a>`:''}`).join('')}</div>`:'';
  const release=source==='apple' && /^\d{4}-\d{2}-\d{2}$/.test(String(item.release_date||'').slice(0,10))?item.release_date:'';
  const contextOptions=refs.filter(x=>Number.isFinite(Number(x.item.rank))&&x.item.rank!=null).slice()
    .sort((a,b)=>(a.group.source+a.group.country+a.group.category).localeCompare(b.group.source+b.group.country+b.group.category))
    .map(({group,item:entry})=>`<option value="${attr([group.country,group.source,group.chart,group.category].join('|'))}" ${g.country===group.country&&g.source===group.source&&g.category===group.category&&g.chart===group.chart?'selected':''}>${esc(`${COUNTRY_LABEL[group.country]||group.country} · ${SOURCE_LABEL[group.source]} · ${CATEGORY_LABEL[group.category]||group.category} · ${group.chart==='top_paid'?'유료':'무료'} · ${entry.rank}위`)}</option>`).join('');
  const countryBoxes=['US','JP','KR'].map(c=>{
    const result=refs.find(x=>x.group.country===c && x.group.source===g.source && x.group.chart===g.chart && x.group.category===g.category);
    const state=result?groupAvailability(result.group):'empty';
    return `<div class="detail-country ${state==='previous'?'is-previous':''}"><span>${esc(COUNTRY_LABEL[c])}</span><strong>${result?.item?.rank?`${esc(result.item.rank)}위`:'관측 없음'}</strong><span>${result?.group?.data_date?`${state==='previous'?'이전 기록 · ':''}${formatDate(result.group.data_date)}`:'선택한 차트 기준'}</span></div>`;
  }).join('');
  const chartName= !isIndie && g.source?`${COUNTRY_LABEL[g.country]||g.country} · ${SOURCE_LABEL[g.source]||g.source} · ${CATEGORY_LABEL[g.category]||g.category} · ${g.chart==='top_paid'?'유료':'무료'}`:'';
  const first=item.first_seen?formatDate(item.first_seen):'미확인';
  const discoveryStatus=g.data_date?`${g.is_stale?'이전 기록 · ':''}${formatDate(g.data_date)}`:'현재 차트에 없음';
  const observedContext=!isIndie && g.source?`<span class="detail-evidence-context">현재 선택한 관측: ${esc(chartName)}</span>`:
    isIndie?'<span class="detail-evidence-context">itch.io 피드 관측 · 인기 순위가 아닙니다.</span>':'<span class="detail-evidence-context">현재 차트의 관측 기록이 없습니다.</span>';
  const statCells=[
    ['우리 사이트 첫 관측',first,'실제 출시일과 다릅니다'],
    ['선택된 차트 관측일',discoveryStatus,g.is_stale?'이전 정상 자료':'실제 수집 기록 기준'],
    ...(release?[['App Store 출시일',formatDate(release),'스토어 제공 날짜']]:[]),
    ['수집 목록 발견',`${refs.length}곳`,'국가·분류·피드를 합산한 노출 수']
  ];
  const sourceOverview=`<section class="panel detail-section detail-observation" aria-label="수집 관측 정보"><div class="detail-section-head"><h2>수집 관측 정보</h2><span class="info-tag blue">실제 수집 자료</span></div>${observedContext}<div class="detail-facts">${statCells.map(([label,value,help])=>`<div class="detail-fact"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(help)}</small></div>`).join('')}</div>
    ${!release?'<p class="small-copy detail-limitation">실제 출시일은 이 자료에 포함되어 있지 않습니다. 첫 관측일을 출시일로 표시하지 않습니다.</p>':''}</section>`;
  const indieFeeds=[...new Set(refs.map(x=>x.group.feed).filter(Boolean))];
  const indieEvidence=`<section class="panel detail-section"><h2>인디 피드 발견 기록</h2><p class="small-copy">피드 내 위치는 인기 순위·다운로드·판매량이 아닙니다.</p><div class="detail-indie-feeds">${indieFeeds.map(feed=>{
    const found=refs.find(x=>x.group.feed===feed);
    return `<div><strong>${esc(FEED_LABEL[feed]||feed)}</strong><span>${found?.item?.position?`피드 ${esc(found.item.position)}번째 · `:''}${formatDate(found?.group?.data_date)}${found?.group?.is_stale?' · 이전 기록':''}</span></div>`;
  }).join('')||'<p>최신 피드 관측 자료 없음</p>'}</div></section>`;
  const ranks=`<section class="panel detail-section"><div class="detail-section-head"><h2>국가별 순위·이력</h2>${g.is_stale?staleTag(g):''}</div>
    ${contextOptions?`<p class="small-copy">같은 스토어·차트·분류에서만 국가를 비교합니다. 서로 다른 순위를 합산하지 않습니다.</p>
    <label for="detail-context" class="detail-field-label">관측 차트 선택</label><select class="field-select" id="detail-context">${contextOptions}</select>
    <div class="ranks-inline detail-ranks">${countryBoxes}</div><div class="detail-history-top"><div><h3>순위 흐름</h3><p class="small-copy">${esc(chartName)} · ${formatDate(g.data_date)} 기준</p></div><div class="chips">${[7,30,90].map(n=>`<button class="chip ${ui.range===n?'selected':''}" data-range="${n}" aria-pressed="${ui.range===n}">${n}일</button>`).join('')}</div></div>
    <div id="detail-history" class="detail-history-box">순위 기록을 확인하고 있습니다.</div>`:'<p class="small-copy">현재 표시 가능한 순위 기록이 없습니다.</p>'}</section>`;
  const descriptionPanel=`<section class="panel detail-section detail-description"><h2>앱·게임 소개</h2>${item.description?`<p>${esc(item.description)}</p>`:`<p class="small-copy">수집된 소개 문구가 없습니다. 기능·게임 방식을 추정하지 않으며, 제공된 경우 원본 페이지에서 확인할 수 있습니다.</p>`}${external?`<a class="text-link" href="${attr(external)}" target="_blank" rel="noopener noreferrer">원본 페이지에서 살펴보기 ↗</a>`:''}</section>`;
  const returnPage=ui.detailFrom==='favorites'?'favorites':ui.detailFrom==='lab'?'lab':ui.detailFrom==='indie'?'indie':ui.detailFrom==='home'?'home':isIndie?'indie':item.kind==='game'?'games':'apps';
  const returnHref=returnPage==='lab'?`#/lab/${['radar','features','analysis','compare','export'].includes(ui.detailLabTab)?ui.detailLabTab:'radar'}`:`#/${returnPage}`;
  const returnLabel=returnPage==='favorites'?'관심 목록으로':returnPage==='lab'?'아이디어 연구실로':returnPage==='indie'?'인디 발견으로':returnPage==='home'?'홈으로':returnPage==='games'?'게임 탐색으로':'앱 탐색으로';
  return `<div style="margin-bottom:15px"><a class="text-link" href="${attr(returnHref)}">← ${returnLabel} 돌아가기</a></div><section class="panel detail-hero">
    ${icon(item,'large')}<div class="detail-hero-main"><div class="eyebrow">APP & GAME DETAIL</div><h1>${esc(item.name)}</h1><div class="subtext">${esc(item.developer||'개발사 정보 없음')}</div><div class="detail-info">${sourceTag(source)}<span class="info-tag">${esc(item.primary_category||CATEGORY_LABEL[g.category]||'분류 미확인')}</span>${item.rating!=null&&Number.isFinite(Number(item.rating))?`<span class="info-tag">★ ${Number(item.rating).toFixed(1)}</span>`:''}</div></div>
    ${linkedStoreLinks}<div class="detail-actions">${external?`<a class="button ghost" href="${attr(external)}" target="_blank" rel="noopener noreferrer">원본 스토어 ↗</a>`:''}<button class="button outline-blue" id="copy-app">앱 정보 복사</button>${labLinks(key,ui,{detail:true})}${star(item)}</div>
    </section><div class="detail-grid"><div>${sourceOverview}${isIndie?indieEvidence:ranks}${descriptionPanel}</div>
    <aside><section class="panel detail-section"><h2>✨ 눈여겨볼 점</h2><p>${esc(candidateSentence(candidateFor(key,g.source?g:null)))}</p><p class="small-copy">순위 관측은 확인할 수 있지만, 인기 원인과 실제 구현 방식까지 증명하지는 않습니다.</p></section>
    <section class="panel detail-section"><h2>⭐ 내 아이디어 노트</h2>${!fav?`<p>관심 목록에 추가하면 여기에서 메모를 남길 수 있습니다.</p><button class="button outline-blue" id="add-detail-favorite" data-key="${attr(key)}">☆ 관심 목록에 추가</button>`:`<label class="sr-only" for="idea-note">아이디어 노트</label><textarea id="idea-note" class="note-box" maxlength="10000" placeholder="눈에 띄는 기능, 생각난 아이디어 등을 적어보세요.">${esc(fav.note)}</textarea><div class="note-actions"><select id="idea-status" class="field-select">${FAVORITE_STATUSES.map(x=>`<option ${fav.status===x?'selected':''}>${x}</option>`).join('')}</select><button id="save-note" class="button small">메모 저장</button></div>`}</section></aside></div>`;
}

export function renderHistory(points, g, range, lastDay) {
  if (!g?.source||g.source==='itch')return '';
  const end=new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return empty('기록이 없습니다.');
  const start=new Date(end.getTime()-(range-1)*86400000);
  const vals=points.filter(p=> p.source===g.source&&p.country===g.country&&p.chart===g.chart&&p.category===g.category && new Date(`${p.date}T00:00:00Z`)>=start&&new Date(`${p.date}T00:00:00Z`)<=end).sort((a,b)=>a.date.localeCompare(b.date));
  if(vals.length<2)return `<div class="empty-state" style="padding:26px 10px"><strong>${vals.length===1?`${formatDate(vals[0].date)} · ${esc(vals[0].rank)}위 관측`:'이 기간에 확인된 순위 기록이 없습니다.'}</strong><p>${vals.length===1?'관측일이 하루라 순위 상승·하락을 판단할 수 없습니다.':'해당 국가·스토어·차트·분류에서 관측된 기록이 없습니다.'}</p></div>`;
  const max=Math.max(10,...vals.map(x=>x.rank));
  const w=720,h=230,left=46,right=16,top=25,bottom=37;
  const x=d=>left+(Date.parse(`${d}T00:00:00Z`)-start.getTime())/((range-1)*86400000)*(w-left-right);
  const y=r=>top+(r-1)/Math.max(max-1,1)*(h-top-bottom);
  // Intentionally DO NOT connect dates with gaps: a missed collection must not look observed.
  const seg=[];for(let i=1;i<vals.length;i++){
    const delta=(Date.parse(vals[i].date)-Date.parse(vals[i-1].date))/86400000;
    if(delta===1)seg.push(`<line x1="${x(vals[i-1].date).toFixed(1)}" y1="${y(vals[i-1].rank).toFixed(1)}" x2="${x(vals[i].date).toFixed(1)}" y2="${y(vals[i].rank).toFixed(1)}" stroke="#3378d6" stroke-width="2.6"/>`);
  }
  const t=[1,Math.max(1,Math.ceil((max+1)/2)),max];
  return `<svg class="detail-chart" role="img" aria-label="${range}일간 ${vals.length}일 관측한 순위 흐름, 숫자가 작을수록 높은 순위" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    ${t.map(r=>`<line x1="${left}" x2="${w-right}" y1="${y(r)}" y2="${y(r)}" stroke="#e8eef5"/><text x="${left-10}" y="${y(r)+4}" text-anchor="end" font-size="12" fill="#8190a2">${r}위</text>`).join('')}
    ${seg.join('')}${vals.map(v=>`<circle cx="${x(v.date).toFixed(1)}" cy="${y(v.rank).toFixed(1)}" r="4.1" fill="#3378d6"><title>${v.date}: ${v.rank}위</title></circle>`).join('')}
    <text x="${left}" y="${h-9}" font-size="12" fill="#8190a2">${formatDate(start.toISOString())}</text><text x="${w-right}" y="${h-9}" text-anchor="end" font-size="12" fill="#8190a2">${formatDate(lastDay)}</text>
  </svg><div class="history-summary"><span>관측 <b>${vals.length}일</b></span><span>첫 기록 <b>${formatDate(vals[0].date)} · ${esc(vals[0].rank)}위</b></span><span>마지막 기록 <b>${formatDate(vals[vals.length-1].date)} · ${esc(vals[vals.length-1].rank)}위</b></span></div><p class="small-copy">수집한 날짜만 표시합니다. 빠진 날짜의 순위는 추정하지 않고 선을 연결하지 않습니다.</p>`;
}
