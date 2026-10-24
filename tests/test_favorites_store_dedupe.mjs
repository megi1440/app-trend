// Regression: legacy dual-store favorites are merged without losing notes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const saved=new Map();
globalThis.localStorage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
globalThis.sessionStorage=localStorage;
globalThis.window={dispatchEvent(){}};
globalThis.location={hash:'#/lab/radar'};
globalThis.document={getElementById:()=>null,querySelectorAll:()=>[]};
globalThis.fetch=async url=>{
  try{return {ok:true,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>null};}
};
const fav=await import(pathToFileURL(path.join(root,'web/js/favorites.js')).href);
const {store,loadSnapshot}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
const {loadLab}=await import(pathToFileURL(path.join(root,'web/js/lab.js')).href);
const {renderFavorites,renderDetail}=await import(pathToFileURL(path.join(root,'web/js/views.js')).href);
await loadSnapshot();
const apple='apple:6821576483',google='google:games.hayo.whilewelive';
const oldRows=[
  {app_key:google,source:'google',name:'80億分の1 - 人生シミュレーター',developer:'HAYO',note:'안드로이드 아이디어 메모',status:'개발 후보',added_at:'2026-10-24',detail_url:'https://play.google.com/store/apps/details?id=games.hayo.whilewelive'},
  {app_key:apple,source:'apple',name:'80億分の1 - 人生シミュレーター',developer:'HAYO (Apps)',note:'iOS 아이디어 메모',status:'관심',added_at:'2026-10-22',detail_url:'https://apps.apple.com/jp/app/id6821576483'},
  {app_key:'itch:saved-independent',source:'itch',name:'예전 게임',note:'절대 잃으면 안 되는 메모',added_at:'2026-10-21'}
];
localStorage.setItem('app-trend:favorites:v1',JSON.stringify(oldRows));
assert.equal(fav.getFavorites().length,2,'two-store saved records should show as one even before index loads');
const idx=await loadLab();
assert.equal(idx.map.get(google).app_key,apple);
assert.equal(fav.getFavorites().length,2,'old and newly discovered favorites remain one');
assert.equal(JSON.parse(localStorage.getItem('app-trend:favorites:v1')).length,2,'stored duplicates migrated');
assert(fav.hasFavorite(apple)&&fav.hasFavorite(google),'both store keys resolve to saved one');
const merged=fav.getFavorite(google);
assert.equal(merged.app_key,apple);
assert(merged.note.includes('안드로이드 아이디어 메모'));
assert(merged.note.includes('iOS 아이디어 메모'));
assert.equal(merged.added_at,'2026-10-22','keep earliest save date');
assert.equal(merged.status,'개발 후보','a non-default review status survives');
assert.equal(fav.getFavorite('itch:saved-independent').note,'절대 잃으면 안 되는 메모');
const html=renderFavorites({favoriteStatus:'all',favoriteLimit:30,labAvailability:{status:'ready',keys:new Set(idx.map.keys())}});
assert.equal((html.match(/class="fav-list-row"/g)||[]).length,2);
assert.match(html,/lab-store-apple/);
assert.match(html,/lab-store-google/);
assert.match(renderDetail(google,{detailContext:{},range:30,labAvailability:{status:'ready',keys:new Set(idx.map.keys())}}),/iOS 아이디어 메모/);
assert.equal(fav.updateFavorite(google,{note:'업데이트된 메모',status:'살펴보는 중'}),true);
assert.equal(fav.getFavorite(apple).note,'업데이트된 메모');
assert.equal(fav.toggleFavorite({app_key:google}),false,'either star removes the same saved candidate');
assert.equal(fav.getFavorites().length,1);
assert.equal(fav.toggleFavorite({app_key:apple,name:'80億分の1 - 人生シミュレーター',developer:'HAYO (Apps)'}),true);
assert.equal(fav.getFavorites().length,2);
assert(fav.hasFavorite(google),'adding Apple also marks Google saved');
// An old JSON backup containing both source IDs must retain both notes regardless of ordering.
for(const records of [[oldRows[0],oldRows[1]],[oldRows[1],oldRows[0]]]){
  const value=JSON.stringify({version:1,favorites:records});
  const count=await fav.importFavorites({size:value.length,text:async()=>value});
  assert.equal(count,2,'the independent itch favorite survives the import');
  assert(fav.getFavorite(apple).note.includes('안드로이드 아이디어 메모'));
  assert(fav.getFavorite(apple).note.includes('iOS 아이디어 메모'));
  assert.equal(JSON.parse(localStorage.getItem('app-trend:favorites:v1')).length,2);
}
// Save just Google as a legacy record; loading known identity must make Apple saved too.
localStorage.setItem('app-trend:favorites:v1',JSON.stringify([oldRows[0]]));
fav.setFavoriteAliases(idx.aliases);
assert.equal(fav.getFavorite(apple)?.app_key,apple);
assert.equal(fav.getFavorites().length,1);
assert.equal(fav.toggleFavorite({app_key:apple}),false,'Apple star removes a Google-only legacy save');
assert.equal(fav.getFavorites().length,0);
console.log('[favorites store dedupe] both source IDs, old notes, backup, status and buttons OK');
