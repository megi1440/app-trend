import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const search=await import(pathToFileURL(path.join(root,'web/js/lab_search.js')).href);
const sample=[
 {app_key:'apple:7',alias_keys:['apple:7','google:7'],name:'정원 일기',developer:'Blue Meadow',category:'lifestyle',kind:'app',tags:['캘린더'],summary:'날씨와 정원 관리',has_ai:true,ai_shard:'03'},
 {app_key:'itch:9',name:'비밀 정원',developer:'Tiny Studio',category:'game_puzzle',kind:'game',tags:['퍼즐'],summary:'정원 속 퍼즐',has_ai:false},
 {app_key:'apple:8',name:'일정 기록',developer:'Note Studio',category:'productivity',kind:'app',tags:['백업'],summary:'메모 정리',has_ai:false}
];
const responses={
 './data/ai/items/03.json':{schema_version:1,items:{'google:7':{app_key:'google:7',analysis:{features_ko:['클라우드 동기화'],solo_mvp_ko:{must_have:['오프라인 동기화 대기열']}}}}},
 './data/development/index.json':{schema_version:1,items:[{app_key:'google:7',shard:'1'}]},
 './data/development/items/1.json':{schema_version:1,items:{'google:7':{app_key:'google:7',brief:{mvp_features_ko:['스티커 합성']},plan:{architecture_ko:['이벤트 기반 렌더링']}}}}
};
const calls=[];
globalThis.fetch=async url=>{calls.push(String(url));const data=responses[String(url)];return data?{ok:true,json:async()=>data}:{ok:false,status:404};};
assert.deepEqual(search.searchResults(sample,'정원').map(x=>x.app_key),['apple:7','itch:9'],'name hits are first');
assert.deepEqual(search.searchResults(sample,'blue meadow').map(x=>x.app_key),['apple:7'],'developer hit');
assert.deepEqual(search.searchResults(sample,'캘린더').map(x=>x.app_key),['apple:7'],'tag hit');
assert.deepEqual(search.searchResults(sample,'날씨').map(x=>x.app_key),['apple:7'],'summary hit');
assert.equal(search.searchMatch(sample[0],'클라우드'),null,'deep fields must not leak into basic mode');
assert.equal(calls.length,0,'no AI fetches before full search');
search.setSearchScope('full');
await search.ensureDeepSearch(sample);
assert.equal(search.deepSearchState().state,'ready','both analysis sources loaded');
assert.deepEqual(search.searchResults(sample,'클라우드').map(x=>x.app_key),['apple:7'],'cross-store analysis linked by alias');
assert.equal(search.searchMatch(sample[0],'클라우드').label,'3.1 상세 분석');
assert.equal(search.searchMatch(sample[0],'스티커').label,'3.5 개발 검토');
assert.equal(search.searchMatch(sample[0],'이벤트 기반').label,'3.5 상세 설계');
const count=calls.length;
await search.ensureDeepSearch(sample);
assert.equal(calls.length,count,'already fetched full text must be reused');
search.setSearchScope('basic');
assert.equal(search.searchMatch(sample[0],'클라우드'),null,'basic mode stays limited even after full fetch');
// Existing public 3.1 index, including Apple/Google duplicate cards, stays untouched.
const raw=JSON.parse(await readFile(path.join(root,'data/lab/index.json'),'utf8'));
const allKeys=new Set(raw.items.map(x=>x.app_key));
assert.equal(allKeys.size,raw.items.length);
const lab=await import(pathToFileURL(path.join(root,'web/js/lab.js')).href);
const merged=lab.mergeStoreDuplicates(raw.items);
assert.equal(merged.length,2448);
assert.equal(new Set(merged.map(x=>x.app_key)).size,merged.length);
const target=merged.find(x=>x.app_key==='apple:6821576483');
assert(target?.store_variants?.length===2,'both stores remain on one card');
assert.equal(search.searchResults(merged,'80億分の1').filter(x=>x.app_key===target.app_key).length,1);
console.log('[lab content search] basic/deep toggle, 3.1/3.5 content, source alias, lazy fetch, 2448 unique cards OK');
