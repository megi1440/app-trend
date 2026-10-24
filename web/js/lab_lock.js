// Minimal front-end entry gate. Public GitHub Pages JSON/JS remains accessible.
// Only the digest is shipped; there is no plaintext password in the source.
const STORAGE_KEY = 'app-trend:lab-unlocked:v1';
const SALT = 'app-trend:lab-lock:v1:';
const EXPECTED = '11ab991be5d2aed7b47d3399123c622e14cd696b3ee55e7aa9e5ce4d52f1530f';
let opened = false;
try { opened = sessionStorage.getItem(STORAGE_KEY) === 'yes'; } catch {}
export const labIsUnlocked = () => opened;
export function renderLabGate() {
  return `<section class="lab-lock panel" aria-labelledby="lab-lock-heading">
    <span class="lab-lock-symbol" aria-hidden="true">🔒</span>
    <p class="eyebrow">IDEA LAB</p><h1 id="lab-lock-heading">아이디어 연구실</h1>
    <p>연구실을 보려면 비밀번호를 입력하세요. 이 브라우저 탭에서는 한 번만 입력하면 됩니다.</p>
    <form id="lab-lock-form" autocomplete="off">
      <label for="lab-lock-password">비밀번호</label>
      <input id="lab-lock-password" type="password" required autocomplete="current-password" spellcheck="false" placeholder="비밀번호 입력">
      <button class="button" type="submit">연구실 열기</button>
      <p class="lab-lock-error" id="lab-lock-error" role="alert" aria-live="polite"></p>
    </form>
    <p class="small-copy">개인용 접근 방지 화면입니다. 공개 데이터 URL을 보호하는 보안 기능은 아닙니다.</p>
  </section>`;
}
export async function unlockLab(password) {
  const encoder = new TextEncoder();
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(SALT + password));
  const digest = Array.from(new Uint8Array(raw), byte=>byte.toString(16).padStart(2,'0')).join('');
  if(digest !== EXPECTED) return false;
  opened = true;
  try{sessionStorage.setItem(STORAGE_KEY,'yes');}catch{}
  return true;
}
