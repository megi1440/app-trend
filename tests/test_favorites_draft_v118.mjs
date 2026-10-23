// V1.18: a slow Lab membership request must not overwrite a user's unsaved note.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const memory=new Map();
globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
globalThis.sessionStorage=localStorage;
let resolveLab;
const waitLab=new Promise(resolve=>{resolveLab=resolve;});
globalThis.fetch=async url=>{
  if(String(url).endsWith('/data/lab/index.json'))await waitLab;
  try{return {ok:true,status:200,json:async()=>JSON.parse(await fs.readFile(path.join(root,String(url).replace(/^\.\//,'')),'utf8'))};}
  catch{return {ok:false,status:404,json:async()=>({})};}
};
const {store,loadSnapshot,detailsHref}=await import(pathToFileURL(path.join(root,'web/js/data.js')).href);
await loadSnapshot();
const known=[...store.appMap.values()].find(x=>x.app_key&&x.name);
assert.ok(known);
localStorage.setItem('app-trend:favorites:v1',JSON.stringify([{
  app_key:known.app_key,name:known.name,source:known.app_key.split(':')[0],status:'관심',note:'저장돼 있는 문장',added_at:'2026-10-21'
}]));
const klass={add(){},remove(){},toggle(){},contains(){return true;}};
const el=()=>({innerHTML:'',textContent:'',value:'',classList:klass,addEventListener(){},setAttribute(){},focus(){},style:{}});
let currentNote=null,currentStatus=null;
const main=el();let markup='';
Object.defineProperty(main,'innerHTML',{get:()=>markup,set(value){
  markup=value;
  // Simulate the DOM recreating note fields on innerHTML assignment.
  if(value.includes('id="idea-note"')){
    currentNote={id:'idea-note',value:'저장돼 있는 문장',selectionStart:0,selectionEnd:0,focus(){globalThis.document.activeElement=this},setSelectionRange(){}};
    currentStatus={id:'idea-status',value:'관심',focus(){}};
  }
}});
const elements={main,overlay:el(),'global-search':el(),toast:el(),'footer-date':el(),'status-label':el()};
const events={};
globalThis.location={hash:detailsHref(known.app_key,{from:'favorites'})};
globalThis.window={location,scrollY:470,addEventListener(){},dispatchEvent(){},scrollTo(x,y){this.scrollY=typeof x==='object'?x.top:y}};
globalThis.document={getElementById:id=>id==='idea-note'?currentNote:id==='idea-status'?currentStatus:elements[id]||null,
  querySelector:()=>({classList:klass}),querySelectorAll:()=>[],addEventListener:(key,fn)=>{events[key]=fn;},activeElement:null};
await import(pathToFileURL(path.join(root,'web/js/app.js')).href);
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,7));}throw Error('render timeout')};
await until(()=>Boolean(currentNote));
currentNote.value='아직 저장하지 않은 연구 아이디어, 지우지 마세요!';
currentStatus.value='개발 후보';
currentNote.focus();
resolveLab();
await until(()=>main.innerHTML.includes('연구실에서 보기'));
assert.equal(currentNote.value,'아직 저장하지 않은 연구 아이디어, 지우지 마세요!');
assert.equal(currentStatus.value,'개발 후보');
assert.equal(window.scrollY,470);
assert.equal(globalThis.document.activeElement,currentNote);
assert.ok(localStorage.getItem('app-trend:favorites:v1').includes('저장돼 있는 문장'),'unsaved draft is not silently written either');
console.log('[V1.18] asynchronous Lab check preserves unsaved note, draft status, focused textarea and scroll');
