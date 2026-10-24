// Idea Lab: read-only public evidence + existing Gemini V2 analyses.
// No API keys, speculative scores, or uploads of personal notes.
import {esc, attr, safeUrl, formatDate, detailsHref, SOURCE_LABEL, COUNTRY_LABEL,
        CATEGORY_LABEL, APP_CATEGORIES, GAME_CATEGORIES, FEED_LABEL, REASON_LABEL, loadHistory, store} from './data.js';
import {hasFavorite, getFavorites, setFavoriteAliases} from './favorites.js';
import {icon, empty} from './views.js';
import {renderDevelopment,developmentQuery} from './development.js';
import {searchScope,setSearchScope,deepSearchState,ensureDeepSearch,searchMatch,searchResults} from './lab_search.js';

const TABS=[['radar','발견 레이더'],['features','기능 탐색'],['analysis','개발 분석'],['compare','후보 비교'],['export','자료 내보내기'],['development','개발 설계실']];
const SIGNALS=[['all','전체'],['rising_7d','순위 상승'],['newly_seen','처음 관측'],['multi_country','여러 국가'],['consistent_30d','꾸준히 관측'],['overseas_interest','해외에서 관측'],['indie_discovery','인디 발견']];
const SECTIONS=['summary_ko','features_ko','noteworthy_ko','highlights_ko','development_ko','systems_ko','difficulty_ko','solo_mvp_ko','ideas_ko','idea_ko','recommendation_ko','source_limitations_ko'];
const AI_CACHE=new Map();
const AI_RESULT=new Map();
const AI_SHARD_CACHE=new Map();
const EXPORT_HISTORY_CACHE=new Map();
const SELECT_KEY='app-trend:lab-compare:v1';
const EXPORT_SELECT_KEY='app-trend:lab-export:v1';
let index=null,loadPromise=null,loadError=null,indiePromise=null;
let chosen=[];
try {const raw=JSON.parse(sessionStorage.getItem(SELECT_KEY)||'[]');if(Array.isArray(raw))chosen=[...new Set(raw.filter(x=>typeof x==='string'))].slice(0,3);}catch{}
const ui={radarQuery:'',signal:'all',country:'ALL',source:'all',kind:'all',category:'all',price:'all',ai:'all',release:'all',period:30,sort:'signals',view:'cards',radarLimit:24,featureTags:[],featureGroups:[],featureExcludedTags:[],featureFamiliesOpen:true,featureInsightsOpen:false,featureLimit:60,featureRelatedTag:'',featureRelatedExpanded:false,featureQuery:'',tagQuery:'',featureOpenGroups:[],featureExpandedGroups:[],analysisQuery:'',analysisSource:'all',analysisKind:'all',analysisDifficulty:'all',analysisTag:'all',analysisLimit:28,analysisKey:'',comparisonMode:'all',exportPreset:'full',exportPeriod:30,exportKeys:[],exportManualInitialized:false,exportMode:'manual',exportQuery:'',exportSignal:'rising_7d',exportKind:'all',exportSource:'all',exportCategory:'all',exportDifficulty:'all',exportAI:'all',exportCount:30,exportBrowseOpen:false,exportBrowseKind:'all',exportBrowseSource:'all',exportBrowseCategory:'all',exportBrowseAI:'all',exportBrowseLimit:24};
let refreshPage=()=>{},flash=()=>{};
// Manually selected export candidates stay independent of 3-item comparisons.
try {
  const saved=JSON.parse(sessionStorage.getItem(EXPORT_SELECT_KEY)||'null');
  if(Array.isArray(saved)){ui.exportKeys=[...new Set(saved.filter(x=>typeof x==='string'))].slice(0,100);ui.exportManualInitialized=true;}
}catch{}
let lastFeatureRoute='';
export function initLabHandlers(refresh,notify){refreshPage=refresh;flash=notify;}
const readJSON=async url=>{const response=await fetch(url,{cache:'no-cache'});if(!response.ok)throw Error(`자료 요청 실패 (${response.status})`);return response.json();};
// Same title + same publisher across Apple/Google is a single research candidate.
// Observed ranks and store IDs remain distinct; the source files are never edited.
// Only modest, mechanical text normalization is used (no similarity guessing).
const normalizeIdentity=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const normalizePublisher=value=>normalizeIdentity(value)
  .replace(/\s*\(apps?\)$/, '')
  .replace(/(?:\s*,?\s*(?:inc\.?|incorporated|ltd\.?|limited|llc|corp\.?|corporation|co\.?))+(?:\s*,?\s*(?:ltd\.?))?$/, '')
  .trim();
const storeVariant=item=>({app_key:item.app_key,source:item.source,name:item.name,
  developer:item.developer,kind:item.kind,detail_url:item.detail_url,
  icon_url:item.icon_url,first_seen:item.first_seen,release_date:item.release_date,has_ai:item.has_ai});
export function mergeStoreDuplicates(items){
  const identity=new Map();
  for(const item of items){
    if(!['apple','google'].includes(item.source)||!item.name||!item.developer)continue;
    const title=normalizeIdentity(item.name),publisher=normalizePublisher(item.developer);
    if(!title||!publisher)continue;
    const key=JSON.stringify([title,publisher]);
    const group=identity.get(key)||[];group.push(item);identity.set(key,group);
  }
  const groups=new Map(),used=new Set();
  for(const group of identity.values()){
    // Ambiguous three-way matches and same-store duplicates stay independent.
    if(group.length!==2||new Set(group.map(x=>x.source)).size!==2)continue;
    const apple=group.find(x=>x.source==='apple'),google=group.find(x=>x.source==='google');
    // Apple is the stable canonical key, even if only Google has AI analysis.
    const analyzed=[apple,google].filter(x=>x.has_ai).sort((a,b)=>
      String(b.analysed_at||'').localeCompare(String(a.analysed_at||'')));
    const ai=analyzed[0];
    const tags=[...new Set(analyzed.flatMap(item=>item.tags||[]))];
    const tag_evidence={};
    for(const record of analyzed)for(const [tag,entries] of Object.entries(record.tag_evidence||{})){
      tag_evidence[tag]||=[];
      tag_evidence[tag].push(...entries);
    }
    const merged={...apple,app_key:apple.app_key,
      observations:[...(apple.observations||[]),...(google.observations||[])].sort((a,b)=>
        String(b.date||'').localeCompare(String(a.date||''))||(a.rank??9999)-(b.rank??9999)),
      signals:[...(apple.signals||[]),...(google.signals||[])],
      store_variants:[storeVariant(apple),storeVariant(google)],
      alias_keys:[apple.app_key,google.app_key],
      first_seen:[apple.first_seen,google.first_seen].filter(Boolean).sort()[0]||'',
      has_ai:Boolean(ai),ai_key:ai?.app_key||'',ai_shard:ai?.ai_shard||null,
      tags,tag_evidence,
      difficulty:ai?.difficulty||'',summary:ai?.summary||'',analysed_at:ai?.analysed_at||''};
    groups.set(apple.app_key,merged);used.add(google.app_key);
  }
  return items.filter(item=>!used.has(item.app_key)).map(item=>groups.get(item.app_key)||item);
}
const canonicalKey=key=>index?.map.get(key)?.app_key||key;
const sourceMatches=(item,source)=>source==='all'||item.source===source||
  Boolean(item.store_variants?.some(variant=>variant.source===source));
const variantLinks=item=>(item.store_variants||[]).map(variant=>
  `<a class="lab-store-badge lab-store-${attr(variant.source)}" href="${attr(labDetailHref(variant.app_key))}" title="${attr(variant.developer||'')} · ${attr(labelSource(variant.source))} 상세">${esc(labelSource(variant.source))}</a>`).join('');
const sourceText=item=>item.store_variants?item.store_variants.map(v=>labelSource(v.source)).join(' · '):labelSource(item.source);
export function loadLab(){
  if(index)return Promise.resolve(index);
  if(loadPromise)return loadPromise;
  loadPromise=readJSON('./data/lab/index.json').then(data=>{
    if(data?.schema_version!==1||!Array.isArray(data.items))throw Error('아이디어 연구실 인덱스 형식이 잘못되었습니다.');
    const items=mergeStoreDuplicates(data.items),map=new Map(),aliases=new Map();
    for(const item of items)for(const key of item.alias_keys||[item.app_key]){
      map.set(key,item);aliases.set(key,item.app_key);
    }
    index={...data,items,map,aliases};
    setFavoriteAliases(aliases);
    // The ordinary detail page may be opened by either original store ID.
    store.labVariants=new Map([...map].map(([key,item])=>[key,item.store_variants||[]]));
    store.labCanonical=new Map([...map].map(([key,item])=>[key,item.app_key]));
    chosen=[...new Set(chosen.map(canonicalKey))].filter(key=>index.map.has(key)).slice(0,3);saveChosen();
    if(ui.exportManualInitialized){ui.exportKeys=[...new Set(ui.exportKeys.map(canonicalKey))].filter(key=>index.map.has(key)).slice(0,100);saveExportKeys();}
    loadError=null;return index;
  }).catch(e=>{loadError=e;loadPromise=null;throw e;});
  return loadPromise;
}
function loadAI(key){
  const item=index?.map.get(key);
  if(!item?.has_ai || !item.ai_shard)return Promise.resolve(null);
  if(AI_CACHE.has(key))return AI_CACHE.get(key);
  if(!AI_SHARD_CACHE.has(item.ai_shard))AI_SHARD_CACHE.set(item.ai_shard,readJSON(`./data/ai/items/${encodeURIComponent(item.ai_shard)}.json`));
  const task=AI_SHARD_CACHE.get(item.ai_shard).then(data=>{
    const analysisKey=item.ai_key||key;
    const record=data?.items?.[analysisKey];
    if(!record?.analysis||record.app_key!==analysisKey)throw Error('AI 분석 내용이 존재하지 않습니다.');
    AI_RESULT.set(key,record);
    return record;
  });
  // A transient or partially published shard must be retryable later.
  const retryable=task.catch(error=>{AI_CACHE.delete(key);AI_SHARD_CACHE.delete(item.ai_shard);throw error;});
  AI_CACHE.set(key,retryable);
  return retryable;
}
const names=(arr)=>arr.map(x=>x.name);
function labDetailHref(key){
 const tab=(typeof location!=='undefined'?location.hash.match(/^#\/lab\/(radar|features|analysis|compare|export)/)?.[1]:null)||'radar';
 return detailsHref(key,{from:'lab',labtab:tab});
}
const labelSource=s=>SOURCE_LABEL[s]||s||'출처 없음';
const labelCountry=s=>COUNTRY_LABEL[s]||s||'국가 없음';
const labelCategory=s=>CATEGORY_LABEL[s]||FEED_LABEL[s]||s||'전체';
const plain=v=>v==null?'':String(v);
const periodStart=period=>{
  if(!index?.data_date)return '';
  const [y,m,d]=index.data_date.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d)-(period-1)*86400000).toISOString().slice(0,10);
};
const eLabel=(obs)=>`${labelSource(obs.source)} · ${labelCountry(obs.country)} · ${obs.source==='itch'?`인디 ${labelCategory(obs.feed)}`:`${labelCategory(obs.category)} · ${obs.chart==='top_paid'?'유료':'무료'}`}`;
// A confirmed Apple release is distinct from a first chart observation.
const confirmedRelease=item=>item.source==='apple'&&/^\d{4}-\d{2}-\d{2}$/.test(item.release_date||'')&&item.release_date<=index.data_date?item.release_date:'';
const releaseMatches=item=>{
 if(ui.release==='all')return true;
 const released=confirmedRelease(item);
 if(ui.release==='unknown')return !released;
 const days=ui.release==='apple30'?30:ui.release==='apple90'?90:0;
 return days>0&&Boolean(released)&&released>=periodStart(days);
};
const recentObs=(item)=> (item.observations||[]).filter(o=>o.date>=periodStart(ui.period)&&o.date<=index.data_date);
const selectedObs=item=>(item.observations||[]).filter(o=>(ui.country==='ALL'||o.country===ui.country)&&
      (ui.source==='all'||o.source===ui.source)&&(ui.category==='all'||o.category===ui.category||o.feed===ui.category)&&
      (ui.price==='all'||o.chart===ui.price));
const scopedObs=item=>selectedObs(item).filter(o=>o.date>=periodStart(ui.period)&&o.date<=index.data_date);
const currentObs=(item)=>scopedObs(item).filter(o=>!o.stale && !o.historical);
const bestObs=(item)=>currentObs(item)[0]||scopedObs(item)[0]||null;
// A signal belongs only to its documented chart/country/date. Do not leak a
// Japanese rise into a US-only view or use failed/stale chart data as fresh.
export function matchingSignals(item, filters=null){
 const f=filters||ui;
 const period=periodStart(f.period||ui.period);
 const observations=(item.observations||[]).filter(o=>o.date>=period&&o.date<=index.data_date&&
  (f.country==='ALL'||o.country===f.country)&&
  (f.source==='all'||o.source===f.source)&&
  (f.category==='all'||o.category===f.category||o.feed===f.category)&&
  (f.price==='all'||o.chart===f.price));
 return (item.signals||[]).filter(signal=>{
  const e=signal.evidence||{},days=signal.source_data_dates||[];
  if(!days.some(d=>d>=period&&d<=index.data_date))return false;
  if(f.source!=='all' && e.source && e.source!==f.source)return false;
  if(f.country!=='ALL'){
   if(e.country&&e.country!==f.country)return false;
   if(Array.isArray(e.countries)&&!e.countries.includes(f.country))return false;
  }
  if(f.category!=='all'&&e.category&&e.category!==f.category)return false;
  if(f.category!=='all'&&e.feed&&e.feed!==f.category)return false;
  if(f.price!=='all'&&e.chart&&e.chart!==f.price)return false;
  if(signal.reason_code==='newly_seen'&&(e.first_seen||item.first_seen||'')<period)return false;
  if(signal.reason_code==='rising_7d'&&!(e.after_date>=period))return false;
  const supporting=observations.some(o=>
   (!e.source||o.source===e.source)&&(!e.country||o.country===e.country)&&
   (!e.category||o.category===e.category)&&(!e.chart||o.chart===e.chart)&&
   (!e.feed||o.feed===e.feed)&&
   (signal.reason_code==='rising_7d'?o.date===e.after_date:days.includes(o.date))&&
   !o.stale&&!o.historical);
  // For multi-country signals, the selected country must have a supporting observation.
  return supporting;
 });
}
const sigLabel=code=>SIGNALS.find(x=>x[0]===code)?.[1]||REASON_LABEL[code]||code;
function signalText(s){
  const e=s.evidence||{};
  const day=(s.source_data_dates||[]).join(' → ');
  switch(s.reason_code){
  case 'rising_7d':return `${labelCountry(e.country)} ${labelSource(e.source)} ${labelCategory(e.category)} ${formatDate(e.before_date||s.source_data_dates?.[0])} ${e.before_rank??'?'}위 → ${formatDate(e.after_date||s.source_data_dates?.at(-1))} ${e.after_rank??'?'}위 (동일 차트)`;
  case 'newly_seen':return `${formatDate(e.first_seen||s.source_data_dates?.[0])} 우리 수집 기록에서 처음 관측했습니다. 신규 출시일을 뜻하지 않습니다.`;
  case 'multi_country':return `같은 스토어의 ${Array.isArray(e.countries)?e.countries.map(labelCountry).join('·'):'여러 국가'}에서 관측했습니다.`;
  case 'consistent_30d':return `실제로 수집된 날짜에서 ${e.observed_days??'여러'}일 관측 · ${day}`;
  case 'overseas_interest':return `${labelCountry(e.country)} ${labelSource(e.source)} ${labelCategory(e.category)} ${e.rank??'—'}위 · ${formatDate(s.source_data_dates?.[0])}`;
  case 'indie_discovery':return `itch.io ${labelCategory(e.feed)} 피드에서 ${formatDate(s.source_data_dates?.[0])} 관측했습니다. 피드 위치는 인기 순위가 아닙니다.`;
  default:return '관측 근거는 원본 자료를 확인해 주세요.';
  }
}
function reason(item){
  const priority=['rising_7d','multi_country','consistent_30d','overseas_interest','newly_seen','indie_discovery'];
  return matchingSignals(item).sort((a,b)=>priority.indexOf(a.reason_code)-priority.indexOf(b.reason_code))[0]||null;
}
const badge=(text,cls='')=>`<span class="info-tag ${cls}">${esc(text)}</span>`;
// Names come from the live index, not a fixed list. Generate a deterministic,
// contrast-aware color for any tag, including tags that arrive in a later build.
// Infinite mutually distinguishable colors are impossible, but no CSS class or
// taxonomy slot must be added when a new tag appears.
export function featureTone(name){
 let hash=2166136261;
 for(const ch of String(name)){
   // Hash UTF-8 bytes rather than JS UTF-16 code units for a stable Unicode key.
   for(const byte of new TextEncoder().encode(ch))hash=Math.imul(hash^byte,16777619);
 }
 hash>>>=0;
 const hue=hash%360,sat=43+(hash>>>9)%23,light=92+(hash>>>18)%4;
 const borderSat=41+(hash>>>12)%19,deepSat=51+(hash>>>5)%19;
 return `--lab-tone-bg:hsl(${hue} ${sat}% ${light}%);--lab-tone-border:hsl(${hue} ${borderSat}% 74%);--lab-tone-ink:hsl(${hue} ${deepSat}% 26%);--lab-tone-strong:hsl(${hue} ${deepSat}% 33%)`;
}
const evidenceTitle=(tag,item)=>{
 const found=item?.tag_evidence?.[tag]?.[0];
 return found?.text?` title="${attr(`Gemini ${found.field==='systems_ko'?'구현 시스템 제안':'핵심 기능'}: ${found.text}`)}"`:'';
};
// The public index supplies family assignments for every AI-derived tag.
// Family headings organize the UI; they never discard an unfamiliar tag.
const FAMILY_ORDER=['퍼즐·규칙·카드','전투·액션·물리','수집·성장·경제','건설·제작·꾸미기','스토리·미션·상호작용','AI·자동화·추천','이미지·영상·음성','네트워크·소셜','데이터·저장·보안','화면·입력·조작','생활·위치·일정','새로 발견된 기능'];
const tagFamily=tag=>index?.tag_groups?.[tag]||'새로 발견된 기능';
function groupedTags(counts){
 const groups=new Map();
 for(const [tag,count] of counts){const family=tagFamily(tag);
   if(!groups.has(family))groups.set(family,[]);
   groups.get(family).push([tag,count]);
 }
 return [...groups].sort(([a],[b])=>{
   const ia=FAMILY_ORDER.indexOf(a),ib=FAMILY_ORDER.indexOf(b);
   return (ia<0?FAMILY_ORDER.length:ia)-(ib<0?FAMILY_ORDER.length:ib)||a.localeCompare(b,'ko');
 });
}
const featureBadge=(tag,item)=>`<span class="lab-feature-badge" style="${featureTone(tag)}"${evidenceTitle(tag,item)}>${esc(tag)}</span>`;
const difficultyTone=value=>({'쉬움':'easy','보통':'medium','어려움':'hard','판단 어려움':'unknown'})[value]||'unknown';
const difficultyBadge=value=>`<span class="lab-difficulty lab-difficulty-${difficultyTone(value)}">${esc(value||'판단 어려움')}</span>`;
const isExportSelected=key=>manualExportKeys().includes(key);
function exportToggle(key){const selected=isExportSelected(key);
  return `<button type="button" class="button small lab-export-toggle ${selected?'is-selected':''}" data-lab-action="toggle-export" data-key="${attr(key)}" aria-pressed="${selected}" title="${selected?'내보내기 목록에서 빼기':'내보내기 목록에 담기'}">${selected?'✓ 내보내기 담김':'+ 내보내기 담기'}</button>`;
}
function miniObs(item, radarContext=false){
  // Comparisons must never inherit unrelated radar filters.
  const all=(radarContext?scopedObs(item):(item.observations||[]));
  const observations=item.store_variants&&new Set(all.map(o=>o.source)).size>1
    ?[...[...new Set(all.map(o=>o.source))].map(source=>all.find(o=>o.source===source)),...all].filter((o,i,arr)=>arr.indexOf(o)===i).slice(0,3)
    :all.slice(0,3);
  return observations.length?observations.map(o=>`<div class="lab-observation"><span>${esc(eLabel(o))}</span><strong>${o.source==='itch'?'피드 관측':o.rank?`${o.rank}위`:'순위 미확인'}</strong><small>${o.stale?'이전 데이터 · ':o.historical?'과거 관측 · ':''}${formatDate(o.date)}</small></div>`).join(''):'<p class="small-copy">현재 선택한 차트의 관측 기록이 없습니다.</p>';
}
function actions(item,analysis=true){
  const key=attr(item.app_key),fav=(item.alias_keys||[item.app_key]).some(hasFavorite);
  return `<div class="lab-actions"><a class="button ghost small" href="${attr(labDetailHref(item.app_key))}">상세</a>${analysis&&item.has_ai?`<a class="button ghost small" href="#/lab/analysis?app=${encodeURIComponent(item.app_key)}">개발 분석</a>`:''}<button class="button outline-blue small" data-lab-action="toggle-compare" data-key="${key}">${chosen.includes(item.app_key)?'✓ 비교 선택됨':'+ 비교'}</button><button class="button ghost small" data-lab-action="favorite" data-key="${key}" aria-label="관심 목록 ${fav?'해제':'추가'}">${fav?'★':'☆'} 관심</button></div>`;
}
function matchHint(item,term){
 if(!String(term||'').trim())return '';
 const match=searchMatch(item,term);
 return match?`<p class="lab-search-hit"><strong>${esc(match.label)} 일치</strong> · ${esc(match.snippet)}</p>`:'';
}
function searchControls(key,label,placeholder){
 const active=searchScope();const status=deepSearchState();
 return `<div class="lab-search-widget"><div class="lab-unified-search"><label class="lab-search-label">${esc(label)}<input type="search" data-lab-search="${attr(key)}" value="${attr(ui[key])}" placeholder="${attr(placeholder)}"></label>
 <label class="lab-search-label lab-search-scope">검색 범위<select data-lab-filter="searchScope" class="field-select" aria-label="연구실 검색 범위"><option value="basic" ${active==='basic'?'selected':''}>기본 검색</option><option value="full" ${active==='full'?'selected':''}>상세 내용까지</option></select></label></div>
 ${active==='full'?`<p class="lab-search-guide" role="status">${status.state==='loading'?'AI 상세 검색 자료를 읽는 중입니다. 완료 전에는 기본 검색 결과만 표시합니다.':status.missing?`AI 상세 자료 ${status.missing}개를 읽지 못했습니다. 검색 결과 일부가 빠질 수 있습니다.`:'AI 3.1 상세 분석과 3.5 개발 검토·설계 내용까지 검색합니다.'}</p>`:'<p class="lab-search-guide">기본 검색: 이름 · 제작사 · 분류 · 기능 태그 · AI 핵심 요약</p>'}</div>`;
}
function card(item){
  const observations=scopedObs(item),o=observations.find(x=>!x.stale&&!x.historical)||observations[0];
  const s=reason(item);
  const descriptor=item.description||item.summary||'';
  const released=confirmedRelease(item);
  return `<article class="panel lab-card"><div class="lab-card-head">${icon(item)}<div class="lab-card-id"><a class="lab-name" href="${attr(labDetailHref(item.app_key))}">${esc(item.name||item.app_key)}</a><div class="small-copy">${esc(item.developer||'제작사 미확인')} · ${esc(item.category||item.kind||'분류 정보 없음')}</div>${item.store_variants?`<div class="lab-store-badges">${variantLinks(item)}</div>`:`<div class="small-copy">${esc(sourceText(item))}</div>`}</div>${badge(item.has_ai?'AI 분석 있음':'미분석',item.has_ai?'green':'')}${released?badge(`Apple 출시 ${formatDate(released)}`,'blue'):''}</div>
    <div class="lab-observations">${miniObs(item,true)}</div>
    ${s?`<p class="lab-reason"><strong>${esc(sigLabel(s.reason_code))}</strong> · ${esc(signalText(s))}</p>`:`<p class="lab-reason muted">${o?.historical?'선택 기간의 과거 관측 기록입니다. 현재 순위를 뜻하지 않습니다.':o?.stale?'마지막 정상 수집 기록입니다. 최신 순위로 표시하지 않습니다.':o?'현재 확인된 차트 관측 기록입니다.':'최근 관측 정보가 부족합니다.'}</p>`}
    ${matchHint(item,ui.radarQuery)}
    ${descriptor?`<p class="lab-summary">${esc(descriptor.slice(0,175))}${descriptor.length>175?'…':''}</p>`:''}
    ${item.tags?.length?`<div class="lab-tag-row">${item.tags.slice(0,4).map(tag=>`<a class="lab-feature-badge lab-feature-link" style="${featureTone(tag)}"${evidenceTitle(tag,item)} href="#/lab/features?tag=${encodeURIComponent(tag)}">${esc(tag)}</a>`).join('')}</div>`:''}
    ${actions(item)}</article>`;
}
const options=(rows,value)=>rows.map(([k,v])=>`<option value="${attr(k)}" ${k===value?'selected':''}>${esc(v)}</option>`).join('');
const groupedSelect=(set,all='전체')=>[['all',all],...[...set].sort((a,b)=>a.localeCompare(b,'ko')).map(k=>[k,labelCategory(k)])];
function select(field,rows,value,title){return `<label class="lab-field"><span>${esc(title)}</span><select data-lab-filter="${field}" class="field-select">${options(rows,value)}</select></label>`;}
// Only offer categories actually observed under the selected type / source / country / chart.
// Native optgroup headings visually separate apps, games and itch feeds.
function radarCategoryChoices(){
 const available=new Set();
 for(const item of index.items){
  if(ui.kind!=='all' && item.kind!==ui.kind)continue;
  for(const o of item.observations||[]){
   if(ui.source!=='all' && o.source!==ui.source)continue;
   if(ui.country!=='ALL' && o.country!==ui.country)continue;
   if(ui.price!=='all' && o.chart!==ui.price)continue;
   if(o.date<periodStart(ui.period)||o.date>index.data_date)continue;
   const code=o.source==='itch'?o.feed:o.category;
   if(code)available.add(code);
  }
 }
 return available;
}
function categorySelect(){
 const available=radarCategoryChoices();
 const groups=[
  ['일반 앱',APP_CATEGORIES],
  ['게임',GAME_CATEGORIES],
  ['인디 게임 · itch.io 피드',Object.keys(FEED_LABEL)],
 ];
 // Newly configured collector categories must never disappear from the filter.
 const recognized=new Set(groups.flatMap(([,codes])=>codes));
 groups.push(['추가 수집 분류',[...available].filter(code=>!recognized.has(code)).sort()]);
 const allLabel=ui.source==='itch'?'인디 피드 전체':ui.kind==='app'?'앱 카테고리 전체':ui.kind==='game'?'게임 카테고리·피드 전체':'카테고리·피드 전체';
 const html=[`<option value="all" ${ui.category==='all'?'selected':''}>${esc(allLabel)}</option>`];
 for(const [heading,codes] of groups){
  const rows=codes.filter(code=>available.has(code));
  if(!rows.length)continue;
  html.push(`<optgroup label="${attr(heading)}">${options(rows.map(code=>[code,labelCategory(code)]),ui.category)}</optgroup>`);
 }
 return `<label class="lab-field"><span>카테고리·피드</span><select data-lab-filter="category" class="field-select lab-category-select" aria-label="카테고리·피드">${html.join('')}</select></label>`;
}
function radarRows(){
 const base=index.items.filter(item=>item.observations.length && scopedObs(item).length);
 const matched=base.filter(item=>releaseMatches(item)&&(ui.kind==='all'||item.kind===ui.kind)&&
    (ui.ai==='all'||item.has_ai===(ui.ai==='yes'))&&
    (ui.signal==='all'||matchingSignals(item).some(s=>s.reason_code===ui.signal)));
 matched.sort((a,b)=>{
   if(ui.sort==='recent')return (bestObs(b)?.date||'').localeCompare(bestObs(a)?.date||'')||a.name.localeCompare(b.name,'ko');
   if(ui.sort==='rank'&&ui.source!=='all'&&ui.country!=='ALL'&&ui.category!=='all'&&ui.price!=='all')return (scopedObs(a).find(x=>!x.stale)?.rank||9999)-(scopedObs(b).find(x=>!x.stale)?.rank||9999);
   if(ui.sort==='rise')return Number(Boolean(reason(b)?.reason_code==='rising_7d'))-Number(Boolean(reason(a)?.reason_code==='rising_7d'))||a.name.localeCompare(b.name,'ko');
   const weight=x=>({rising_7d:0,multi_country:1,consistent_30d:2,overseas_interest:3,newly_seen:4,indie_discovery:5})[reason(x)?.reason_code]??6;
   return weight(a)-weight(b)||(bestObs(b)?.date||'').localeCompare(bestObs(a)?.date||'')||a.name.localeCompare(b.name,'ko');
 });
 if(ui.sort==='signals'&&ui.signal==='all'&&ui.source==='all'){
   // Balance exposure across independent sources; no combined popularity rank.
   const queues={apple:[],google:[],itch:[],other:[]};
   for(const item of matched)(queues[item.source]||queues.other).push(item);
   const mixed=[];
   while(mixed.length<matched.length){
     for(const source of ['apple','google','itch','other'])if(queues[source].length)mixed.push(queues[source].shift());
   }
   return mixed;
 }
 return matched;
}
function radar(){
 const rows=searchResults(radarRows(),ui.radarQuery);
 return `<div class="lab-section-heading"><div><h2>발견 레이더</h2><p>스토어 순위·인디 피드와 수집 날짜로 발견합니다. AI 미분석 항목도 포함합니다.</p></div>${badge(`필터 결과 ${rows.length.toLocaleString('ko-KR')}개 후보`,'blue')}</div>
 ${searchControls('radarQuery','앱·기능·AI 내용 검색','예: 자동 저장, 퍼즐, 인벤토리')}
 <div class="panel lab-filter-panel"><div class="lab-signal-row" role="group" aria-label="관측 신호">${SIGNALS.map(([key,label])=>`<button class="chip ${ui.signal===key?'selected':''}" data-lab-action="signal" data-value="${key}" aria-pressed="${ui.signal===key}">${label}</button>`).join('')}</div>
 <div class="lab-filters">${select('country',[['ALL','국가 전체'],['US','미국'],['JP','일본'],['KR','한국'],['GLOBAL','인디 GLOBAL']],ui.country,'국가')}${select('source',[['all','스토어 전체'],['apple','App Store'],['google','Google Play'],['itch','itch.io']],ui.source,'스토어')}
 ${select('kind',[['all','앱·게임 전체'],['app','앱'],['game','게임']],ui.kind,'유형')}${categorySelect()}
 ${select('price',[['all','무료·유료 전체'],['top_free','무료'],['top_paid','유료']],ui.price,'차트')}${select('ai',[['all','AI 분석 전체'],['yes','AI 분석 있음'],['no','미분석']],ui.ai,'분석 상태')}
 ${select('release',[['all','출시일 전체'],['apple30','최근 30일 실제 출시 (Apple)'],['apple90','최근 90일 실제 출시 (Apple)'],['unknown','실제 출시일 미확인']],ui.release,'실제 출시일')}
 ${select('period',[[7,'최근 7일'],[30,'최근 30일'],[90,'최근 90일']],ui.period,'기간')}
 ${select('sort',[['signals','관측 신호 우선'],['recent','최근 관측'],['rise','순위 상승 신호'],['rank','같은 차트에서 순위']],ui.sort,'정렬')}</div></div>
 ${chosen.length?`<div class="lab-selection-bar" role="status"><strong>비교 후보 ${chosen.length}/3</strong><span>선택한 앱·게임을 나란히 살펴볼 수 있습니다.</span><a class="button outline-blue small" href="#/lab/compare">후보 비교하기 →</a><button class="button ghost small" data-lab-action="clear-compare">모두 해제</button></div>`:''}
 <div class="lab-result-tools"><p class="small-copy">${ui.radarQuery?'검색 일치 항목을 우선 표시합니다. 기존 국가·스토어·관측 신호 필터도 함께 적용됩니다.':ui.sort==='rank'?'순위 정렬은 단일 국가·스토어·카테고리·차트 선택 시에만 적용됩니다.':'차트가 다른 순위를 합산하지 않으며 전체 신호는 스토어별로 번갈아 표시합니다.'} · 실제 관측 날짜만 표시</p><div class="chips"><button class="chip ${ui.view==='cards'?'selected':''}" data-lab-action="view" data-value="cards">카드</button><button class="chip ${ui.view==='list'?'selected':''}" data-lab-action="view" data-value="list">목록</button></div></div>
 ${rows.length?`<div class="${ui.view==='list'?'lab-list':'lab-card-grid'}">${rows.slice(0,ui.radarLimit).map(card).join('')}</div>${rows.length>ui.radarLimit?`<div class="lab-more"><button class="button ghost" data-lab-action="more-radar">더 보기 (${(rows.length-ui.radarLimit).toLocaleString('ko-KR')}개 남음)</button></div>`:''}`:empty('선택한 조건의 관측 후보가 없습니다.','다른 국가·기간·스토어로 바꾸거나 추가 수집 이후 확인해 주세요.')}
 <p class="lab-disclaimer">※ Apple 실제 출시일은 수집된 release_date만 사용합니다. Google Play·itch.io는 출시일 미확인입니다. '처음 관측'은 신규 출시가 아니며, itch.io 피드 순서는 인기 순위가 아닙니다. 수집 실패·관측 누락을 순위권 이탈로 보지 않습니다.</p>`;
}
function tagCounts(){const counts=new Map();for(const item of index.items.filter(i=>i.has_ai))for(const tag of item.tags||[])counts.set(tag,(counts.get(tag)||0)+1);return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ko'));}
// Select a whole broad family with one click; optional detail mode can exclude
// individual tags from that family without changing the index or Gemini data.
// Independent individual tag selections are OR'ed with selected families.
function activeFeatureTags(){
 const tags=new Set(ui.featureTags);
 const excluded=new Set(ui.featureExcludedTags);
 if(ui.featureGroups.length){
  for(const tag of Object.keys(index?.tag_groups||{})){
   if(ui.featureGroups.includes(tagFamily(tag))&&!excluded.has(tag))tags.add(tag);
  }
 }
 return [...tags];
}
// The returned candidates are a UNION, not an AND intersection.
function featureRows(){
 const selected=activeFeatureTags();
 return searchResults(index.items.filter(item=>{
   if(!item.has_ai || !item.tags?.length)return false;
   if(selected.length&&!selected.some(tag=>item.tags.includes(tag)))return false;
   if(!selected.length&&(ui.featureGroups.length||ui.featureTags.length))return false;
   return true;
 }),ui.featureQuery);
}
function featureRelatedCounts(rows,selected){
 const counts=new Map();
 for(const item of rows){
   for(const tag of new Set(item.tags||[])){
     if(selected.includes(tag))continue;
     counts.set(tag,(counts.get(tag)||0)+1);
   }
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ko'));
}
function featureInsights(rows,selected){
 if(!selected.length)return '';
 const related=featureRelatedCounts(rows,selected);
 const kindCounts=[['앱',rows.filter(i=>i.kind==='app').length],['게임',rows.filter(i=>i.kind==='game').length]].filter(([,n])=>n);
 const difficulty=new Map();
 for(const item of rows)if(item.difficulty)difficulty.set(item.difficulty,(difficulty.get(item.difficulty)||0)+1);
 const difficultyCounts=[...difficulty].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ko'));
 const active=ui.featureRelatedTag;
 return `<section class="panel lab-feature-insights ${ui.featureInsightsOpen?'is-open':'is-collapsed'}" aria-label="선택된 후보의 공통·연관 기능">
  <button type="button" class="lab-feature-insights-toggle" data-lab-action="toggle-feature-insights" aria-expanded="${ui.featureInsightsOpen}" aria-controls="lab-feature-insights-body"><span class="lab-insights-toggle-title"><strong>모인 후보의 공통·연관 기능</strong><small>후보 ${rows.length}개 · 함께 나타난 기능 ${related.length}종${active?` · 선택: ${esc(active)}`:''}</small></span><span class="lab-collapse-label">${ui.featureInsightsOpen?'접기 ▲':'연관 기능 펼치기 ▾'}</span></button>
  ${ui.featureInsightsOpen?`<div id="lab-feature-insights-body" class="lab-feature-insights-body">
   <div class="lab-feature-insights-head"><p>이 후보들의 AI 기능 태그를 모아 공통·연관 특징을 집계했습니다. 아래 태그를 누르면 해당하는 후보만 따로 볼 수 있습니다.</p>${active?`<button type="button" class="lab-feature-reset" data-lab-action="clear-feature-related">연관 기능 보기 해제</button>`:''}</div>
   <div class="lab-feature-profile"><span><strong>후보 구성</strong> ${kindCounts.map(([name,n])=>`${esc(name)} ${n}개`).join(' · ')||'분류 없음'}</span><span><strong>AI 참고 난이도</strong> ${difficultyCounts.length?difficultyCounts.map(([name,n])=>`${esc(name)} ${n}개`).join(' · '):'정보 없음'}</span></div>
   ${related.length?`<div class="lab-feature-related-tags" role="group" aria-label="함께 나타난 기능 태그">${(ui.featureRelatedExpanded?related:related.slice(0,12)).map(([tag,count])=>`<button type="button" class="lab-feature-related ${tag===active?'is-selected':''}" style="${featureTone(tag)}" data-lab-action="feature-related" data-value="${attr(tag)}" aria-pressed="${tag===active}" title="${attr(tag)} 태그가 있는 후보 ${count}개 보기"><span>${esc(tag)}</span><strong>${count}개</strong>${count===rows.length&&rows.length>1?'<em>전체 공통</em>':''}</button>`).join('')}</div>${related.length>12?`<button type="button" class="lab-feature-family-more" data-lab-action="toggle-feature-related-more">${ui.featureRelatedExpanded?'연관 기능 줄이기':`다른 연관 기능 ${related.length-12}종 더 보기`}</button>`:''}`:'<p class="small-copy lab-feature-no-related">선택한 후보에 추가로 함께 등장한 기능 태그가 없습니다.</p>'}
   <p class="small-copy lab-feature-insights-note">표시 개수는 모인 후보에서 해당 기능이 언급된 수입니다. AI 분석 기반의 연관성으로, 원작의 실제 구현을 검증한 결과는 아닙니다.</p>
  </div>`:'<div id="lab-feature-insights-body" hidden></div>'}
 </section>`;
}
function features(){
 const counts=tagCounts(), selected=activeFeatureTags(), baseRows=featureRows();
 const matchingTags=counts.filter(([tag])=>tag.toLocaleLowerCase().includes(ui.tagQuery.trim().toLocaleLowerCase()));
 const groups=groupedTags(matchingTags),searchActive=Boolean(ui.tagQuery.trim());
 const familySelected=ui.featureGroups.length>0,anySelected=familySelected||ui.featureTags.length>0;
 const relatedChoices=featureRelatedCounts(baseRows,selected).map(([tag])=>tag);
 if(ui.featureRelatedTag&&!relatedChoices.includes(ui.featureRelatedTag))ui.featureRelatedTag='';
 const related=ui.featureRelatedTag;
 const rows=related?baseRows.filter(item=>item.tags.includes(related)):baseRows;
 const tagButton=(tag,count)=>{
  const active=selected.includes(tag),fromGroup=ui.featureGroups.includes(tagFamily(tag));
  const hint=fromGroup?(active?'이 태그만 제외':'제외 취소'):(active?'선택 해제':'선택');
  return `<button type="button" class="lab-tag lab-feature-tag ${active?'is-selected':''} ${fromGroup&&!active?'is-excluded':''}" style="${featureTone(tag)}" data-lab-action="feature-tag" data-value="${attr(tag)}" aria-pressed="${active}" aria-label="${attr(tag)} ${hint}" title="${attr(hint)}"><span class="lab-feature-check" aria-hidden="true">${active?'✓':fromGroup?'−':''}</span>${esc(tag)} <span class="lab-feature-count">${count}</span></button>`;
 };
 const allCount=baseRows.length;
 const matchedText=anySelected?`선택한 ${ui.featureGroups.length}개 분류·${ui.featureTags.length}개 개별 기능에서 ${allCount}개 후보를 합쳐 찾았습니다.`:`기능 근거가 확인된 ${allCount}개`;
 const groupedChosen=ui.featureGroups.map(f=>`<button type="button" class="lab-selected-feature" data-lab-action="toggle-feature-family" data-value="${attr(f)}" aria-label="${attr(f)} 분류 선택 해제"><span>▣ ${esc(f)}</span><span class="lab-selected-feature-x" aria-hidden="true">×</span></button>`);
 const individuallyChosen=ui.featureTags.map(tag=>`<button type="button" class="lab-selected-feature" style="${featureTone(tag)}" data-lab-action="feature-tag" data-value="${attr(tag)}" aria-label="${attr(tag)} 선택 해제"><span>${esc(tag)}</span><span aria-hidden="true" class="lab-selected-feature-x">×</span></button>`);
 return `<div class="lab-section-heading"><div><h2>기능 탐색</h2><p>큰 기능 분류를 누르면 해당 분류의 후보를 바로 모읍니다. 세부 기능은 원할 때만 펼쳐 제외할 수 있습니다.</p></div>${badge(`태그 ${counts.length}종`,'blue')}</div>
 <div class="panel lab-feature-tools">
  ${searchControls('featureQuery','기능·앱·AI 내용 검색','예: 머지, 카드, 위치, 인벤토리')}
  <div class="lab-tag-toolbar"><label>세부 기능 검색<input type="search" data-lab-search="tagQuery" value="${attr(ui.tagQuery)}" placeholder="특정 기능명을 찾을 때 검색"></label><span>분석에서 나온 태그 ${counts.length}종${searchActive?` · 검색된 태그 ${matchingTags.length}종`:''}</span></div>
  <div class="lab-feature-family-header"><button type="button" class="lab-feature-families-toggle" data-lab-action="toggle-feature-families" aria-expanded="${ui.featureFamiliesOpen}" aria-controls="lab-feature-families-body"><strong>큰 분류 ${groups.length}개</strong><span>· 선택 ${ui.featureGroups.length}개</span><span class="lab-collapse-label">${ui.featureFamiliesOpen?'분류 접기 ▲':'분류 펼치기 ▾'}</span></button><button type="button" class="lab-tag lab-feature-all ${!anySelected?'is-selected':''}" data-lab-action="feature-tag" data-value="all" aria-pressed="${!anySelected}">선택 전체 해제</button></div>
  ${ui.featureFamiliesOpen?`<p class="small-copy lab-feature-family-guide">분류명을 누르면 그 분류에 속한 모든 후보를 모읍니다. 오른쪽 상세는 세부 태그 확인·제외용입니다.</p>`:''}
  ${ui.featureFamiliesOpen?(groups.length?`<div id="lab-feature-families-body" class="lab-feature-families">${groups.map(([family,visibleGroupTags])=>{
    const opened=searchActive||ui.featureOpenGroups.includes(family);
    const expanded=searchActive||ui.featureExpandedGroups.includes(family);
    // The family click always selects every tag in this family, even when a
    // text search is narrowing which names are displayed inside the details.
    const full=counts.filter(([tag])=>tagFamily(tag)===family);
    const visible=expanded?visibleGroupTags:visibleGroupTags.slice(0,12);
    const tagsInFamily=new Set(full.map(([tag])=>tag));
    const unique=index.items.filter(i=>i.has_ai&&i.tags?.some(tag=>tagsInFamily.has(tag))).length;
    const isChosen=ui.featureGroups.includes(family);
    const omitted=ui.featureExcludedTags.filter(tag=>tagsInFamily.has(tag)).length;
    return `<section class="lab-feature-family ${opened?'is-open':''} ${isChosen?'is-selected':''}">
     <div class="lab-feature-family-row">
      <button type="button" class="lab-feature-family-pick" data-lab-action="toggle-feature-family" data-value="${attr(family)}" aria-pressed="${isChosen}" aria-label="${attr(family)} 분류 ${isChosen?'선택 해제':'후보 모두 선택'}"><span class="lab-family-check" aria-hidden="true">${isChosen?'✓':'＋'}</span><strong>${esc(family)}</strong><span class="lab-family-count">${full.length}종 · 후보 ${unique}개${omitted?` · ${omitted}종 제외`:''}</span></button>
      <button type="button" class="lab-feature-family-toggle" data-lab-action="toggle-feature-group" data-value="${attr(family)}" aria-expanded="${opened}" aria-label="${attr(family)} 세부 기능 ${opened?'접기':'펼치기'}" title="세부 기능 ${opened?'접기':'보기'}">${opened?'접기 ▲':'상세 ▾'}</button>
     </div>
     ${opened?`<div class="lab-feature-family-body"><p class="small-copy">${isChosen?'선택된 분류입니다. 필요 없는 세부 태그만 눌러 제외하고, 다시 누르면 복구합니다.':'아래 세부 태그만 개별 선택할 수도 있습니다.'}</p><div class="lab-tag-row lab-feature-tag-choices" role="group" aria-label="${attr(family)} 세부 기능">${visible.map(([tag,count])=>tagButton(tag,count)).join('')}</div>${!searchActive&&visibleGroupTags.length>12?`<button type="button" class="lab-feature-family-more" data-lab-action="toggle-feature-group-more" data-value="${attr(family)}">${expanded?'세부 기능 줄이기':`나머지 ${visibleGroupTags.length-12}종 펼치기`}</button>`:''}</div>`:''}
    </section>`;
   }).join('')}</div>`:'<p class="small-copy">검색어와 일치하는 세부 기능이 없습니다.</p>'):'<div id="lab-feature-families-body" hidden></div>'}
  ${anySelected?`<div class="lab-selected-features" role="group" aria-label="현재 선택한 기능">
   <div class="lab-selected-features-head"><strong>선택한 기능 <span>${ui.featureGroups.length+ui.featureTags.length}개</span></strong><span>큰 분류 ${ui.featureGroups.length}개 · 개별 기능 ${ui.featureTags.length}개${ui.featureExcludedTags.length?` · 세부 제외 ${ui.featureExcludedTags.length}종`:''} · 하나라도 해당하면 후보 표시</span><button type="button" class="lab-feature-reset" data-lab-action="clear-feature-tags">전체 해제</button></div>
   <div class="lab-selected-feature-list">${[...groupedChosen,...individuallyChosen].join('')}</div>
   <p class="lab-feature-combined-count" role="status">선택된 태그 총 ${selected.length}종${ui.featureExcludedTags.length?` (세부 ${ui.featureExcludedTags.length}종 제외)`:''} → <strong>중복 제거 후 ${allCount}개 후보</strong>${ui.featureQuery?' (검색어 적용)':''}</p>
  </div>`:'<p class="lab-feature-hint">큰 분류를 하나 이상 눌러보세요. 선택되면 아래에 해당 후보가 바로 표시됩니다. 상세 ▾ 버튼은 세부 기능을 확인하거나 일부를 제외할 때만 사용합니다.</p>'}
  <p class="small-copy lab-feature-source-note">태그는 Gemini의 기능·시스템 분석에서 생성한 참고 분류입니다. 원작에 실제 구현됐는지 검증된 사실은 아닙니다.</p>
 </div>
 ${featureInsights(baseRows,selected)}
 <div class="lab-feature-export-toolbar panel"><div><strong>찾은 후보를 다음 분석으로 연결</strong><p class="small-copy">현재 기능·검색·연관 필터로 찾은 ${rows.length}개 후보. 화면의 60개 표시 제한과 관계없이, 미선택 후보를 최대 ${EXPORT_MAX}개까지 담습니다.</p></div><button type="button" class="button outline-blue small" data-lab-action="feature-export-add" ${rows.length?'':'disabled'}>현재 후보 내보내기에 담기 (${Math.min(rows.length,EXPORT_MAX)}개까지)</button><a class="button ghost small" href="#/lab/export">내보내기 확인 →</a></div>
 <div class="lab-section-heading"><div><h3>찾은 개발 참고 후보</h3><p>${esc(matchedText)}${related?` · 그중 ${esc(related)} 관련 ${rows.length}개를 살펴보는 중`:''}</p></div>${related?`<button type="button" class="lab-feature-reset" data-lab-action="clear-feature-related">연관 기능 보기 해제</button>`:''}</div>
 ${rows.length?`<div class="lab-card-grid">${rows.slice(0,ui.featureLimit).map(item=>`<article class="panel lab-feature-card"><div class="lab-card-head">${icon(item)}<div class="lab-card-id"><a class="lab-name" href="#/lab/analysis?app=${encodeURIComponent(item.app_key)}">${esc(item.name)}</a><div class="small-copy">${esc(sourceText(item))} · ${esc(item.category||'분류 없음')}</div></div></div>${matchHint(item,ui.featureQuery)}<p class="lab-summary">${esc(item.summary||'분석에 포함된 기능 태그를 확인해 주세요.')}</p><div class="lab-tag-row">${item.tags.map(t=>featureBadge(t,item)).join('')}</div><div class="small-copy">AI 분석 기반${item.difficulty?` · 참고 난이도: ${esc(item.difficulty)}`:''}</div>${actions(item)}</article>`).join('')}</div>${rows.length>ui.featureLimit?`<div class="lab-more"><button type="button" class="button ghost" data-lab-action="more-features">후보 더 보기 (${rows.length-ui.featureLimit}개 남음)</button></div>`:''}`:empty('해당 기능과 함께 나타난 후보가 없습니다.','분류 선택이나 제외한 세부 태그를 확인해 주세요.')}`;
}
const sectionHTML=(heading,content,foot='')=>`<section class="lab-ai-section"><h3>${esc(heading)}</h3>${content||'<p class="small-copy">해당 정보가 없습니다.</p>'}${foot?`<p class="small-copy">${esc(foot)}</p>`:''}</section>`;
const para=t=>t?`<p class="lab-ai-paragraph">${esc(t)}</p>`:'';
const list=(arr)=>Array.isArray(arr)&&arr.length?`<ul class="lab-ai-list">${arr.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'';
function aiDetail(item,record){
 if(!record)return `<div class="panel lab-ai-detail">${empty('AI 원본을 확인 중입니다.','기존 Gemini 분석 파일을 읽고 있습니다.')}</div>`;
 const a=record.analysis||{},level=a.difficulty_ko||{},mvp=a.solo_mvp_ko||{},ideas=a.ideas_ko||[];
 const source=record.source_description;
 const quick=`<section class="lab-ai-quick" aria-label="개발 관점 핵심 요약"><div class="lab-ai-quick-title"><h3>개발 관점 핵심 요약</h3><span>Gemini V2 참고 · 자세한 내용은 아래 원문 분석에서 확인</span></div><div class="lab-ai-quick-grid"><div><h4>핵심 기능</h4>${list((a.features_ko||[]).slice(0,2))||'<p class="small-copy">정리된 핵심 기능 없음</p>'}</div><div><h4>혼자 만드는 첫 MVP</h4>${list((mvp.must_have||[]).slice(0,3))||'<p class="small-copy">MVP 제안 없음</p>'}</div><div><h4>개발 부담·위험</h4>${level.level?difficultyBadge(level.level):''}${list((mvp.risks||[]).slice(0,2))||para(level.reason)||'<p class="small-copy">위험 분석 없음</p>'}</div></div></section>`
 const sect=[sectionHTML('한국어 개요',para(a.summary_ko)),sectionHTML('소개에서 정리한 핵심 기능',list(a.features_ko),'원본 소개를 바탕으로 한 AI 정리입니다.'),
 sectionHTML('눈여겨볼 특징',para(a.noteworthy_ko)+list(a.highlights_ko)),sectionHTML('개발 관점',para(a.development_ko)),
 sectionHTML('필요한 구현 시스템',list(a.systems_ko),'원작의 내부 아키텍처가 확인된 사실은 아닙니다.'),
 sectionHTML('개발 난이도 · AI 참고 판단',`${level.level?difficultyBadge(level.level):''}${para(level.reason)}`),
 sectionHTML('혼자 만드는 MVP',`<div class="lab-mvp"><div><strong>먼저 구현</strong>${list(mvp.must_have)||para('제안 없음')}</div><div><strong>나중에 구현</strong>${list(mvp.defer)||para('제안 없음')}</div><div><strong>주의할 위험</strong>${list(mvp.risks)||para('제안 없음')}</div></div>`),
 sectionHTML('응용 아이디어',`${Array.isArray(ideas)?ideas.map(idea=>`<div class="lab-idea"><strong>${esc(idea.title||'아이디어')}</strong>${para(idea.concept)}${idea.first_step?`<p><b>첫 단계</b> ${esc(idea.first_step)}</p>`:''}</div>`).join(''):''}${para(a.idea_ko)}`,'원작의 실제 기능이 아닌 AI가 제안한 새로운 기획입니다.'),
 sectionHTML('종합 조언',para(a.recommendation_ko)),sectionHTML('원본에서 확인하기 어려운 부분',para(a.source_limitations_ko)),
 sectionHTML('원본 스토어 소개',source?para(source):'<p class="small-copy">원본 소개 미보관 · AI 분석 기록은 그대로 유지합니다.</p>','수집·보관된 공개 설명이며, 다른 국가의 설명으로 대체하지 않습니다.')];
 return `<div class="panel lab-ai-detail"><div class="lab-ai-top"><div class="lab-card-head">${icon(item)}<div class="lab-card-id"><h2>${esc(item.name)}</h2><p class="small-copy">${esc(labelSource(record.source))} · ${esc(record.country||'국가 미확인')} · AI 분석 ${formatDate(record.analysed_at)} · ${esc(record.model||'모델 미기록')} / ${esc(record.prompt_version||'버전 미기록')}</p></div></div><div class="lab-actions">${safeUrl(record.detail_url)?`<a class="button ghost small" target="_blank" rel="noopener noreferrer" href="${attr(safeUrl(record.detail_url))}">원본 스토어 ↗</a>`:''}<button class="button outline-blue small" data-lab-action="toggle-compare" data-key="${attr(item.app_key)}">${chosen.includes(item.app_key)?'✓ 비교 선택됨':'+ 비교'}</button>${exportToggle(item.app_key)}</div></div><div class="lab-callout">구분 안내: <strong>스토어에서 보관된 내용</strong>과 <strong>Gemini가 정리·해석·제안한 내용</strong>은 다릅니다. 실제 게임 플레이나 내부 기술 구현을 검증한 결과가 아닙니다.</div>
  ${quick}<div class="lab-ai-feature-strip"><strong>기능 태그 <small>Gemini 분석 기반 · 태그에 마우스를 올리면 추출 근거 표시</small></strong><div class="lab-tag-row">${item.tags?.length?item.tags.map(t=>featureBadge(t,item)).join(''):'<span class="small-copy">추출된 기능 태그가 없습니다.</span>'}</div>${Object.keys(item.tag_evidence||{}).length?`<details class="lab-tag-evidence"><summary>태그의 근거 문장 보기 (${Object.keys(item.tag_evidence).length}개)</summary><ul>${Object.entries(item.tag_evidence).map(([tag,entries])=>`<li><strong>${esc(tag)}</strong><span>${entries.map(e=>`${e.field==='systems_ko'?'구현 시스템 제안':'핵심 기능'}: ${esc(e.text)}`).join('<br>')}</span></li>`).join('')}</ul></details>`:''}</div>${sect.join('')}</div>`;
}
function analysisFeatureSelect(){
 const grouped=groupedTags(tagCounts());
 return `<label class="lab-field"><span>기능</span><select data-lab-filter="analysisTag" class="field-select"><option value="all" ${ui.analysisTag==='all'?'selected':''}>기능 전체</option>${grouped.map(([name,tags])=>`<optgroup label="${attr(name)}">${tags.map(([tag])=>`<option value="${attr(tag)}" ${ui.analysisTag===tag?'selected':''}>${esc(tag)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
}
function analysisRows(){const rows=index.items.filter(i=>i.has_ai && sourceMatches(i,ui.analysisSource)&&(ui.analysisKind==='all'||i.kind===ui.analysisKind)&&(ui.analysisDifficulty==='all'||i.difficulty===ui.analysisDifficulty)&&(ui.analysisTag==='all'||i.tags.includes(ui.analysisTag))).sort((a,b)=>Number(isExportSelected(b.app_key))-Number(isExportSelected(a.app_key))||b.analysed_at.localeCompare(a.analysed_at));return searchResults(rows,ui.analysisQuery);}
function analysisRow(item,key){
 const inExport=isExportSelected(item.app_key);
 return `<a class="lab-ai-row ${key===item.app_key?'active':''} ${inExport?'is-export-selected':''}" data-analysis-row-key="${attr(item.app_key)}" href="#/lab/analysis?app=${encodeURIComponent(item.app_key)}">${icon(item)}<span class="lab-ai-row-info"><strong>${esc(item.name)}</strong><small>${esc(sourceText(item))} · ${formatDate(item.analysed_at)}</small>${matchHint(item,ui.analysisQuery)}<span class="lab-ai-row-badges">${item.difficulty?difficultyBadge(item.difficulty):''}${inExport?'<span class="lab-export-mark">✓ 내보내기</span>':''}</span></span></a>`;
}
function exportTrayContents(){
 const keys=manualExportKeys();
 return `${keys.length?`<div class="lab-export-tray-list" role="list">${keys.map(key=>{
  const item=index.map.get(key);
  return `<div class="lab-export-tray-item" role="listitem"><a href="${item.has_ai?`#/lab/analysis?app=${encodeURIComponent(key)}`:attr(labDetailHref(key))}" title="${attr(item.name||key)} 상세 보기">${icon(item)}<span>${esc(item.name||key)}<small>${esc(sourceText(item))}${item.has_ai?' · AI 분석 있음':' · 미분석'}</small></span></a><button type="button" data-lab-action="toggle-export" data-key="${attr(key)}" aria-label="${attr(item.name||key)} 내보내기 해제">×</button></div>`;
 }).join('')}</div>`:'<p class="small-copy">담은 후보가 없습니다. 분석 상세의 「+ 내보내기 담기」를 눌러 주세요.</p>'}
 <div class="lab-export-tray-footer"><button type="button" class="button ghost small lab-export-clear" data-lab-action="clear-export-manual" ${keys.length?'':'disabled'}>담은 후보 전체 비우기</button><a class="button outline-blue small" href="#/lab/export">자료 내보내기로 이동 →</a></div>`;
}
// Update only the affected controls; do not reset long analysis content or scroll.
function syncAnalysisExportUI(){
 if(typeof document==='undefined'||!location.hash.startsWith('#/lab/analysis'))return false;
 const keys=manualExportKeys();
 document.querySelectorAll?.('[data-lab-action="toggle-export"]').forEach(button=>{
   if(button.closest?.('.lab-export-tray'))return;
   const selected=keys.includes(button.dataset.key);
   button.classList.toggle('is-selected',selected);
   button.setAttribute('aria-pressed',String(selected));
   button.textContent=selected?'✓ 내보내기 담김':'+ 내보내기 담기';
   button.title=selected?'내보내기 목록에서 빼기':'내보내기 목록에 담기';
 });
 document.querySelectorAll?.('[data-analysis-row-key]').forEach(row=>{
   const selected=keys.includes(row.dataset.analysisRowKey);
   row.classList.toggle('is-export-selected',selected);
   let mark=row.querySelector('.lab-export-mark');
   if(selected&&!mark){row.querySelector('.lab-ai-row-badges')?.insertAdjacentHTML('beforeend','<span class="lab-export-mark">✓ 내보내기</span>');}
   if(!selected&&mark)mark.remove();
 });
 const n=document.querySelector?.('[data-lab-export-count]');if(n)n.textContent=`내보내기 ${keys.length}개 ▾`;
 document.querySelectorAll?.('[data-lab-export-clear]').forEach(clear=>clear.disabled=!keys.length);
 const total=document.querySelector?.('.lab-analysis-selection-tools > span > strong');if(total)total.textContent=String(keys.length);
 const content=document.querySelector?.('#lab-analysis-export-tray-content');if(content)content.innerHTML=exportTrayContents();
 return true;
}
function extendAnalysisList(){
 const rows=analysisRows(),from=ui.analysisLimit;
 ui.analysisLimit=Math.min(from+28,rows.length);
 const control=document.querySelector('[data-lab-action="more-analysis"]');
 if(!control)return false;
 const wrap=control.closest('.lab-more');
 if(!wrap)return false;
 const key=(new URLSearchParams((location.hash.split('?')[1]||''))).get('app')||ui.analysisKey||rows[0]?.app_key;
 // Append inside the scrollable aside without recreating the page or changing scroll position.
 const scroller=wrap.closest('.lab-analysis-list'),previousScroll=scroller?.scrollTop;
 wrap.insertAdjacentHTML('beforebegin',rows.slice(from,ui.analysisLimit).map(i=>analysisRow(i,key)).join(''));
 if(scroller)scroller.scrollTop=previousScroll;
 if(ui.analysisLimit>=rows.length)wrap.remove();
 else control.textContent=`더 보기 (${rows.length-ui.analysisLimit}개 남음)`;
 return true;
}
function analysis(tabQuery){
 const rows=analysisRows();const queryKey=tabQuery.get('app');let key=(queryKey&&index.map.get(queryKey)?.has_ai)?queryKey:ui.analysisKey;
 if(queryKey && index.map.has(queryKey) && !index.map.get(queryKey).has_ai){
   const entry=index.map.get(queryKey);
   return `<div class="lab-section-heading"><div><h2>개발 분석</h2><p>아직 Gemini 분석이 누적되지 않은 후보입니다.</p></div></div><div class="panel lab-ai-detail"><div class="lab-card-head">${icon(entry)}<div class="lab-card-id"><h2>${esc(entry.name)}</h2><p class="small-copy">${esc(labelSource(entry.source))}</p></div></div>${empty('AI 분석 준비 전','이 앱의 분석 데이터가 아직 없습니다. 순위·수집 관측이 앱의 가치를 판단하는 점수는 아닙니다.')}<div class="lab-actions"><a class="button ghost" href="${attr(labDetailHref(entry.app_key))}">수집 상세</a><a class="button outline-blue" href="#/lab/radar">발견 레이더</a></div></div>`;
 }
 if(!index.map.get(key)?.has_ai||(ui.analysisQuery.trim()&&!rows.some(i=>i.app_key===canonicalKey(key))))key=rows[0]?.app_key||'';
 if(key&&!AI_CACHE.has(key))loadAI(key).catch(()=>{}); // Detail resolves in place, never jump the page after asynchronous AI loading.
 const status=AI_CACHE.get(key);const selected= index.map.get(key);
 const detail=status?'<div id="lab-async-detail" class="panel lab-ai-detail"><div class="center-loading"><span class="loading-spinner"></span><p>AI 상세 분석을 가져오는 중입니다.</p></div></div>':'';
 // Render fulfilled async content without assuming that Promise results are synchronous.
 if(status)status.then(record=>{if(document.getElementById('lab-async-detail')?.dataset.key===key)document.getElementById('lab-async-detail').outerHTML=aiDetail(selected,record);}).catch(()=>{const el=document.getElementById('lab-async-detail');if(el?.dataset.key===key)el.innerHTML=empty('이 분석 파일을 읽지 못했습니다.','다른 앱의 분석은 계속 사용할 수 있습니다.');});
 return `<div class="lab-section-heading"><div><h2>개발 분석</h2><p>누적된 Gemini V2.0의 전체 필드를 살펴보고, 혼자 만들 MVP와 첫 단계를 검토합니다.</p></div>${badge(`분석 ${index.ai_count}건`,'green')}</div><div class="panel lab-analysis-toolbar">${searchControls('analysisQuery','분석 검색','앱 이름·기능·AI 상세 내용')}${select('analysisSource',[['all','모든 스토어'],['apple','App Store'],['google','Google Play'],['itch','itch.io']],ui.analysisSource,'스토어')}${select('analysisKind',[['all','앱·게임 전체'],['app','앱'],['game','게임']],ui.analysisKind,'유형')}${select('analysisDifficulty',[['all','AI 난이도 전체'],...['쉬움','보통','어려움','판단 어려움'].map(x=>[x,x])],ui.analysisDifficulty,'AI 난이도')}${analysisFeatureSelect()}</div>
 <div class="lab-analysis-selection-tools"><span>내보내기 후보 <strong>${manualExportKeys().length}개</strong> · 상세에서 버튼을 눌러 담거나 해제할 수 있습니다.</span><details class="lab-export-tray" id="lab-analysis-export-tray"><summary data-lab-export-count>내보내기 ${manualExportKeys().length}개 ▾</summary><div id="lab-analysis-export-tray-content" class="lab-export-tray-content">${exportTrayContents()}</div></details><button type="button" class="button ghost small lab-export-clear" data-lab-action="clear-export-manual" data-lab-export-clear ${manualExportKeys().length?'':'disabled'}>내보내기 전체 비우기</button><a class="button outline-blue small" href="#/lab/export">자료 내보내기 →</a></div>
 <div class="lab-analysis-layout"><aside class="panel lab-analysis-list"><div class="lab-side-title">분석 목록 <span>${rows.length}건</span></div>${rows.length?rows.slice(0,ui.analysisLimit).map(i=>analysisRow(i,key)).join('')+ (rows.length>ui.analysisLimit?`<div class="lab-more"><button class="button ghost small" data-lab-action="more-analysis">더 보기 (${rows.length-ui.analysisLimit}개 남음)</button></div>`:''):empty('검색 조건과 일치하지 않습니다.','다른 분석 조건을 선택해 주세요.')}</aside><div class="lab-analysis-right">${key?`<div id="lab-async-detail" data-key="${attr(key)}" class="panel lab-ai-detail"><div class="center-loading"><span class="loading-spinner"></span><p>AI 상세 분석을 가져오는 중입니다.</p></div></div>`:empty('선택할 AI 분석이 없습니다.')}</div></div>`;
}
function saveChosen(){try{sessionStorage.setItem(SELECT_KEY,JSON.stringify(chosen));}catch{}}
function chosenItems(){return chosen.map(k=>index?.map.get(k)).filter(Boolean);}
const aiText=(record,field)=>{
 const value=record?.analysis?.[field];return Array.isArray(value)?value.join('\n'):plain(value);
};
function compare(){
 const items=chosenItems();for(const i of items)if(i.has_ai&&!AI_CACHE.has(i.app_key))loadAI(i.app_key).then(()=>{if(location.hash.startsWith('#/lab/compare'))refreshPage();}).catch(()=>{});
 const commonCounts=new Map();items.forEach(i=>new Set(i.tags).forEach(tag=>commonCounts.set(tag,(commonCounts.get(tag)||0)+1)));
 const shared=[...commonCounts].filter(([_,count])=>count>=2).map(([tag])=>tag);
 const cells=(fn)=>`<div class="lab-compare-row">${items.map((i,index)=>`<div class="lab-compare-cell" data-label="${attr(i.name)}">${fn(i,index)}</div>`).join('')}</div>`;
 const a=(i)=>AI_RESULT.get(i.app_key)?.analysis||{};
 const showList=(xs)=>list(xs)||'<span class="small-copy">정보 없음</span>';
 const rows=[
  ['실제 차트·피드 관측',i=>miniObs(i)],
  ['핵심 기능 · AI 분석 기반',i=>showList(a(i).features_ko)],
  ['구현 시스템 · AI 참고',i=>showList(a(i).systems_ko)],
  ['개발 난이도와 이유 · AI 참고',i=>{
    const d=a(i).difficulty_ko;return d?`${difficultyBadge(d.level||'판단 어려움')}${para(d.reason)}`:'<span class="small-copy">AI 분석 없음</span>';
  }],
  ['MVP 먼저 구현',i=>showList(a(i).solo_mvp_ko?.must_have)],
  ['MVP 나중에 구현',i=>showList(a(i).solo_mvp_ko?.defer)],
  ['MVP 개발 위험',i=>showList(a(i).solo_mvp_ko?.risks)],
  ['응용 아이디어·첫 단계',i=>{
    const ideas=a(i).ideas_ko||[];return ideas.length?ideas.map(v=>`<div class="lab-idea"><strong>${esc(v.title||'제안')}</strong>${para(v.concept)}${v.first_step?`<p>첫 단계: ${esc(v.first_step)}</p>`:''}</div>`).join(''):'<span class="small-copy">정보 없음</span>';
  }],
  ['자료 공백',i=>`<div class="small-copy">${[!i.has_ai&&'AI 미분석',i.has_ai&&!AI_RESULT.has(i.app_key)&&'분석을 불러오는 중',!i.observations.length&&'최신 관측 기록 없음',!(i.description)&&'최신 원본 소개 미보관'].filter(Boolean).join(' · ')||'표시된 자료 범위에서 별도 공백 없음'}</div>`],
 ];
 const differenceRows=rows.filter(([title,fn])=>{
   const values=items.map(i=>fn(i).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
   return new Set(values).size>1;
 });
 return `<div class="lab-section-heading"><div><h2>후보 비교</h2><p>최대 3개를 나란히 살펴봅니다. 후보 선정과 관심 목록은 별개로 유지됩니다.</p></div><div class="lab-compare-controls">${badge(`${items.length}/3 선택`,'blue')}${items.length?`<button class="button ghost small lab-clear-compare" data-lab-action="clear-compare">비교 전체 초기화</button>`:''}</div></div>
 ${items.length?`<div class="lab-compare-board"><div class="lab-compare-head">${items.map(i=>`<article class="panel lab-compare-title">${icon(i)}<strong>${esc(i.name)}</strong><p class="small-copy">${esc(sourceText(i))} · ${esc(i.category||'분류 없음')}</p><button class="button ghost small" data-lab-action="remove-compare" data-key="${attr(i.app_key)}">제거 / 교체</button></article>`).join('')}</div>
 <div class="lab-compare-tabs">${[['all','전체 보기'],['common','공통점만'],['diff','차이점만']].map(([value,label])=>`<button class="chip ${ui.comparisonMode===value?'selected':''}" data-lab-action="compare-mode" data-value="${value}">${label}</button>`).join('')}</div>
 ${ui.comparisonMode!=='diff'?`<section class="panel lab-compare-summary"><h3>기능 공통점</h3>${shared.length?`<div class="lab-tag-row">${shared.map(featureBadge).join('')}</div>`:'<p class="small-copy">두 개 이상에서 공통으로 추출된 기능 태그가 없습니다.</p>'}<p class="small-copy">공통점은 같은 정규화 태그가 둘 이상에 등장했을 때만 표시합니다. AI 분석 문장에 근거합니다.</p></section>`:''}
 ${ui.comparisonMode!=='common'?`<div class="lab-compare-table">${(ui.comparisonMode==='diff'?differenceRows:rows).map(([title,fn])=>`<section class="panel lab-compare-feature"><h3>${esc(title)}</h3>${cells(fn)}</section>`).join('')}</div>`:''}
 ${ui.comparisonMode!=='common'?`<div class="panel lab-compare-feature"><h3>후보별 기능 차이</h3>${cells(i=>`<div class="lab-tag-row">${i.tags.filter(tag=>!shared.includes(tag)).map(tag=>badge(tag)).join('')||'<span class="small-copy">단독 태그 없음</span>'}</div>`)}</div>`:''}
 <div class="lab-actions" style="margin-top:20px"><a class="button" href="#/lab/export">이 후보로 자료 내보내기 →</a><a class="button ghost" href="#/lab/radar">다른 후보 찾기</a></div></div>`:empty('비교할 후보를 추가해 주세요.','발견 레이더·기능 탐색·개발 분석에서 + 비교 버튼으로 최대 3개를 선택할 수 있습니다.')}`;
}
const EXPORT_MAX=100;
function saveExportKeys(){try{sessionStorage.setItem(EXPORT_SELECT_KEY,JSON.stringify(ui.exportKeys));}catch{}}
function manualExportKeys(){
 const keys=ui.exportManualInitialized?ui.exportKeys:chosen;
 return [...new Set(keys.map(canonicalKey).filter(key=>index.map.has(key)))].slice(0,EXPORT_MAX);
}
// Export filters are hierarchical. Each next selector uses the matches of the
// preceding selectors; changing a parent resets every descendant to 'all'.
const EXPORT_REC_FIELDS=['exportSignal','exportKind','exportSource','exportCategory','exportDifficulty','exportAI'];
const EXPORT_BROWSE_FIELDS=['exportBrowseKind','exportBrowseSource','exportBrowseCategory','exportBrowseAI'];
const observedCategories=item=>(item.observations||[]).map(o=>o.source==='itch'?o.feed:o.category).filter(Boolean);
function categoryOptions(items,kind,source,selected,field){
 const available=new Set(items.flatMap(observedCategories));
 const allowApps=kind!=='game'&&source!=='itch';
 const allowGames=kind!=='app'&&source!=='itch';
 const allowIndie=kind!=='app'&&(source==='all'||source==='itch');
 const groups=[
  ['일반 앱',allowApps?APP_CATEGORIES:[]],
  ['게임',allowGames?GAME_CATEGORIES:[]],
  ['인디 게임 · itch.io 피드',allowIndie?['featured','new','puzzle','idle']:[]]
 ];
 const known=new Set([...APP_CATEGORIES,...GAME_CATEGORIES,...Object.keys(FEED_LABEL)]);
 groups.push(['추가 수집 분류',[...available].filter(code=>!known.has(code)).sort()]);
 const html=[`<option value="all" ${selected==='all'?'selected':''}>모든 분류</option>`];
 for(const [label,codes] of groups){
  const offered=codes.filter(code=>available.has(code));
  if(offered.length)html.push(`<optgroup label="${attr(label)}">${offered.map(code=>`<option value="${attr(code)}" ${selected===code?'selected':''}>${esc(labelCategory(code))}</option>`).join('')}</optgroup>`);
 }
 return `<label class="lab-field"><span>실제 차트·피드 분류</span><select data-lab-filter="${field}" class="field-select lab-category-select">${html.join('')}</select></label>`;
}
function matchesRecommendation(i,depth=6){
 if(!(i.observations||[]).some(o=>!o.stale&&o.date>=periodStartFor(ui.exportPeriod)&&o.date<=index.data_date))return false;
 if(depth>=1&&ui.exportSignal!=='all'&&!matchingSignals(i,{period:ui.exportPeriod,country:'ALL',source:ui.exportSource,category:ui.exportCategory,price:'all'}).some(s=>s.reason_code===ui.exportSignal))return false;
 if(depth>=2&&ui.exportKind!=='all'&&i.kind!==ui.exportKind)return false;
 if(depth>=3&&!sourceMatches(i,ui.exportSource))return false;
 if(depth>=4&&ui.exportCategory!=='all'&&!(i.observations||[]).some(o=>!o.stale&&o.date>=periodStartFor(ui.exportPeriod)&&(o.category===ui.exportCategory||o.feed===ui.exportCategory)))return false;
 if(depth>=5&&ui.exportDifficulty!=='all'&&i.difficulty!==ui.exportDifficulty)return false;
 if(depth>=6&&ui.exportAI!=='all'&&Boolean(i.has_ai)!==(ui.exportAI==='yes'))return false;
 return true;
}
const recCandidates=depth=>index.items.filter(i=>matchesRecommendation(i,depth));
function recommendationFilters(){
 const afterSignal=recCandidates(1),afterKind=recCandidates(2),afterSource=recCandidates(3),afterCategory=recCandidates(4),afterDifficulty=recCandidates(5);
 const kinds=[['all','앱·게임 전체'],...[['app','앱'],['game','게임']].filter(([v])=>afterSignal.some(i=>i.kind===v))];
 const sources=[['all','스토어 전체'],...[['apple','App Store'],['google','Google Play'],['itch','itch.io']].filter(([v])=>afterKind.some(i=>sourceMatches(i,v)))];
 const difficulty=[['all','AI 난이도 전체'],...['쉬움','보통','어려움','판단 어려움'].filter(v=>afterCategory.some(i=>i.difficulty===v)).map(v=>[v,v])];
 const ai=[['all','AI 전체'],...[['yes','AI 분석 있음'],['no','AI 미분석']].filter(([v])=>afterDifficulty.some(i=>Boolean(i.has_ai)===(v==='yes')))];
 return `<div class="lab-export-rec-filters">
 ${select('exportSignal',SIGNALS,ui.exportSignal,'발견 근거')}
 ${select('exportKind',kinds,ui.exportKind,'유형')}
 ${select('exportSource',sources,ui.exportSource,'스토어')}
 ${categoryOptions(afterSource,ui.exportKind,ui.exportSource,ui.exportCategory,'exportCategory')}
 ${select('exportDifficulty',difficulty,ui.exportDifficulty,'Gemini 참고 난이도')}
 ${select('exportAI',ai,ui.exportAI,'분석 유무')}
 </div><p class="lab-export-filter-guide">앞의 조건을 바꾸면 이후 선택은 초기화됩니다. 각 선택지에는 앞의 조건에 해당하는 자료만 표시합니다.</p>`;
}
const recSignalLabel=code=>SIGNALS.find(([id])=>id===code)?.[1]||code;
function recommendationRows(){
 const recency=i=>Math.max(...(i.observations||[]).filter(o=>!o.stale).map(o=>Date.parse(o.date)||0),0);
 const filtered=recCandidates(6);
 // Deterministic observation-based order; never a cross-store ranking score.
 filtered.sort((a,b)=>recency(b)-recency(a)||(b.analysed_at||'').localeCompare(a.analysed_at||'')||a.name.localeCompare(b.name,'ko'));
 const groups={apple:[],google:[],itch:[],other:[]};
 filtered.forEach(i=>(groups[i.source]||groups.other).push(i));
 const ordered=[];
 while(ordered.length<filtered.length)for(const source of ['apple','google','itch','other'])if(groups[source].length)ordered.push(groups[source].shift());
 return ordered;
}
// Manual chooser: browse actual names/icons without needing to type Japanese,
// English or any other original-language title.
function matchesBrowse(i,depth=4){
 if(depth>=1&&ui.exportBrowseKind!=='all'&&i.kind!==ui.exportBrowseKind)return false;
 if(depth>=2&&!sourceMatches(i,ui.exportBrowseSource))return false;
 if(depth>=3&&ui.exportBrowseCategory!=='all'&&!observedCategories(i).includes(ui.exportBrowseCategory))return false;
 if(depth>=4&&ui.exportBrowseAI!=='all'&&Boolean(i.has_ai)!==(ui.exportBrowseAI==='yes'))return false;
 return true;
}
const browseCandidates=depth=>index.items.filter(i=>matchesBrowse(i,depth));
function browseRows(){
 return searchResults(browseCandidates(4),ui.exportQuery);
}
function browseFilters(){
 const before=index.items,afterKind=browseCandidates(1),afterSource=browseCandidates(2),afterCategory=browseCandidates(3);
 const kinds=[['all','앱·게임 전체'],...[['app','앱'],['game','게임']].filter(([v])=>before.some(i=>i.kind===v))];
 const sources=[['all','스토어 전체'],...[['apple','App Store'],['google','Google Play'],['itch','itch.io']].filter(([v])=>afterKind.some(i=>sourceMatches(i,v)))];
 const ai=[['all','AI 전체'],...[['yes','AI 분석 있음'],['no','AI 미분석']].filter(([v])=>afterCategory.some(i=>Boolean(i.has_ai)===(v==='yes')))];
 return `<div class="lab-export-browse-filters">
 ${select('exportBrowseKind',kinds,ui.exportBrowseKind,'유형')}
 ${select('exportBrowseSource',sources,ui.exportBrowseSource,'스토어')}
 ${categoryOptions(afterSource,ui.exportBrowseKind,ui.exportBrowseSource,ui.exportBrowseCategory,'exportBrowseCategory')}
 ${select('exportBrowseAI',ai,ui.exportBrowseAI,'AI 분석 여부')}
 </div>`;
}
function exportBrowser(selectedKeys){
 const rows=browseRows(),show=rows.slice(0,ui.exportBrowseLimit);
 const remaining=EXPORT_MAX-selectedKeys.length;
 const notChosen=show.filter(i=>!selectedKeys.includes(i.app_key));
 return `<section class="lab-export-browser" aria-label="직접 선택할 앱·게임 목록">
 <div class="lab-export-browser-heading"><strong>수집된 앱·게임 둘러보기</strong><button class="button ghost small" data-lab-action="close-export-browser">목록 닫기</button></div>
 <p class="small-copy">제목을 입력하지 않아도 실제 수집 후보를 눌러 선택할 수 있습니다. 비교 후보와 별도로 최대 ${EXPORT_MAX}개를 고를 수 있습니다.</p>
 ${browseFilters()}
 ${searchControls('exportQuery','후보 목록 검색 (선택 사항)','이름, 기능, AI 내용 검색')}
 <div class="lab-export-browser-tools"><span>일치하는 후보 <strong>${rows.length.toLocaleString('ko-KR')}개</strong> · ${show.length}개 표시</span><button class="button outline-blue small" data-lab-action="add-visible-export" ${!remaining||!notChosen.length?'disabled':''}>현재 목록 ${Math.min(remaining,notChosen.length)}개 선택</button></div>
 <div class="lab-export-browse-list" role="list">${show.length?show.map(i=>{
  const selected=selectedKeys.includes(i.app_key);
  const obs=(i.observations||[]).find(o=>!o.stale)||(i.observations||[])[0];
  return `<div role="listitem" class="lab-export-browse-row ${selected?'is-selected':''}">${icon(i)}<span class="lab-export-browse-info"><strong>${esc(i.name||i.app_key)}</strong><small>${esc(sourceText(i))} · ${esc(i.kind==='game'?'게임':'앱')}${obs?' · '+esc(labelCategory(obs.source==='itch'?obs.feed:obs.category)):''} · ${i.has_ai?'AI 분석 있음':'미분석'}</small>${matchHint(i,ui.exportQuery)}</span><button type="button" class="lab-export-browse-toggle ${selected?'is-selected':''}" data-lab-action="${selected?'remove-export':'add-export'}" data-key="${attr(i.app_key)}" aria-pressed="${selected}" ${!selected&&!remaining?'disabled':''}>${selected?'✓ 선택됨':'+ 선택'}</button></div>`;
 }).join(''):'<p class="small-copy lab-export-browse-empty">조건에 맞는 후보가 없습니다. 앞의 분류를 변경해 주세요.</p>'}</div>
 ${rows.length>show.length?`<div class="lab-more"><button class="button ghost" data-lab-action="more-export-browse">더 보기 (${rows.length-show.length}개 남음)</button></div>`:''}</section>`;
}
function exportSelection(){
 return ui.exportMode==='recommended'?recommendationRows().slice(0,ui.exportCount).map(i=>i.app_key):manualExportKeys();
}
function recommendationBasis(item){
 const parts=[];
 if(ui.exportSignal!=='all'){
  const signal=matchingSignals(item,{period:ui.exportPeriod,country:'ALL',source:ui.exportSource,category:ui.exportCategory,price:'all'}).find(s=>s.reason_code===ui.exportSignal);
  if(signal)parts.push(`${recSignalLabel(ui.exportSignal)}: ${signalText(signal)}`);
 }
 if(ui.exportCategory!=='all')parts.push(`실제 관측 분류: ${labelCategory(ui.exportCategory)}`);
 if(ui.exportDifficulty!=='all')parts.push(`Gemini 참고 난이도: ${item.difficulty}`);
 if(ui.exportAI==='yes')parts.push('Gemini V2 분석 보유');
 if(ui.exportSource!=='all')parts.push(`수집원: ${labelSource(item.source)}`);
 if(ui.exportKind!=='all')parts.push(`유형: ${item.kind==='game'?'게임':'앱'}`);
 if(!parts.length)parts.push('실제 수집 날짜가 있는 관측 후보');
 return parts;
}
function exportView(){
 const selectedKeys=exportSelection(),selectedItems=selectedKeys.map(k=>index.map.get(k)).filter(Boolean);
 const manual=ui.exportMode==='manual',recs=manual?[]:recommendationRows();
 const settings=manual?`<div class="lab-export-selected-heading"><strong>선택한 후보 ${selectedItems.length}개</strong><button type="button" class="button ghost small" data-lab-action="clear-export-manual" ${selectedItems.length?'':'disabled'}>전체 해제</button></div>
 <p class="small-copy">비교 후보 최대 3개 제한과 별도로 최대 ${EXPORT_MAX}개를 직접 선택할 수 있습니다.</p>
 <div class="lab-export-selected">${selectedItems.length?selectedItems.map(i=>`<div class="lab-export-item">${icon(i)}<span>${esc(i.name)}</span><button type="button" class="lab-export-remove" data-lab-action="remove-export" data-key="${attr(i.app_key)}" aria-label="${attr(i.name)} 내보내기에서 제외">×</button></div>`).join(''):'<p class="small-copy">아직 선택한 후보가 없습니다. 아래 목록을 열어 실제 앱·게임을 골라보세요.</p>'}</div>
 ${!ui.exportBrowseOpen?`<button type="button" class="lab-export-browse-open" data-lab-action="toggle-export-browser" aria-expanded="false"><strong>전체 수집 후보에서 직접 고르기</strong><span>앱·게임 목록 열기 →</span></button>`:exportBrowser(selectedKeys)}`:
 `${recommendationFilters()}<div class="lab-export-count-row"><span><strong>조건에 맞는 후보 ${recs.length.toLocaleString('ko-KR')}개</strong> · 실제 관측 근거 기준</span><label>내보낼 개수 <select data-lab-filter="exportCount" class="field-select">${[10,30,50,100].map(n=>`<option value="${n}" ${ui.exportCount===n?'selected':''}>최대 ${n}개</option>`).join('')}</select></label></div>
 <div class="lab-export-rec-preview"><div class="lab-export-selected-heading"><strong>자동 구성 미리보기 · ${selectedItems.length}개</strong><span>스토어별 번갈아 표시 · 순위 합산 없음</span></div>${selectedItems.length?`<div class="lab-export-preview-list">${selectedItems.slice(0,10).map(i=>`<div>${icon(i)}<span><strong>${esc(i.name)}</strong><small>${esc(sourceText(i))} · ${i.has_ai?'AI 분석 있음':'미분석'} ${i.difficulty?' · 참고 난이도 '+esc(i.difficulty):''}</small></span></div>`).join('')}</div>${selectedItems.length>10?`<p class="small-copy">그 외 ${selectedItems.length-10}개도 내보내기에 포함됩니다.</p>`:''}`:'<p class="small-copy">일치하는 실제 자료가 없습니다. 위쪽 조건을 변경해 주세요.</p>'}</div>
 <p class="small-copy">‘추천’은 선택 조건과 수집 근거에 따른 자동 묶음입니다. 개발 성공 가능성·인기도·적합성 점수를 계산하지 않습니다. 난이도는 Gemini 참고 의견입니다.</p>`;
 return `<div class="lab-section-heading"><div><h2>자료 내보내기</h2><p>직접 고르거나 실제 수집 근거로 후보를 묶어 ChatGPT 분석 자료를 만듭니다.</p></div>${badge(`${selectedItems.length}개 선택`,'blue')}</div>
 <div class="lab-export-layout"><section class="panel lab-export-options"><h3>1. 내보내기 방식</h3><div class="lab-export-modes" role="group" aria-label="내보내기 방식">
 <button type="button" class="lab-export-mode ${manual?'active':''}" data-lab-action="export-mode" data-value="manual" aria-pressed="${manual}"><strong>직접 선택</strong><small>전체 후보 목록을 클릭해 선택</small></button>
 <button type="button" class="lab-export-mode ${!manual?'active':''}" data-lab-action="export-mode" data-value="recommended" aria-pressed="${!manual}"><strong>추천 내보내기</strong><small>관측 신호·종류·장르·난이도 조건으로 자동 구성</small></button></div>${settings}
 <h3>2. 기간</h3><div class="chips">${[7,30,90].map(n=>`<button class="chip ${ui.exportPeriod===n?'selected':''}" data-lab-action="export-period" data-value="${n}">${n}일</button>`).join('')}</div>
 <h3>3. 분석 목적</h3>${[['market','시장 변화'],['features','기능·개발 아이디어'],['compare','후보 비교'],['full','전체 심층 분석']].map(([key,name])=>`<label class="lab-radio"><input type="radio" name="lab-export-preset" value="${key}" data-lab-preset ${ui.exportPreset===key?'checked':''}><span><strong>${name}</strong><small>${key==='market'?'국가·실제 차트별 관측 날짜와 순위':key==='features'?'원본 소개 및 AI 기능·MVP·아이디어':key==='compare'?'여러 후보의 주요 항목을 ChatGPT에서 비교':'원본 정보·관측 근거·AI 전체 결과'}</small></span></label>`).join('')}</section>
 <aside class="panel lab-export-summary"><p class="eyebrow">EXPORT PREVIEW</p><h3>ChatGPT 분석 자료</h3>
 <div class="lab-export-stat"><strong>${selectedItems.length}개</strong><span>${manual?'직접 선택한 후보':'조건에 맞춰 자동 구성한 후보'}</span></div>
 <div class="lab-export-stat"><strong>${selectedItems.filter(i=>i.has_ai).length}/${selectedItems.length}개</strong><span>Gemini 분석 보유${ui.exportPreset==='market'?' · 시장 변화 파일에는 원문 미포함':''} (나머지는 미분석)</span></div>
 <div class="lab-export-stat"><strong>${selectedItems.filter(i=>confirmedRelease(i)).length}/${selectedItems.length}개</strong><span>실제 출시일 확인 (현재 Apple 수집만 지원)</span></div>
 <div class="lab-export-stat"><strong>${ui.exportPeriod}일</strong><span>요청 범위 (실제 관측일만 기록)</span></div>
 <div class="lab-export-stat"><strong>${formatDate(index.data_date)}</strong><span>수집 자료 기준일</span></div>
 <div class="lab-callout">앱스토어의 서로 다른 차트를 합산하지 않습니다. AI 분석은 실제 내부 구현이나 성공 가능성을 보증하지 않습니다.</div>
 <div class="lab-export-buttons"><button class="button" ${!selectedItems.length?'disabled':''} data-lab-action="download-json">JSON 다운로드</button><button class="button outline-blue" ${!selectedItems.length?'disabled':''} data-lab-action="download-csv">CSV 다운로드</button><button class="button ghost" ${!selectedItems.length?'disabled':''} data-lab-action="copy-prompt">ChatGPT 질문 복사</button></div>
 <p class="small-copy">최대 ${EXPORT_MAX}개. JSON은 AI 원문과 실제 날짜별 관측을, CSV는 표 형태의 주요 필드를 보존합니다. 개인 관심 메모는 포함하지 않습니다.</p>
 <label class="lab-search-label">복사용 질문<textarea id="lab-prompt" class="note-box" readonly>${esc(promptText(selectedKeys))}</textarea></label></aside></div>`;
}
function promptText(keys){
 const titles=keys.slice(0,15).map(k=>index?.map.get(k)?.name||k);
 const extra=keys.length>15?` 외 ${keys.length-15}개`:'';
 const preset={market:'시장 관측 변화와 나라·차트별 차이',features:'핵심 기능과 1인 개발 MVP',compare:'후보의 공통점·차이점과 우선 검토할 개발 방향',full:'시장 기록·기능·개발 부담·MVP·차별화 아이디어'}[ui.exportPreset];
 const coverage=ui.exportPreset==='market'?0:keys.filter(k=>index?.map.get(k)?.has_ai).length;
 const kinds={all:'앱·게임 전체',app:'앱',game:'게임'},sources={all:'모든 스토어',apple:'App Store',google:'Google Play',itch:'itch.io'};
 const criteria=ui.exportMode==='recommended'?`후보 구성: 수집 신호 ${recSignalLabel(ui.exportSignal)}, 유형 ${kinds[ui.exportKind]||ui.exportKind}, 스토어 ${sources[ui.exportSource]||ui.exportSource}, 실제 분류 ${labelCategory(ui.exportCategory)}, AI 참고 난이도 ${ui.exportDifficulty==='all'?'전체':ui.exportDifficulty}, 분석 보유 ${ui.exportAI==='all'?'전체':ui.exportAI==='yes'?'분석 있음':'미분석'}.\n`:'';
 return `첨부한 app-trend 아이디어 연구실 자료를 기준으로 ${preset}를 분석해 주세요.\n후보 ${keys.length}개: ${titles.join(', ')}${extra}\n${criteria}범위: 최근 ${ui.exportPeriod}일 중 실제 수집된 날짜만. Apple 출시일은 확인된 release_date만 사용하고, Google Play·itch.io 출시일은 미확인으로 취급해 주세요. 첫 관측일은 출시일이 아닙니다.\n${ui.exportPreset==='market'?'이번 시장 변화 파일에는 AI 분석 원문이 포함되지 않습니다.':`Gemini 분석 보유: ${coverage}/${keys.length}개.`} AI가 없는 후보는 원본 설명·실제 관측에 근거한 사실과 새 개발 아이디어 제안을 반드시 구분해 주세요. 첨부 파일에서 확인되지 않는 MVP·난이도는 원작의 검증된 정보처럼 단정하지 마세요.\n실제 스토어 관측 사실과 Gemini AI의 제안·추론을 구분하고, 서로 다른 국가·스토어·차트의 순위를 합산하지 마세요. itch.io 피드의 position은 인기 순위가 아닙니다. 데이터가 없는 부분은 미확인으로 표시해 주세요.\n혼자 구현할 최소 MVP, 개발 부담과 위험, 원작과 다르게 만들 아이디어, 첫 구현 단계를 구체적으로 비교해 주세요.`;
}
function getExportKeys(){return exportSelection();}
async function loadIndieHistory(){
 if(!indiePromise)indiePromise=readJSON('./data/lab/indie_history.json').catch(error=>{indiePromise=null;throw Error(`인디 이력 파일을 읽지 못했습니다: ${error.message}`);});
 return indiePromise;
}
async function loadExportHistory(key){
 const bucket=Array.from(new TextEncoder().encode(key)).reduce((a,b)=>a+b,0)%16;
 if(!EXPORT_HISTORY_CACHE.has(bucket))EXPORT_HISTORY_CACHE.set(bucket,readJSON(`./data/history/${bucket}.json`).then(data=>({data})).catch(error=>{EXPORT_HISTORY_CACHE.delete(bucket);return {error};}));
 const result=await EXPORT_HISTORY_CACHE.get(bucket);
 return {rows:result.data?.[key]||[],error:!!result.error};
}
function sliceObservations(rows,period){const first=periodStartFor(period);return rows.filter(o=>o.date>=first&&o.date<=index.data_date).sort((a,b)=>a.date.localeCompare(b.date));}
function periodStartFor(days){const [y,m,d]=index.data_date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d)-(days-1)*86400000).toISOString().slice(0,10);}
export async function buildExport(){
 const keys=getExportKeys();if(!keys.length)throw Error('내보낼 후보를 먼저 선택하거나 추천 조건을 조정해 주세요.');
 if(ui.exportPreset==='compare'&&keys.length<2)throw Error('후보 비교 자료는 두 개 이상을 선택해야 합니다.');
 const indie=keys.some(k=>k.startsWith('itch:'))?await loadIndieHistory():{};
 const result=[];
 // Keep concurrent JSON requests bounded for bigger export sets.
 for(let cursor=0;cursor<keys.length;cursor+=8){
  const batch=await Promise.all(keys.slice(cursor,cursor+8).map(async key=>{
   const item=index.map.get(key);
   const variants=item.store_variants||[{app_key:key}];
   const [histories,ai]=await Promise.all([Promise.all(variants.map(v=>v.app_key.startsWith('itch:')?Promise.resolve({rows:indie[v.app_key]||[],error:false}):loadExportHistory(v.app_key))),
                item.has_ai&&ui.exportPreset!=='market'?loadAI(key).catch(()=>null):Promise.resolve(null)]);
   if(histories.some(h=>h.error))throw Error(`${item.name}의 순위 이력 파일을 읽지 못했습니다. 정상 이력 확인 후 다시 시도해 주세요.`);
   const observations=sliceObservations(histories.flatMap(h=>h.rows||[]),ui.exportPeriod);
   const limitations=['실제로 수집된 날짜만 포함하며, 미관측일을 0위 또는 순위권 밖으로 해석하지 않음'];
   if(item.has_ai&&!ai&&ui.exportPreset!=='market')limitations.push('AI 상세 JSON을 가져오지 못함');
   if(!item.has_ai)limitations.push('AI 분석 미보유');

   if(!observations.length)limitations.push('선택한 기간의 개별 관측 기록이 없음');
   if(!ai?.source_description)limitations.push('AI 분석 당시 원본 소개 미보관 또는 AI 미분석 · 현재 스냅샷 설명과 구분됨');
   return {app_key:key,app:{name:item.name,source:item.source,kind:item.kind,category:item.category,
       detail_url:item.detail_url,store_variants:item.store_variants||null,first_seen:item.first_seen,
       release_date:confirmedRelease(item)||null,release_date_source:confirmedRelease(item)?'apple_collected_release_date':null},observations,
       discovery_signals:item.signals.filter(s=>(s.source_data_dates||[]).some(d=>d>=periodStartFor(ui.exportPeriod)&&d<=index.data_date)),
       ...(ui.exportPreset==='market'?{}:{source_description:ai?.source_description||null,
          snapshot_description:item.description||null,
          ai_analysis:ai?{model:ai.model,prompt_version:ai.prompt_version,analysed_at:ai.analysed_at,analysis:ai.analysis}:null}),
       ...(ui.exportMode==='recommended'?{selection_basis:recommendationBasis(item)}:{}),
       data_limitations:limitations};
  }));
  result.push(...batch);
 }
 const asOf=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date()).replace(' ','T')+'+09:00';
 return {export_type:'app-trend-idea-lab',schema_version:1,created_at:asOf,data_as_of:index.data_date,
         period_days:ui.exportPeriod,purpose:ui.exportPreset,selection_mode:ui.exportMode,
         ...(ui.exportMode==='recommended'?{selection_filters:{signal:ui.exportSignal,kind:ui.exportKind,source:ui.exportSource,category:ui.exportCategory,difficulty:ui.exportDifficulty,ai:ui.exportAI,max_items:ui.exportCount}}:{}),
         method_note:'순위는 수집 관측치이며 AI 분석은 원작 구현이 확인된 사실이 아닙니다. itch 피드 position은 인기 순위가 아닙니다.',items:result};
}
const csvSafe=v=>{const raw=plain(v);const value=/^\s*[=+\-@]/.test(raw)?`'${raw}`:raw;return `"${value.replaceAll('"','""')}"`;};
export function csvExport(payload){
 const cols=['selection_basis','app_key','name','source','release_date','release_date_source','country','chart','category','feed','date','rank','position','observed_source','ai_analysed_at','ai_difficulty','ai_features','ai_systems','mvp_must_have','mvp_defer','mvp_risks','ai_ideas','detail_url','limitations'];
 const data=[];
 for(const item of payload.items){
  const a=item.ai_analysis?.analysis||{};
  const base={selection_basis:(item.selection_basis||[]).join(' / '),app_key:item.app_key,name:item.app.name,source:item.app.source,
   release_date:item.app.release_date||'',release_date_source:item.app.release_date_source||'',
   observed_source:item.observations.length?'수집 데이터':'관측 기록 없음',
   ai_analysed_at:item.ai_analysis?.analysed_at||'',ai_difficulty:a.difficulty_ko?.level||'',
   ai_features:(a.features_ko||[]).join('\n'),ai_systems:(a.systems_ko||[]).join('\n'),
   mvp_must_have:(a.solo_mvp_ko?.must_have||[]).join('\n'),mvp_defer:(a.solo_mvp_ko?.defer||[]).join('\n'),
   mvp_risks:(a.solo_mvp_ko?.risks||[]).join('\n'),
   ai_ideas:(a.ideas_ko||[]).map(v=>[v.title,v.concept,v.first_step].filter(Boolean).join(' / ')).join('\n'),
   detail_url:item.app.detail_url,limitations:item.data_limitations.join(' / ')};
  for(const obs of item.observations.length?item.observations:[{}])data.push({...base,...obs});
 }
 return '\ufeff'+[cols.map(csvSafe).join(','),...data.map(row=>cols.map(col=>csvSafe(row[col])).join(','))].join('\r\n');
}
function download(file,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=file;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function refreshExport(){
 const prior=document.querySelector?.('.lab-export-browse-list');
 const top=prior?.scrollTop||0;
 refreshPage();
 const next=document.querySelector?.('.lab-export-browse-list');
 if(next)next.scrollTop=top;
}
export async function labAction(button){
 const action=button.dataset.labAction;
 if(action==='retry'){loadError=null;loadPromise=null;refreshPage();return;}
 if(!index)try{await loadLab();}catch{flash('연구실 데이터를 읽지 못했습니다.');return;}
 switch(action){
 case 'signal':ui.signal=button.dataset.value;ui.radarLimit=24;break;
 case 'view':ui.view=button.dataset.value;break;
 case 'more-radar':ui.radarLimit+=24;break;
 case 'more-analysis':if(extendAnalysisList())return;ui.analysisLimit+=28;break;
 case 'feature-tag':{
   const tag=button.dataset.value;
   if(tag==='all'){ui.featureTags=[];ui.featureGroups=[];ui.featureExcludedTags=[];}
   else if(tagCounts().some(([name])=>name===tag)){
     if(ui.featureGroups.includes(tagFamily(tag))){
       // Inside a selected family, clicking a tag removes only that subtag.
       ui.featureTags=ui.featureTags.filter(x=>x!==tag);
       ui.featureExcludedTags=ui.featureExcludedTags.includes(tag)?ui.featureExcludedTags.filter(x=>x!==tag):[...ui.featureExcludedTags,tag];
     }else ui.featureTags=ui.featureTags.includes(tag)?ui.featureTags.filter(x=>x!==tag):[...ui.featureTags,tag];
   }
   ui.featureRelatedTag='';ui.featureRelatedExpanded=false;ui.featureLimit=60;
   break;
 }
 case 'toggle-feature-family':{
   const group=button.dataset.value;
   if(!groupedTags(tagCounts()).some(([family])=>family===group))return;
   const isSelected=ui.featureGroups.includes(group);
   if(isSelected){ui.featureGroups=ui.featureGroups.filter(f=>f!==group);ui.featureExcludedTags=ui.featureExcludedTags.filter(t=>tagFamily(t)!==group);}
   else{ui.featureGroups.push(group);ui.featureTags=ui.featureTags.filter(t=>tagFamily(t)!==group);ui.featureExcludedTags=ui.featureExcludedTags.filter(t=>tagFamily(t)!==group);}
   ui.featureRelatedTag='';ui.featureRelatedExpanded=false;ui.featureLimit=60;
   break;
 }
 case 'toggle-feature-families':ui.featureFamiliesOpen=!ui.featureFamiliesOpen;break;
 case 'toggle-feature-insights':ui.featureInsightsOpen=!ui.featureInsightsOpen;break;
 case 'more-features':ui.featureLimit+=60;break;
 case 'feature-export-add':{
   const base=featureRows(),related=ui.featureRelatedTag;
   const visible=related?base.filter(i=>i.tags.includes(related)):base;
   const keys=manualExportKeys(),free=EXPORT_MAX-keys.length;
   const additions=visible.map(i=>i.app_key).filter(k=>!keys.includes(k)).slice(0,free);
   if(!additions.length){flash(keys.length>=EXPORT_MAX?`최대 ${EXPORT_MAX}개가 이미 담겼습니다.`:'현재 후보가 이미 모두 담겨 있습니다.');return;}
   ui.exportKeys=[...keys,...additions];ui.exportManualInitialized=true;ui.exportMode='manual';saveExportKeys();
   flash(`${additions.length}개 추가했습니다. 내보내기 총 ${ui.exportKeys.length}개 (후보 ${visible.length}개 중).`);
   break;
 }
 case 'feature-related':{
   const tag=button.dataset.value;
   if(featureRelatedCounts(featureRows(),activeFeatureTags()).some(([name])=>name===tag))
     ui.featureRelatedTag=ui.featureRelatedTag===tag?'':tag;
   break;
 }
 case 'clear-feature-related':ui.featureRelatedTag='';break;
 case 'toggle-feature-related-more':ui.featureRelatedExpanded=!ui.featureRelatedExpanded;break;
 case 'toggle-feature-group':{const group=button.dataset.value;ui.featureOpenGroups=ui.featureOpenGroups.includes(group)?ui.featureOpenGroups.filter(g=>g!==group):[...ui.featureOpenGroups,group];break;}
 case 'toggle-feature-group-more':{const group=button.dataset.value;ui.featureExpandedGroups=ui.featureExpandedGroups.includes(group)?ui.featureExpandedGroups.filter(g=>g!==group):[...ui.featureExpandedGroups,group];break;}
 case 'clear-feature-tags':ui.featureTags=[];ui.featureGroups=[];ui.featureExcludedTags=[];ui.featureRelatedTag='';ui.featureRelatedExpanded=false;ui.featureLimit=60;break;
 case 'compare-mode':ui.comparisonMode=button.dataset.value;break;
 case 'export-period':ui.exportPeriod=Number(button.dataset.value);break;
 case 'export-mode':ui.exportMode=button.dataset.value==='recommended'?'recommended':'manual';break;
 case 'toggle-export-browser':ui.exportBrowseOpen=!ui.exportBrowseOpen;ui.exportBrowseLimit=24;break;
 case 'close-export-browser':ui.exportBrowseOpen=false;break;
 case 'more-export-browse':ui.exportBrowseLimit+=24;break;
 case 'add-visible-export':{
   const keys=manualExportKeys(),added=browseRows().slice(0,ui.exportBrowseLimit).filter(i=>!keys.includes(i.app_key)).slice(0,EXPORT_MAX-keys.length).map(i=>i.app_key);
   if(added.length){ui.exportKeys=[...keys,...added];ui.exportManualInitialized=true;saveExportKeys();flash(`${added.length}개 후보를 선택했습니다.`);}
   break;
 }
 case 'toggle-export':{
   const key=canonicalKey(button.dataset.key);if(!index.map.has(key))return;
   const keys=manualExportKeys(),selected=keys.includes(key);
   if(!selected&&keys.length>=EXPORT_MAX){flash(`내보내기 후보는 최대 ${EXPORT_MAX}개입니다.`);return;}
   ui.exportKeys=selected?keys.filter(x=>x!==key):[...keys,key];
   ui.exportManualInitialized=true;ui.exportMode='manual';saveExportKeys();
   flash(selected?'내보내기 목록에서 제외했습니다.':`내보내기 목록에 추가했습니다. (현재 ${ui.exportKeys.length}개)`);
   if(syncAnalysisExportUI())return;
   break;
 }
 case 'add-export':{
   const key=canonicalKey(button.dataset.key);if(!index.map.has(key))return;
   const keys=manualExportKeys();if(keys.includes(key))return;
   if(keys.length>=EXPORT_MAX){flash(`내보내기 후보는 최대 ${EXPORT_MAX}개입니다.`);return;}
   ui.exportKeys=[...keys,key];ui.exportManualInitialized=true;saveExportKeys();break;
 }
 case 'remove-export':ui.exportKeys=manualExportKeys().filter(k=>k!==canonicalKey(button.dataset.key));ui.exportManualInitialized=true;saveExportKeys();if(syncAnalysisExportUI())return;break;
 case 'clear-export-manual':ui.exportKeys=[];ui.exportManualInitialized=true;ui.exportMode='manual';saveExportKeys();flash('내보내기 목록을 모두 비웠습니다.');if(syncAnalysisExportUI())return;break;
 case 'toggle-compare':{
   const key=canonicalKey(button.dataset.key);if(!index.map.has(key)){flash('현재 연구실에 없는 후보라 비교할 수 없습니다. 저장된 관심 기록은 유지됩니다.');return;}
   if(chosen.includes(key))chosen=chosen.filter(k=>k!==key);
   else if(chosen.length>=3){flash('후보 비교는 최대 3개까지 가능합니다.');return;}
   else chosen.push(key);
   saveChosen();flash(`${chosen.length}개 후보 선택됨`);break;
 }
 case 'remove-compare':chosen=chosen.filter(k=>k!==canonicalKey(button.dataset.key));saveChosen();break;
 case 'clear-compare':chosen=[];ui.comparisonMode='all';saveChosen();flash('비교 후보를 모두 초기화했습니다.');break;
 case 'favorite':{
   // Reuse the existing local-only favorites storage, never export its private notes.
   const {toggleFavorite}=await import('./favorites.js');
   const i=index.map.get(button.dataset.key);if(i){const existing=(i.alias_keys||[i.app_key]).find(hasFavorite);
     flash(toggleFavorite(existing?{...i,app_key:existing}:i)?'관심 목록에 추가했습니다.':'관심 목록에서 제외했습니다.');}
   break;
 }
 case 'download-json':case 'download-csv':{
   button.disabled=true;try{const payload=await buildExport(),file=`idea_lab_${ui.exportMode}_${ui.exportPreset}_${ui.exportPeriod}d_${index.data_date}`;
     if(action==='download-json')download(file+'.json',JSON.stringify(payload,null,2),'application/json;charset=utf-8');
     else download(file+'.csv',csvExport(payload),'text/csv;charset=utf-8');flash('자료 파일을 생성했습니다.');
   }catch(e){flash(`내보내기 실패: ${e.message}`);}finally{button.disabled=false;}return;
 }
 case 'copy-prompt':{
   const text=promptText(getExportKeys());try{await navigator.clipboard.writeText(text);flash('ChatGPT 질문을 복사했습니다.');}
   catch{document.getElementById('lab-prompt')?.focus();document.getElementById('lab-prompt')?.select();flash('질문을 선택했습니다. 직접 복사해 주세요.');}return;
 }
 default:return;
 }
 const scrollY=typeof window!=='undefined'?(window.scrollY ?? document?.documentElement?.scrollTop ?? 0):0;
 refreshPage();
 if(typeof window!=='undefined'&&window.scrollTo)window.scrollTo(0,scrollY);
}
export function labChange(target){
 if(target.matches('[data-lab-filter]')){
  const key=target.dataset.labFilter;if(key==='searchScope'){setSearchScope(target.value);ui.radarLimit=24;ui.featureLimit=60;ui.analysisLimit=28;ui.exportBrowseLimit=24;refreshPage();return true;}ui[key]=['period','exportCount'].includes(key)?Number(target.value):target.value;
  const recPos=EXPORT_REC_FIELDS.indexOf(key),browsePos=EXPORT_BROWSE_FIELDS.indexOf(key);
  if(recPos!==-1){for(const subsequent of EXPORT_REC_FIELDS.slice(recPos+1))ui[subsequent]='all';}
  if(browsePos!==-1){for(const subsequent of EXPORT_BROWSE_FIELDS.slice(browsePos+1))ui[subsequent]='all';ui.exportQuery='';ui.exportBrowseLimit=24;}
  if(['country','source','kind','price'].includes(key) && ui.category!=='all' && !radarCategoryChoices().has(ui.category))ui.category='all';
  if(['signal','country','source','kind','category','price','ai','release','period','sort'].includes(key))ui.radarLimit=24;
  if(key.startsWith('analysis'))ui.analysisLimit=28;
  if(key==='featureQuery')ui.featureLimit=60;if(key==='radarQuery')ui.radarLimit=24;
  refreshPage();return true;
 }
 if(target.matches('[data-lab-preset]')){ui.exportPreset=target.value;refreshPage();return true;}

 return false;
}
let searchTimer;
export function labInput(target){
 if(!target.matches('[data-lab-search]'))return false;
 const key=target.dataset.labSearch;ui[key]=target.value;if(key==='exportQuery')ui.exportBrowseLimit=24;if(key==='featureQuery')ui.featureLimit=60;if(key==='radarQuery')ui.radarLimit=24;if(key==='analysisQuery')ui.analysisLimit=28;
 clearTimeout(searchTimer);const pos=target.selectionStart;
 searchTimer=setTimeout(()=>{
  if(!location.hash.startsWith('#/lab/'))return;
  refreshPage();const el=document.querySelector(`[data-lab-search="${key}"]`);
  if(el){el.focus();try{el.setSelectionRange(pos,pos);}catch{}}
 },220);
 return true;
}
export function renderLab(tab='radar',query=new URLSearchParams()){
 if(!index){if(!loadError&&!loadPromise)loadLab().then(()=>{if(location.hash.startsWith('#/lab'))refreshPage();}).catch(()=>{if(location.hash.startsWith('#/lab'))refreshPage();});
  if(loadError)return `<div class="panel">${empty('연구실 자료를 불러오지 못했습니다.',loadError.message+' · 수집·웹 빌드 이후 다시 확인해 주세요.')}<div class="lab-more"><button class="button ghost" data-lab-action="retry">다시 시도</button></div></div>`;
  return '<div class="center-loading"><span class="loading-spinner"></span><p>아이디어 연구실 자료를 불러오는 중입니다.</p></div>';
 }
 // A tag deep-link (e.g. from the radar) sets an initial selection only once per entry.
 // Re-rendering the same hash must never undo a user's tag toggle.
 if(tab==='features'){
   const featureRoute=location.hash||'#/lab/features';
   if(featureRoute!==lastFeatureRoute){
     const linkedTag=query.get('tag');
     if(linkedTag&&tagCounts().some(([tag])=>tag===linkedTag)){ui.featureTags=[linkedTag];ui.featureRelatedTag='';}
   }
   lastFeatureRoute=featureRoute;
 }else lastFeatureRoute='';
 if(!TABS.some(x=>x[0]===tab))tab='radar';
 if(searchScope()==='full'&&({radar:ui.radarQuery,features:ui.featureQuery,analysis:ui.analysisQuery,export:ui.exportBrowseOpen?ui.exportQuery:'',development:developmentQuery()}[tab]||'').trim())
   ensureDeepSearch(index.items,()=>{if(typeof location!=='undefined'&&location.hash.startsWith('#/lab/'))refreshPage();});
 const total=index.items.filter(i=>i.observations?.length).length;
 const active=index.items.filter(i=>i.observations?.some(o=>!o.historical)).length;
 const updatedGroups=(store.groups||[]).filter(g=>g.is_stale).length;
 const body={radar,features,analysis:()=>analysis(query),compare,export:exportView,development:()=>renderDevelopment(index.items)}[tab]();
 return `<section class="lab-hero"><div><p class="eyebrow">IDEA LAB / RESEARCH WORKSPACE</p><h1>아이디어 연구실</h1><p>수집한 시장 기록과 개발 분석을 연결해, 다음에 만들 앱·게임 후보를 찾아보세요.</p><div class="lab-hero-status">${badge(`수집 자료 ${formatDate(index.data_date)}`,'blue')}${updatedGroups?badge(`이전 데이터 ${updatedGroups}개 그룹`,'warn'):badge('최신 수집 자료','green')}</div></div><div class="lab-hero-stats"><div><strong>${total.toLocaleString('ko-KR')}</strong><span>전체 관측 후보</span><small class="lab-hero-secondary">최근 수집 목록 ${active.toLocaleString('ko-KR')}개</small></div><div><strong>${index.ai_count.toLocaleString('ko-KR')}</strong><span>AI 분석 누적</span></div><div><strong>${chosen.length} / 3</strong><span>비교 후보</span></div></div></section>
 <nav class="lab-tabs" aria-label="아이디어 연구실 소메뉴">${TABS.map(([key,name])=>`<a href="#/lab/${key}" ${key===tab?'aria-current="page"':''} class="${key===tab?'active':''}">${esc(name)}${key==='compare'&&chosen.length?` <em>${chosen.length}</em>`:''}</a>`).join('')}</nav>
 <section class="lab-content">${body}</section>`;
}
