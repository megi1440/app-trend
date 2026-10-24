// One presentation rule for both the 3.1 research view and the 3.5 design view.
// Only previously collected Gemini tags/evidence are displayed; nothing is inferred.
import {esc,attr} from './data.js';
export function featureTone(name){
 let hash=2166136261;
 for(const ch of String(name))for(const byte of new TextEncoder().encode(ch))hash=Math.imul(hash^byte,16777619);
 hash>>>=0;
 const hue=hash%360,sat=43+(hash>>>9)%23,light=92+(hash>>>18)%4;
 const borderSat=41+(hash>>>12)%19,deepSat=51+(hash>>>5)%19;
 return `--lab-tone-bg:hsl(${hue} ${sat}% ${light}%);--lab-tone-border:hsl(${hue} ${borderSat}% 74%);--lab-tone-ink:hsl(${hue} ${deepSat}% 26%);--lab-tone-strong:hsl(${hue} ${deepSat}% 33%)`;
}
export function evidenceTitle(tag,item){
 const proof=item?.tag_evidence?.[tag]?.[0];
 return proof?.text?` title="${attr(`Gemini ${proof.field==='systems_ko'?'구현 시스템 제안':'핵심 기능'}: ${proof.text}`)}"`:'';
}
export function featureBadge(tag,item){
 const title=evidenceTitle(tag,item);
 return `<span class="lab-feature-badge" style="${featureTone(tag)}"${title}>${esc(tag)}</span>`;
}
export function featureStrip(item){
 const tags=item?.tags||[],entries=Object.entries(item?.tag_evidence||{});
 return `<div class="lab-ai-feature-strip"><strong>기능 태그 <small>Gemini 분석 기반 · 태그에 마우스를 올리면 추출 근거 표시</small></strong><div class="lab-tag-row">${tags.length?tags.map(tag=>featureBadge(tag,item)).join(''):'<span class="small-copy">추출된 기능 태그가 없습니다.</span>'}</div>${entries.length?`<details class="lab-tag-evidence"><summary>태그의 근거 문장 보기 (${entries.length}개)</summary><ul>${entries.map(([tag,proof])=>`<li><strong>${esc(tag)}</strong><span>${proof.map(e=>`${e.field==='systems_ko'?'구현 시스템 제안':'핵심 기능'}: ${esc(e.text)}`).join(' / ')}</span></li>`).join('')}</ul></details>`:''}</div>`;
}
