import { store, loadSnapshot, loadHistory, loadExportManifest, esc, attr, formatDate,
         SOURCE_LABEL, COUNTRY_LABEL, CATEGORY_LABEL, detailsHref, safeUrl } from './data.js';
import { renderHome, renderExplore, normalizeExploreCategory, renderIndie, renderIndieResults, renderFavorites, renderDetail, renderHistory,
         empty, icon } from './views.js';
import { toggleFavorite, getFavorites, hasFavorite, updateFavorite, exportFavorites, importFavorites, refreshFavoriteSnapshots } from './favorites.js';
import { renderLab, initLabHandlers, labAction, labChange, labInput, loadLab } from './lab.js';

const main=document.getElementById('main');
const overlay=document.getElementById('overlay');
const toast=document.getElementById('toast');
const searchInput=document.getElementById('global-search');
const defaults={country:'US',source:'google',price:'top_free',category:'all_apps',sort:'popular',limit:30,groupLimits:{},feed:'all',range:30,query:'',filtersOpen:false,detailContext:{},indieQuery:'',indieSort:'feed',indieLimit:30,favoriteStatus:'all',favoriteSort:'recent',favoriteQuery:'',favoriteLimit:30};
let saved={};
try { saved=JSON.parse(localStorage.getItem('app-trend:filters:v1')||'{}'); } catch {}
const ui={...defaults,...Object.fromEntries(Object.entries(saved).filter(([k])=>['country','source','price','sort','category','feed'].includes(k)))};
ui.labAvailability={status:'idle',keys:null}; // Asynchronously checked against the real Idea Lab index.
const validCountry=['US','JP','KR','ALL']; if(!validCountry.includes(ui.country))ui.country='US';
let ready=false,renderStamp=0,toastTimer=0;
function persistFilters(){
  try { localStorage.setItem('app-trend:filters:v1',JSON.stringify({country:ui.country,source:ui.source,price:ui.price,sort:ui.sort,category:ui.category,feed:ui.feed})); } catch {}
}
function notify(message){toast.textContent=message;toast.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('visible'),2600);}
function route(){
  const h=location.hash.replace(/^#\/?/,'')||'home';const [segment,qs]=h.split('?');const parts=segment.split('/');
  if(parts[0]==='detail'){
    let key='';try{key=decodeURIComponent(parts.slice(1).join('/'));}catch{}
    return {page:'detail',key,query:new URLSearchParams(qs||'')};
  }
  if(parts[0]==='lab')return {page:'lab', tab:parts[1]||'radar', query:new URLSearchParams(qs||'')};
  return {page: ['home','apps','games','indie','favorites','search'].includes(parts[0])?parts[0]:'home'};
}
function updateStatus(){
  if(!ready)return;
  const data=store.status;const bad=(data.groups||[]).filter(x=>x.status==='failed').length;
  document.getElementById('status-label').textContent=`${bad?'일부 자료 이전 기록 · ':'갱신 '}${formatDate(store.latest.data_date)}`;
  const dot=document.querySelector('.status-dot');dot.classList.toggle('warn',bad>0);
  dot.classList.toggle('bad',data.overall_status==='failed');
  document.getElementById('footer-date').textContent=`자료 기준 ${formatDate(store.latest.data_date)}`;
}
function safeIconResult(item){return icon(item);}
function renderSearch(){
  const q=ui.query.trim().toLocaleLowerCase();
  const grouped=new Map();
  for(const [key,entries] of store.refs){
    const item=store.appMap.get(key);if(!item)continue;
    const id=store.labCanonical?.get(key)||key;
    const current=grouped.get(id)||{key:id,entries:[],item:store.appMap.get(id)||item,variants:[]};
    current.entries.push(...entries);current.variants.push({key,item,group:entries[0]?.group});grouped.set(id,current);
  }
  const refs=[...grouped.values()].filter(x=>!q||x.variants.some(v=>`${v.item.name} ${v.item.developer} ${v.item.primary_category}`.toLocaleLowerCase().includes(q)));
  refs.sort((a,b)=>Math.min(...a.entries.map(x=>Number(x.item.rank)||999))-Math.min(...b.entries.map(x=>Number(x.item.rank)||999)));
  const rows=refs.slice(0,80);
  return `<div class="page-heading"><div><p class="eyebrow">COLLECTED DATA SEARCH</p><h1>앱·게임 검색</h1><p class="subtext">우리 사이트에서 수집한 데이터만 검색합니다. 전체 스토어 실시간 검색은 아닙니다.</p></div></div><div class="panel"><div class="results-header"><strong>검색 결과 ${q?refs.length:0}개 ${q?`· '${esc(ui.query)}'`:''}</strong></div>
    ${q?(rows.length?rows.map(({item,entries})=>`<div class="fav-row">${safeIconResult(item)}<div class="fav-details"><a class="item-primary" href="${attr(detailsHref(item.app_key,entries[0]?.group||{}))}">${esc(item.name)}</a><div class="small-copy">${esc(item.developer||'')} · ${entries.length}개 차트에서 관측</div><div class="lab-store-badges">${(store.labVariants?.get(item.app_key)||[{source:entries[0]?.group.source,app_key:item.app_key}]).map(v=>`<a class="lab-store-badge lab-store-${attr(v.source)}" href="${attr(detailsHref(v.app_key,{from:'search'}))}">${esc(SOURCE_LABEL[v.source]||v.source)}</a>`).join('')}</div></div><a class="button ghost small" href="${attr(detailsHref(item.app_key,entries[0]?.group||{}))}">자세히</a></div>`).join(''):empty('일치하는 결과가 없습니다.','다른 이름이나 카테고리로 검색해 보세요.')):empty('검색어를 입력해 주세요.','상단 검색창에서 앱·게임 이름이나 개발사를 검색할 수 있습니다.')}
  </div>${rows.length<refs.length?`<p class="small-copy">상위 ${rows.length}건까지 표시합니다. 검색어를 더 구체적으로 입력해 주세요.</p>`:''}`;
}
async function loadChart(stamp,key){
  const el=document.getElementById('detail-history');
  if(!el)return;
  try{
    const values=await loadHistory(key);
    if(stamp!==renderStamp)return;
    const refs=store.refs.get(key)||[];
    const r=refs.find(({group})=>group.country===ui.detailContext.country&&group.source===ui.detailContext.source&&group.category===ui.detailContext.category&&group.chart===ui.detailContext.chart)||refs[0];
    el.innerHTML=renderHistory(values,r?.group,ui.range,r?.group?.data_date||store.latest.data_date);
  }catch{if(stamp===renderStamp) el.innerHTML=empty('순위 기록을 불러오지 못했습니다.','다음 데이터 갱신 후 다시 확인해 주세요.');}
}
function refreshLabLinkedPage(){
  const page=route().page;if(!['favorites','detail','search'].includes(page))return;
  // The lookup may finish while someone is typing a private note. Never
  // replace an unsaved draft with the saved version during an async refresh.
  const note=document.getElementById('idea-note');const status=document.getElementById('idea-status');
  const draft=note?.value, draftStatus=status?.value;
  const active=document.activeElement;
  const isQuery=active?.matches?.('[data-favorite-query]');
  const focusId=isQuery?'favorite-query':active?.id;
  const start=active?.selectionStart,end=active?.selectionEnd;
  const y=window.scrollY||0;
  render();
  if(note){const next=document.getElementById('idea-note');if(next)next.value=draft;}
  if(status){const next=document.getElementById('idea-status');if(next)next.value=draftStatus;}
  const focus=isQuery?document.querySelector('[data-favorite-query]'):focusId?document.getElementById(focusId):null;
  if(focus){focus.focus();if(typeof start==='number')try{focus.setSelectionRange(start,end);}catch{}}
  window.scrollTo?.(0,y);
}
function ensureLabAvailability(){
  if(ui.labAvailability.status!=='idle')return;
  ui.labAvailability={status:'loading',keys:null};
  loadLab().then(data=>{
    ui.labAvailability={status:'ready',keys:new Set(data.map.keys())};
    refreshLabLinkedPage();
  }).catch(()=>{
    ui.labAvailability={status:'error',keys:null};
    refreshLabLinkedPage();
  });
}
function render(){
  if(!ready)return;
  const r=route();const stamp=++renderStamp;
  // Keep the parent section highlighted even while viewing a detail page.
  const origin=r.page==='detail'?(r.query.get('from')||''):r.page;
  const navPage=origin==='search'?'':origin==='detail'?'':origin;
  for(const a of document.querySelectorAll('.main-nav a')){
    const active=a.dataset.page===navPage;
    a.classList.toggle('active',active);
    if(active)a.setAttribute?.('aria-current','page');
    else a.removeAttribute?.('aria-current');
  }
  if(r.page==='games')normalizeExploreCategory('game',ui);
  if(r.page==='apps')normalizeExploreCategory('app',ui);
  if(r.page==='detail'){
    ui.detailContext=Object.fromEntries(['source','country','category','chart'].map(x=>[x,r.query.get(x)||'']));
    ui.detailFrom=r.query.get('from')||'';
    ui.detailLabTab=r.query.get('labtab')||'radar';
  }
  main.innerHTML= r.page==='home'?renderHome(ui):r.page==='apps'?renderExplore('app',ui):r.page==='games'?renderExplore('game',ui):
    r.page==='indie'?renderIndie(ui):r.page==='favorites'?renderFavorites(ui):r.page==='lab'?renderLab(r.tab,r.query):r.page==='detail'?renderDetail(r.key,ui):renderSearch();
  if(r.page==='detail' && r.key.startsWith('itch:')===false)loadChart(stamp,r.key);
  persistFilters();
  if(r.page==='detail'||r.page==='search'||(r.page==='favorites'&&getFavorites().length))ensureLabAvailability();
}
function refreshIndieResults(){const el=document.getElementById('indie-results');if(el&&route().page==='indie')el.innerHTML=renderIndieResults(ui);}
function modal(title,html){
  overlay.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-label="${attr(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-close="true" aria-label="닫기">×</button></div><div class="modal-body">${html}</div></section>`;
  overlay.classList.remove('is-hidden');overlay.setAttribute('aria-hidden','false');overlay.querySelector('[data-close]')?.focus();
}
function closeModal(){overlay.classList.add('is-hidden');overlay.setAttribute('aria-hidden','true');overlay.innerHTML='';}
async function exportModal(){
  try{
    const x=await loadExportManifest();
    const make=(prefix)=>`<div class="modal-line"><strong>${prefix==='app_trends'?'앱·게임 순위':'인디 발견'}</strong><span>${formatDate(x.data_date)}</span></div><div class="modal-download">${[7,30,90].map(n=>{
       const f=x.files?.[`${prefix}_${n}d`];return f?`<a download href="./exports/${attr(encodeURIComponent(f.filename))}">${n}일 CSV ↧</a>`:`<a class="disabled" aria-disabled="true">${n}일 준비 중</a>`;
    }).join('')}</div>`;
    modal('CSV 내보내기',`<p>실제로 누적된 날짜만 포함합니다. CSV는 ChatGPT나 엑셀에서 분석할 수 있습니다.</p>${make('app_trends')}<div style="height:17px"></div>${make('indie_discoveries')}<p>기간이 길더라도 수집을 시작한 날짜 이전의 데이터는 포함되지 않습니다.</p>`);
  }catch(e){modal('CSV 내보내기',`<p>다운로드 목록을 읽지 못했습니다. ${esc(e.message)}</p>`);}
}
function statusModal(){
  const s=store.status;const missing=s.groups.filter(x=>x.status!=='success');
  const display=missing.slice(0,35).map(x=>`<div class="modal-line"><span>${esc(SOURCE_LABEL[x.source]||x.source)} · ${esc(COUNTRY_LABEL[x.country]||x.country)} · ${esc(CATEGORY_LABEL[x.category]||x.feed||'')}</span><span>${x.status==='skipped'?'수집 미지원':x.status==='failed'?`요청 실패${x.last_success_at?' · 마지막 성공 '+formatDate(x.last_success_at):''}`:esc(x.status)} ${x.needs_attention?'· 장기 점검 필요':''}</span></div>`).join('');
  modal('데이터 수집 상태',`<div class="modal-line"><strong>최근 실행</strong><span>${esc(s.finished_at||'기록 없음')}</span></div><div class="modal-line"><strong>정상 수집</strong><span>${s.accepted_groups}개 그룹</span></div><div class="modal-line"><strong>실패한 그룹</strong><span>${s.failed_groups}개</span></div><h3 style="margin:24px 0 8px">실패·미지원 항목</h3>${display||'<p>실패 또는 미지원 항목이 없습니다.</p>'}<p>일부 차트가 실패해도 다른 자료는 정상적으로 표시합니다. 실패한 차트에는 마지막 정상 날짜를 표시합니다.</p>`);
}
async function copyAppInfo(key){
  const app=store.appMap.get(key); if(!app)return;
  const refs=(store.refs.get(key)||[]).slice(0,20);
  const lines=[`이름: ${app.name}`,`개발사: ${app.developer||'미확인'}`,`플랫폼: ${SOURCE_LABEL[key.split(':')[0]]||key.split(':')[0]}`,`원본 링크: ${safeUrl(app.detail_url)||'정보 없음'}`,`장르: ${app.primary_category||'미확인'}`,`스토어 제공 출시일: ${key.startsWith('apple:')&&app.release_date?app.release_date:'미확인'}`,`우리 사이트 첫 관측: ${app.first_seen||'미확인'}`,`설명: ${app.description||'미수집'}`,
    ...refs.map(x=>`${COUNTRY_LABEL[x.group.country]||x.group.country} / ${CATEGORY_LABEL[x.group.category]||x.group.feed} / ${x.group.chart||'피드'} / ${x.item.rank?x.item.rank+'위':x.item.position+'번째'} / ${x.group.data_date||'기록 없음'}`),'이 정보만으로 인기 원인이나 개발 난이도를 단정하지 마세요.'];
  try{await navigator.clipboard.writeText(lines.join('\n'));notify('앱·게임 정보를 복사했습니다.');}
  catch {modal('앱 정보 복사',`<p>자동 복사가 차단되었습니다. 아래 내용을 선택해 복사하세요.</p><textarea readonly class="note-box" style="height:230px;width:100%">${esc(lines.join('\n'))}</textarea>`);}
}

initLabHandlers(render,notify);
document.addEventListener('click',async e=>{
  const target=e.target.closest('button, a');if(!target)return;
  if(target.matches('[data-lab-action]')){e.preventDefault();await labAction(target);return;}
  if(target.matches('[data-fav]')){
    const key=target.dataset.fav,item=store.appMap.get(key)||getFavorites().find(x=>x.app_key===key);
    if(item){const added=toggleFavorite(item);notify(added?'관심 목록에 추가했습니다.':'관심 목록에서 제외했습니다.');if(route().page==='indie')refreshIndieResults();else render();}
  }else if(target.matches('[data-country]')){ui.country=target.dataset.country;ui.groupLimits={};render();}
  else if(target.matches('[data-feed]')){ui.feed=target.dataset.feed;ui.indieLimit=30;render();}
  else if(target.matches('[data-indie-more]')){ui.indieLimit+=30;refreshIndieResults();}
  else if(target.matches('[data-price]')){ui.price=target.dataset.price;ui.groupLimits={};render();}
  else if(target.matches('[data-range]')){ui.range=Number(target.dataset.range);render();}
  else if(target.matches('[data-more]')){const key=target.dataset.group;if(!key)return;ui.groupLimits[key]=(ui.groupLimits[key]||30)+30;render();}
  else if(target.matches('[data-toggle-filters]')){ui.filtersOpen=!ui.filtersOpen;render();}
  else if(target.id==='csv-button')await exportModal();
  else if(target.id==='status-button'||target.id==='home-status-button')statusModal();
  else if(target.dataset.close){closeModal();}
  else if(target.matches('[data-retry-lab-availability]')){ui.labAvailability={status:'idle',keys:null};render();}
  else if(target.id==='favorites-export')exportFavorites();
  else if(target.id==='favorites-import')document.getElementById('favorites-file')?.click();
  else if(target.matches('[data-favorite-filter]')){ui.favoriteStatus=target.dataset.favoriteFilter;ui.favoriteLimit=30;render();}
  else if(target.matches('[data-favorite-more]')){ui.favoriteLimit+=30;render();}
  else if(target.id==='save-note'){
    const key=route().key,note=document.getElementById('idea-note')?.value||'',status=document.getElementById('idea-status')?.value||'관심';
    if(updateFavorite(key,{note,status}))notify('아이디어 노트를 저장했습니다.');
  }
  else if(target.id==='add-detail-favorite'){
    const item=store.appMap.get(target.dataset.key);if(item){toggleFavorite(item);render();notify('관심 목록에 추가했습니다.');}
  }
  else if(target.id==='copy-app')await copyAppInfo(route().key);
});
document.addEventListener('change',async e=>{
  if(labChange(e.target))return;
  if(e.target.matches('[data-favorite-sort]')){ui.favoriteSort=e.target.value;ui.favoriteLimit=30;render();}
  else if(e.target.matches('[data-favorite-status]')){
    if(updateFavorite(e.target.dataset.favoriteStatus,{status:e.target.value})){notify('검토 상태를 변경했습니다.');render();}
  }
  else if(e.target.matches('[data-indie-sort]')){ui.indieSort=e.target.value;ui.indieLimit=30;refreshIndieResults();}
  else if(e.target.matches('[data-filter]')){
    ui[e.target.dataset.filter]=e.target.value;ui.groupLimits={};render();
  }else if(e.target.id==='detail-context'){
    const [country,source,chart,category]=e.target.value.split('|');
    window.location.hash=detailsHref(route().key,{country,source,chart,category,from:ui.detailFrom,labtab:ui.detailFrom==='lab'?ui.detailLabTab:''}).slice(1);
  }else if(e.target.id==='favorites-file'){
    try{const count=await importFavorites(e.target.files?.[0]);notify(`${count}개 항목으로 관심 목록을 갱신했습니다.`);render();}
    catch(err){notify('가져오기 실패: '+err.message);}e.target.value='';
  }
});
document.addEventListener('input',e=>{
  if(e.target.matches('[data-favorite-query]')){
    const start=e.target.selectionStart,end=e.target.selectionEnd;ui.favoriteQuery=e.target.value;ui.favoriteLimit=30;render();
    const input=document.querySelector('[data-favorite-query]');if(input){input.focus();try{input.setSelectionRange(start,end);}catch{}}
    return;
  }
  if(e.target.matches('[data-indie-query]')){ui.indieQuery=e.target.value;ui.indieLimit=30;refreshIndieResults();return;}labInput(e.target);});
searchInput.addEventListener('input',()=>{
  ui.query=searchInput.value.trim();
  if(ui.query && route().page!=='search')location.hash='#/search';
  else if(route().page==='search')render();
});
searchInput.addEventListener('keydown',e=>{if(e.key==='Escape'){searchInput.value='';ui.query='';render();searchInput.blur();}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!overlay.classList.contains('is-hidden'))closeModal();
  if(e.key==='/' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) && overlay.classList.contains('is-hidden')) {e.preventDefault();searchInput.focus();}
});
overlay.addEventListener('click',e=>{if(e.target===overlay)closeModal();});
window.addEventListener('hashchange',()=>{if(!ready)return;ui.groupLimits={};if(route().page!=='search'){ui.query='';searchInput.value='';}render();window.scrollTo({top:0,behavior:'instant'});});
window.addEventListener('favorites-updated',()=>{/* list refreshed by click/change handlers */});
document.addEventListener('error',e=>{if(e.target?.tagName==='IMG')e.target.style.visibility='hidden';},true);

loadSnapshot().then(()=>{try{refreshFavoriteSnapshots(store.appMap);}catch{}ready=true;updateStatus();render();}).catch(err=>{
  main.innerHTML=`<div class="panel">${empty('앱·게임 데이터를 불러올 수 없습니다.',`${err.message} · 로컬 파일(file://)로 직접 열었다면 Python HTTP 서버로 열어 주세요.`)}<div style="text-align:center;padding:0 0 24px"><button class="button" onclick="location.reload()">다시 시도</button></div></div>`;
  document.getElementById('status-label').textContent='데이터 로딩 실패';document.querySelector('.status-dot').classList.add('bad');
});
