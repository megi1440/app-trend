import { store, esc, attr, safeUrl, formatDate, SOURCE_LABEL, COUNTRY_LABEL, CATEGORY_LABEL,
         APP_CATEGORIES, GAME_CATEGORIES, FEED_LABEL, REASON_LABEL,
         groupsFor, detailsHref, candidateSentence, candidateFor } from './data.js';
import { getFavorites, hasFavorite, getFavorite } from './favorites.js';

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

export function renderHome(ui) {
  const latest=store.latest;
  const candidates=store.trends?.candidates||[];
  const picked=[], used=new Set();
  // Diversify recommendation source/type; never fabricate a reason from a rank alone.
  for (const kind of ['rising_7d','multi_country','overseas_interest','newly_seen','indie_discovery','consistent_30d']) {
    for (const c of candidates.filter(c=>c.reason_code===kind)) {
      if(used.has(c.app_key))continue;
      const refs=store.refs.get(c.app_key)||[];
      const hit=refs.find(({group})=>!group.is_stale)||refs[0];
      if(!hit)continue;
      picked.push({candidate:c,...hit});used.add(c.app_key);
      if(picked.length>=6)break;
      if(picked.filter(x=>x.candidate.reason_code===kind).length>= (kind==='overseas_interest'?3:2))break;
    }
    if(picked.length>=6)break;
  }
  const cards=picked.map(({candidate,group,item})=>`<article class="panel discovery-card">
    <div class="card-topline"><span class="info-tag ${candidate.reason_code==='rising_7d'?'green':'blue'}">${esc(REASON_LABEL[candidate.reason_code]||'아이디어 추천')}</span>${star(item)}</div>
    <a class="card-content" href="${attr(detailsHref(item.app_key, group))}">${icon(item)}<div style="min-width:0"><div class="card-title">${esc(item.name)}</div><div class="card-meta">${esc(SOURCE_LABEL[group.source]||group.source)} · ${esc(CATEGORY_LABEL[group.category]||FEED_LABEL[group.feed]||'게임')}</div></div></a>
    <p class="card-note">${esc(candidateSentence(candidate))}</p><div class="card-bottom"><span class="small-copy">${group.country==='GLOBAL'?'인디':esc(COUNTRY_LABEL[group.country]||'')} · ${formatDate(group.data_date)}</span><a class="text-link" href="${attr(detailsHref(item.app_key,group))}">자세히 보기 →</a></div>
  </article>`).join('');
  const mini=(kind,cat)=>{
    const country = ui.country==='ALL'?'US':ui.country;
    const g=groupsFor({kind,country,source:'google',category:cat})[0]||groupsFor({kind,country,source:'apple',category:cat})[0];
    if(!g || !g.items.length)return empty('표시할 순위가 없습니다.','수집 실패 또는 자료 부족일 수 있습니다.');
    return `<div class="panel mini-list">${g.items.slice(0,6).map(item=>`<div class="mini-row"><span class="rank-number">${item.rank}</span>${icon(item)}<a title="${attr(item.name)}" href="${attr(detailsHref(item.app_key,g))}">${esc(item.name)}</a><span class="meta-side">${esc(SOURCE_LABEL[g.source])}</span></div>`).join('')}<div class="small-copy" style="padding:8px">${staleTag(g)} 데이터 ${formatDate(g.data_date)}</div></div>`;
  };
  const indie=(store.groups.find(g=>g.source==='itch' && g.feed==='featured')||{items:[]}).items.slice(0,4);
  return `<section class="hero"><div><p class="eyebrow">YOUR IDEA SPOT</p><h1>요즘 눈여겨볼 앱과 게임</h1><p class="subtext">미국·일본·한국의 인기 흐름을 살펴보고, 다음에 만들 아이디어를 찾아보세요.<br>기록은 매일 자동으로 쌓입니다. 현재 기준 ${formatDate(latest?.data_date)}.</p></div><div class="hero-decor" aria-hidden="true">✧</div></section>
    <div class="section-heading"><div><h2>✨ 아이디어 추천</h2><p>실제로 수집된 순위와 발견 기록을 기반으로 골랐습니다.</p></div></div>
    <section class="three-cards">${cards||empty('추천 데이터가 아직 없습니다.','수집된 앱·게임이 늘어나면 이곳에 표시합니다.')}</section>
    <div class="section-heading"><div><h2>🔎 인기 순위 빠르게 보기</h2><p>국가를 바꾸면 아래 목록도 함께 바뀝니다.</p></div>${countryButtons(ui.country)}</div>
    <section class="home-two"><div><div class="section-heading"><h2>📱 인기 앱</h2><a class="text-link" href="#/apps">앱 탐색 →</a></div>${mini('app','all_apps')}</div><div><div class="section-heading"><h2>🎮 인기 게임</h2><a class="text-link" href="#/games">게임 탐색 →</a></div>${mini('game','all_games')}</div></section>
    <div class="section-heading"><div><h2>💡 인디에서 발견</h2><p>인기 차트와는 별개로, 새로운 게임 아이디어를 살펴보세요.</p></div><a class="text-link" href="#/indie">인디 더 보기 →</a></div>
    <section class="indie-grid">${indie.map(item=>indieCard(item,'featured')).join('')||empty()}</section>
    <p class="small-copy" style="margin-top:25px">※ '처음 발견'은 이 사이트가 수집한 최초 날짜이며 신규 출시를 의미하지 않습니다. 순위만으로 인기 원인이나 개발 난이도를 판단하지 않습니다.</p>`;
}

function select(name, options, value){return `<select class="field-select" data-filter="${name}" aria-label="${name}">${options.map(([key,label])=>`<option value="${attr(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select>`;}
function groupListRows(group,ui) {
  const items = [...(group.items||[])];
  if(ui.query) {
    const query=ui.query.toLocaleLowerCase();
    for(let i=items.length-1;i>=0;i--)if(!`${items[i].name} ${items[i].developer} ${items[i].primary_category}`.toLocaleLowerCase().includes(query)) items.splice(i,1);
  }
  const trend=(item)=> (store.candidates.get(item.app_key)||[]).find(c=>c.reason_code==='rising_7d' && c.evidence.source===group.source && c.evidence.country===group.country && c.evidence.category===group.category && c.evidence.chart===group.chart);
  if(ui.sort==='rising') {const only=items.filter(trend);only.sort((a,b)=>(trend(b)?.evidence.change||0)-(trend(a)?.evidence.change||0));return only;}
  if(ui.sort==='new') return items.filter(item=>item.first_seen===store.latest.data_date).sort((a,b)=>a.rank-b.rank);
  if(ui.sort==='consistent')return items.filter(item=>(store.candidates.get(item.app_key)||[]).some(c=>c.reason_code==='consistent_30d')).sort((a,b)=>a.rank-b.rank);
  return items.sort((a,b)=>a.rank-b.rank);
}
export function renderExplore(kind,ui) {
  const isGame=kind==='game', categoryList=isGame?GAME_CATEGORIES:APP_CATEGORIES, activeCat=categoryList.includes(ui.category)?ui.category:categoryList[0];
  const results=groupsFor({kind,country:ui.country,source:ui.source,category:activeCat,chart:ui.price});
  const renderG=(g)=>{
    const items=groupListRows(g,ui);const displayed=items.slice(0,ui.limit);
    return `<section class="store-section"><div class="store-head"><h3>${esc(COUNTRY_LABEL[g.country])} · ${esc(SOURCE_LABEL[g.source])} · ${esc(CATEGORY_LABEL[g.category])}</h3><div class="chips">${staleTag(g)} <span class="info-tag">${formatDate(g.data_date)}</span></div></div>
    <div class="panel results-panel"><div class="results-header"><div><strong>${esc(CATEGORY_LABEL[g.category])} ${g.chart==='top_paid'?'유료':'무료'} 인기</strong><p class="subtext">${esc(SOURCE_LABEL[g.source])} · ${items.length}개 표시 가능 · ${formatDate(g.data_date)}</p></div></div>
    ${items.length ? `<div class="table-scroll"><table class="rank-table"><thead><tr><th>순위</th><th>앱·게임</th><th>카테고리</th><th>평점</th><th>변화</th><th>관심</th></tr></thead><tbody>${displayed.map(item=>{
      const recent=(store.candidates.get(item.app_key)||[]).find(c=>c.reason_code==='rising_7d' && c.evidence.source===g.source && c.evidence.country===g.country && c.evidence.chart===g.chart && c.evidence.category===g.category);
      const trendLabel=recent?`<span class="info-tag green">▲ ${recent.evidence.change}</span>`:`<span class="muted" title="비교 가능한 관측 기록이 아직 없습니다">—</span>`;
      return `<tr><td class="rank-cell">${item.rank}</td><td class="item-col"><a class="item-name-link" href="${attr(detailsHref(item.app_key,g))}">${icon(item)}<span class="item-text"><span class="item-primary">${esc(item.name)}</span><br><span class="item-secondary">${esc(item.developer||'개발사 정보 없음')}</span></span></a></td><td class="category-col"><span class="small-copy">${esc(item.primary_category||CATEGORY_LABEL[g.category])}</span></td><td>${item.rating!=null?Number(item.rating).toFixed(1):'—'}</td><td>${trendLabel}</td><td>${star(item)}</td></tr>`;
    }).join('')}</tbody></table></div>${items.length>displayed.length?`<div class="table-foot"><button class="button ghost small" data-more="true">더 보기 (${items.length-displayed.length}개 남음)</button></div>`:''}` : empty(ui.sort==='rising'?'7일 상승 기록이 없습니다.':ui.sort==='new'?'이번에 새로 발견한 항목이 없습니다.':'선택한 조건에 자료가 없습니다.', ui.sort!=='popular'?'비교할 날짜가 더 쌓이면 새로운 결과를 확인할 수 있습니다.':'수집 실패 또는 아직 수집되지 않은 조합일 수 있습니다.')}
    </div></section>`;
  };
  return `${heading('APP & GAME CHARTS',isGame?'게임 탐색':'앱 탐색',isGame?'퍼즐부터 RPG까지 장르별 인기 게임과 순위 변화를 살펴보세요.':'생활·생산성·도구 등 다양한 앱을 국가와 스토어별로 확인하세요.',`<button class="button ghost filter-toggle" data-toggle-filters="true">☷ 조건 선택</button>`)}
    <div class="explore-layout"><aside class="panel filters ${ui.filtersOpen?'mobile-open':''}" id="filter-panel"><h2>조건 선택</h2>
      <div class="filter-group"><label class="filter-label">국가</label>${select('country',[['US','🇺🇸 미국'],['JP','🇯🇵 일본'],['KR','🇰🇷 한국'],['ALL','🌏 3개국 비교']],ui.country)}</div>
      <div class="filter-group"><label class="filter-label">스토어</label>${select('source',[['google','Google Play'],['apple','App Store'],['all','전체 스토어 (각각 표시)']],ui.source)}</div>
      <div class="filter-group"><label class="filter-label">종류</label><div class="segmented"><button data-price="top_free" class="${ui.price==='top_free'?'selected':''}" aria-pressed="${ui.price==='top_free'}">무료</button><button data-price="top_paid" class="${ui.price==='top_paid'?'selected':''}" aria-pressed="${ui.price==='top_paid'}">유료</button></div></div>
      <div class="filter-group"><label class="filter-label">${isGame?'게임 장르':'앱 카테고리'}</label>${select('category',categoryList.map(x=>[x,CATEGORY_LABEL[x]]),activeCat)}</div>
      <div class="filter-group"><label class="filter-label">탐색 방식</label>${select('sort',[['popular','인기순'],['rising','7일 순위 상승'],['new','처음 발견'],['consistent','꾸준한 인기']],ui.sort)}</div>
      <p class="filter-help">유료 차트는 전체 앱·전체 게임 기준입니다. 일부 카테고리와 날짜는 자료가 없을 수 있습니다.</p>
    </aside><div style="min-width:0">${results.length?results.map(renderG).join(''):empty('이 조건의 순위표가 없습니다.','스토어에서 제공하지 않거나 현재 수집 설정에 포함되지 않은 차트입니다.')}<p class="small-copy">※ Apple과 Google Play의 순위는 합산하지 않습니다. 7일 상승은 같은 국가·스토어·차트에서 비교 가능한 날짜가 있을 때만 표시됩니다.</p></div></div>`;
}

export function indieCard(item,feed) {
  return `<article class="panel indie-card"><a href="${attr(detailsHref(item.app_key))}">${safeUrl(item.icon_url)?`<img class="indie-cover" src="${attr(safeUrl(item.icon_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<div class="indie-cover-placeholder">✧</div>`}</a>
      <div class="indie-body"><a href="${attr(detailsHref(item.app_key))}"><div class="card-title">${esc(item.name)}</div></a><div class="card-meta">itch.io · ${esc(FEED_LABEL[feed]||'인디 게임')}</div><div class="card-bottom"><a class="text-link" href="${attr(detailsHref(item.app_key))}">살펴보기 →</a>${star(item)}</div></div></article>`;
}
export function renderIndie(ui) {
  const feeds=['featured','new','puzzle','idle'];const current=feeds.includes(ui.feed)?ui.feed:'featured';
  const group=store.groups.find(g=>g.source==='itch'&&g.feed===current);
  const items=(group?.items||[]).filter(x=>!ui.query||`${x.name} ${x.developer}`.toLocaleLowerCase().includes(ui.query.toLocaleLowerCase()));
  return `${heading('INDIE DISCOVERIES','인디 발견','작은 팀과 개인 개발자의 독특한 게임을 가볍게 살펴보세요.')}
    <div class="chips" style="margin-bottom:17px">${feeds.map(f=>`<button class="chip ${current===f?'selected':''}" data-feed="${f}">${FEED_LABEL[f]}</button>`).join('')}</div>
    <div class="small-copy" style="margin-bottom:16px">출처: itch.io · ${group?.data_date?'마지막 기록 '+formatDate(group.data_date):'자료 없음'} ${group?.is_stale?'<span class="info-tag warn">이전 데이터</span>':''} · 표시 순서는 인기 순위와 다릅니다.</div>
    ${items.length?`<div class="indie-grid">${items.map(item=>indieCard(item,current)).join('')}</div>`:empty('인디 게임 자료가 없습니다.','다음 RSS 수집 결과를 확인해 주세요.')}`;
}
export function renderFavorites() {
  const rows=getFavorites();
  return `${heading('YOUR IDEAS','관심 목록','눈에 띄는 앱과 게임, 떠오른 아이디어를 모아두는 공간입니다.')}
    <div class="fav-toolbar"><button class="button ghost" id="favorites-import">↥ 가져오기 (JSON)</button><button class="button outline-blue" id="favorites-export">↧ 내보내기 (JSON)</button><input id="favorites-file" class="sr-only" type="file" accept="application/json,.json"></div>
    <div class="panel">${rows.length?rows.map(row=>{
      const item=store.appMap.get(row.app_key)||row;
      return `<div class="fav-row">${icon(item)}<div class="fav-details"><a class="item-primary" href="${attr(detailsHref(row.app_key))}">${esc(item.name||row.name)}</a><div class="fav-note">${esc(row.note||'아직 작성한 아이디어 노트가 없습니다.')}</div><div class="small-copy">${esc(SOURCE_LABEL[row.source]||row.source)} · ${formatDate(row.added_at)} · ${esc(row.status)}</div></div><div class="fav-controls"><a class="button ghost small" href="${attr(detailsHref(row.app_key))}">메모 보기</a><a class="button outline-blue small" href="#/lab/analysis?app=${encodeURIComponent(row.app_key)}">연구실에서 보기</a><button class="button ghost small" data-lab-action="toggle-compare" data-key="${attr(row.app_key)}">+ 비교</button>${star(item)}</div></div>`;
    }).join(''):empty('아직 저장한 앱·게임이 없습니다.','앱 탐색·게임 탐색·인디 발견에서 ☆ 버튼을 눌러 보세요.')}</div><p class="small-copy" style="margin-top:13px">※ 관심 목록과 아이디어 노트는 이 브라우저에만 저장됩니다. 다른 PC에서 사용하려면 JSON 백업·가져오기를 이용하세요.</p>`;
}
export function renderDetail(key,ui) {
  const item=store.appMap.get(key)||getFavorite(key);
  if(!item)return `${heading('DETAIL','자료를 찾을 수 없습니다.','현재 수집 목록에 이 앱·게임이 없습니다.')}<a class="button ghost" href="#/home">홈으로</a>`;
  const refs=store.refs.get(key)||[];
  const preferred=refs.find(({group})=> group.country===ui.detailContext.country && group.source===ui.detailContext.source && group.category===ui.detailContext.category && group.chart===ui.detailContext.chart) || refs[0];
  const g=preferred?.group||{};
  const fav=getFavorite(key);
  const countryBoxes=['US','JP','KR'].map(c=>{
    const candidates=refs.filter(x=>x.group.country===c && x.group.source===g.source && x.group.chart===g.chart && x.group.category===g.category);
    const result=candidates[0];
    return `<div><span>${esc(COUNTRY_LABEL[c])}</span><strong>${result?.item?.rank?`${result.item.rank}위`:'기록 없음'}</strong><span>${result?.group?.data_date?formatDate(result.group.data_date):'해당 차트 관측 없음'}</span></div>`;
  }).join('');
  const contextOptions=refs.filter(x=>x.item.rank).slice().sort((a,b)=> (a.group.source+a.group.country+a.group.category).localeCompare(b.group.source+b.group.country+b.group.category)).map(({group,item})=>`<option value="${attr([group.country,group.source,group.chart,group.category].join('|'))}" ${g.country===group.country&&g.source===group.source&&g.category===group.category&&g.chart===group.chart?'selected':''}>${esc(`${COUNTRY_LABEL[group.country]||group.country} · ${SOURCE_LABEL[group.source]} · ${CATEGORY_LABEL[group.category]||FEED_LABEL[group.feed]} · ${item.rank||item.position}${item.rank?'위':'번째'}`)}</option>`).join('');
  const external=safeUrl(item.detail_url);
  return `<div style="margin-bottom:15px"><a class="text-link" href="#/${item.kind==='game'?'games':'apps'}">← 목록으로 돌아가기</a></div><section class="panel detail-hero">
    ${icon(item,'large')}<div class="detail-hero-main"><div class="eyebrow">APP & GAME DETAIL</div><h1>${esc(item.name)}</h1><div class="subtext">${esc(item.developer||'개발사 정보 없음')}</div><div class="detail-info">${sourceTag(key.split(':')[0])}<span class="info-tag">${esc(item.primary_category||'카테고리 정보 없음')}</span>${item.rating!=null?`<span class="info-tag">★ ${Number(item.rating).toFixed(1)}</span>`:''}</div></div>
    <div class="detail-actions">${external?`<a class="button ghost" href="${attr(external)}" target="_blank" rel="noopener noreferrer">원본 스토어 ↗</a>`:''}<button class="button outline-blue" id="copy-app">앱 정보 복사</button><a class="button ghost" href="#/lab/analysis?app=${encodeURIComponent(key)}">연구실에서 보기</a><button class="button ghost" data-lab-action="toggle-compare" data-key="${attr(key)}">+ 비교</button>${star(item)}</div>
    </section><div class="detail-grid"><div><section class="panel detail-section"><h2>앱·게임 소개</h2><p>${description(item,1600)}</p>${!item.description&&external?`<a class="text-link" href="${attr(external)}" target="_blank" rel="noopener noreferrer">자세한 설명은 원본에서 확인 →</a>`:''}</section>
    ${key.startsWith('itch:')?`<section class="panel detail-section"><h2>인디에서 발견</h2><p>itch.io의 공개 피드에 나타난 게임입니다. 피드 노출 순서는 판매량이나 인기 순위가 아닙니다.</p></section>`:`<section class="panel detail-section"><h2>국가별 순위</h2><p class="small-copy">같은 스토어·차트·카테고리 기준으로 표시합니다. 국가별 순위 자체의 크기를 시장 규모로 해석하지 마세요.</p><select class="field-select" id="detail-context" aria-label="순위 차트 선택">${contextOptions}</select><div class="ranks-inline" style="margin:18px 0">${countryBoxes}</div>${g.is_stale?staleTag(g):''}<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:24px"><h2 style="margin:0">순위 흐름</h2><div class="chips">${[7,30,90].map(n=>`<button class="chip ${ui.range===n?'selected':''}" data-range="${n}">${n}일</button>`).join('')}</div></div><div id="detail-history" class="empty-state" style="padding:24px">순위 기록을 확인하고 있습니다.</div></section>`}
    </div><aside><section class="panel detail-section"><h2>✨ 눈여겨볼 점</h2><p>${esc(candidateSentence(candidateFor(key,g)))}</p><p class="small-copy">인기 이유나 게임 방식에 대한 추측 대신, 확인 가능한 수집 사실만 표시합니다.</p></section>
    <section class="panel detail-section"><h2>⭐ 내 아이디어 노트</h2>${!fav?`<p>관심 목록에 추가하면 여기에서 메모를 남길 수 있습니다.</p><button class="button outline-blue" id="add-detail-favorite" data-key="${attr(key)}">☆ 관심 목록에 추가</button>`:`<label class="sr-only" for="idea-note">아이디어 노트</label><textarea id="idea-note" class="note-box" maxlength="3000" placeholder="눈에 띄는 기능, 생각난 아이디어 등을 적어보세요.">${esc(fav.note)}</textarea><div class="note-actions"><select id="idea-status" class="field-select">${['관심','살펴보는 중','개발 후보'].map(x=>`<option ${fav.status===x?'selected':''}>${x}</option>`).join('')}</select><button id="save-note" class="button small">메모 저장</button></div>`}</section></aside></div>`;
}

export function renderHistory(points, g, range, lastDay) {
  if (!g?.source||g.source==='itch')return '';
  const end=new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return empty('기록이 없습니다.');
  const start=new Date(end.getTime()-(range-1)*86400000);
  const vals=points.filter(p=> p.source===g.source&&p.country===g.country&&p.chart===g.chart&&p.category===g.category && new Date(`${p.date}T00:00:00Z`)>=start&&new Date(`${p.date}T00:00:00Z`)<=end).sort((a,b)=>a.date.localeCompare(b.date));
  if(vals.length<2)return `<div class="empty-state" style="padding:34px 10px"><strong>비교할 기록이 아직 부족합니다.</strong><p>현재 확인 가능한 관측일 ${vals.length}일. 수집이 쌓이면 날짜별 순위 흐름을 보여줍니다.</p></div>`;
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
  </svg><p class="small-copy">실제로 수집한 ${vals.length}일의 순위만 표시하며, 누락된 날짜 사이의 선은 연결하지 않습니다.</p>`;
}
