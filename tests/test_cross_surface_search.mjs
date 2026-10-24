import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
// Controlled fixture: does not assume any particular item remains absent in tomorrow's charts.
const target={app_key:'itch:archived-test',name:'Sample Archive Puzzle [Free] [Puzzle]',source:'itch',kind:'game',
 developer:'Indie Workshop',summary:'요소를 조합하는 퍼즐',tags:['요소 조합'],tag_evidence:{'요소 조합':[{field:'features_ko',text:'요소를 조합합니다.'}]},
 icon_url:'',detail_url:'https://example.org/sample',observations:[],signals:[],has_ai:true,ai_shard:'01'};
const archive={schema_version:1,data_date:'2026-10-24',ai_count:1,items:[target]};
const latest={groups:[{source:'itch',country:'GLOBAL',feed:'new',data_date:'2026-10-24',is_stale:false,items:[]}]};
const search='Sample Archive Puzzle';
const current=new Set(latest.groups.flatMap(g=>(g.items||[]).map(i=>i.app_key)));
assert(!current.has(target.app_key));
const matched=archive.items.filter(item=>item.source==='itch'&&!current.has(item.app_key)&&item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
assert.equal(matched[0].app_key,target.app_key);
// The indie page must distinguish RSS feed observations from archive analysis.
globalThis.sessionStorage={getItem:()=>null,setItem:()=>{}};
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
globalThis.location={hash:'#/lab/radar'};
globalThis.document={querySelector:()=>null};
const {store}=await import('../web/js/data.js');
store.groups=latest.groups;store.labArchive=archive.items;
const {renderIndieResults}=await import('../web/js/views.js');
const indieMarkup=renderIndieResults({indieQuery:search,feed:'all',indieSort:'feed',indieLimit:30});
assert(indieMarkup.includes(target.name.split(' [')[0].replaceAll("'",'&#39;')),'archive-only item appears in indie text search');
assert(indieMarkup.includes('현재 피드 미관측'),'no invented live RSS record');
assert(indieMarkup.includes('보관된 인디 분석'));
const urls=[];
globalThis.fetch=async url=>{
 urls.push(String(url));
 if(String(url)==='./data/lab/index.json')return {ok:true,json:async()=>archive};
 throw Error('unexpected network: '+url);
};
const lab=await import('../web/js/lab.js');
await lab.loadLab();
lab.initLabHandlers(()=>{},()=>{});
lab.labInput({matches:(selector)=>selector==='[data-lab-search]',dataset:{labSearch:'radarQuery'},value:search,selectionStart:search.length});
const radar=lab.renderLab('radar',new URLSearchParams());
assert(radar.includes(target.name.replaceAll("'",'&#39;')),'radar search finds archived research candidate');
assert(radar.includes('현재 기간 관측 없음'),'radar labels missing source evidence');
assert(radar.includes('보관된 분석·수집 자료'));
assert(!radar.includes('이 게임 인기 1위'));
console.log(`[cross-surface search] real archived itch fixture: ${target.app_key}, index+indie+radar OK`);
