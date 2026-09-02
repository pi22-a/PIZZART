/**
 * 스토어 스크린샷을 파일로 뽑는다.
 *
 *   node scripts/shoot.mjs            (게임 서버가 8080에 떠 있어야 한다)
 *
 * 헤드리스 크롬을 띄우고 CDP(크롬 디버깅 프로토콜)로 직접 몬다. 브라우저를 눈으로
 * 보면서 찍으면 화면은 확인되지만 **파일이 안 남는다** — 스토어에 올릴 것은 파일이다.
 *
 * 들러리 봇(shot-bots.mjs)이 따로 돌고 있어야 판이 시작된다. 넷이 모여야 하는 게임이라
 * 혼자서는 로비 밖으로 못 나간다.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = process.env.PORT ?? '8080';
const ROOM = process.env.ROOM ?? 'SHOT';
const OUT = process.env.OUT ?? '../PIZZART-release/store/screenshots';
// 폭 430은 실측으로 정했다. 405에서는 도구 줄이 여러 겹으로 접혀 원판이 화면 밖으로 밀린다.
const [W, H] = [430, 765];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--no-first-run',
  `--window-size=${W},${H}`, '--force-device-scale-factor=2',
  '--hide-scrollbars', '--disable-extensions', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
process.on('exit', () => chrome.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { chrome.kill(); process.exit(0); });

/** 크롬이 디버깅 포트를 열 때까지 기다린다 */
async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json/list').then((x) => x.json());
      const page = r.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 아직 안 떴다 */ }
    await wait(250);
  }
  throw new Error('크롬 디버깅 포트가 안 열립니다');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function cdp(method, params = {}) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((res, rej) => pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))));
}

await cdp('Page.enable');
await cdp('Runtime.enable');
// 실제 폰 크기로 고정한다. 창 크기만으로는 devicePixelRatio가 안 잡힌다.
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

const js = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '스크립트 오류');
  return r.result.value;
};

async function shot(name) {
  await wait(500);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  ✓ ${name}`);
}

const screen = () => js(`[...document.querySelectorAll('.screen.on')].map(s=>s.id)[0]`);

await cdp('Page.navigate', { url: `http://localhost:${PORT}/?room=${ROOM}` });
await wait(2500);

// 이름을 넣고 들어간다
await js(`(()=>{const i=document.getElementById('enterName');i.value='하은';
  i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('enterBtn').click();return 1})()`);
await wait(2500);

// 로비 — 컬러판으로 바꾸고 게임 방법은 접는다
await js(`(()=>{document.getElementById('colorModeBtn')?.click();
  const d=document.getElementById('rules'); if(d) d.open=false; return 1})()`);
await wait(1200);
await shot('6-lobby.png');

await js(`document.getElementById('startBtn').click()`);
await wait(3000);
console.log('  단계:', await screen());

/** 원판에 그린다. 합성 포인터 이벤트로 실제 캔버스 입력을 흉내낸다. */
const DRAW = `(async () => {
  const cv = document.getElementById('drawCanvas');
  cv.setPointerCapture = () => {};
  const r = cv.getBoundingClientRect();
  const ev = (t,nx,ny,b=1) => cv.dispatchEvent(new PointerEvent(t,{
    clientX:r.left+r.width*nx, clientY:r.top+r.height*ny, buttons:b, pointerId:1, bubbles:true }));
  const pick = h => document.querySelector('#drawColors button[data-color="'+h+'"]')?.click();
  const line = pts => { ev('pointerdown',...pts[0]);
    for (let i=1;i<pts.length;i++){ const[ax,ay]=pts[i-1],[bx,by]=pts[i];
      for(let k=1;k<=6;k++) ev('pointermove',ax+(bx-ax)*k/6, ay+(by-ay)*k/6); }
    ev('pointerup',...pts.at(-1)); };
  const w = ms => new Promise(r=>setTimeout(r,ms));
  // 집 한 채 — 무슨 제시어든 그림은 그림이고, 조각으로 잘렸을 때 알아보기 좋다
  pick('#8a5a2b'); line([[0.24,0.62],[0.50,0.34],[0.76,0.62]]); await w(80);
  pick('#e03131'); line([[0.28,0.62],[0.28,0.84],[0.72,0.84],[0.72,0.62]]); await w(80);
  pick('#1971c2'); line([[0.44,0.84],[0.44,0.70],[0.56,0.70],[0.56,0.84]]); await w(80);
  pick('#eab308'); line([[0.62,0.44],[0.62,0.30],[0.68,0.30],[0.68,0.50]]); await w(80);
  pick('#4dabf7'); line([[0.34,0.70],[0.34,0.76],[0.40,0.76],[0.40,0.70],[0.34,0.70]]);
  await w(300); return 1; })()`;

const iAmDrawer = () => js(`!!document.getElementById('wordTag')?.textContent`);

// ── 1라운드: 내가 출제자면 그리는 화면과 정답 공개를 찍는다 ──
if (await iAmDrawer()) {
  await js(DRAW);
  await js(`window.scrollTo(0,9999)`);
  await shot('2-draw.png');
  await js(`document.getElementById('doneBtn').click()`);
} 

// 결과 화면까지 기다린다 (봇들이 답을 내고 회차가 흘러간다)
for (let i = 0; i < 30 && (await screen()) !== 's-round'; i++) await wait(1500);
if ((await screen()) === 's-round') {
  await js(`window.scrollTo(0,60)`);
  await shot('3-reveal.png');
  await js(`document.getElementById('nextBtn')?.click()`);
}

// ── 2라운드: 봇이 그린다. 나는 맞히는 쪽이라 조각 화면과 조립판을 찍는다 ──
for (let i = 0; i < 30 && (await screen()) !== 's-guess'; i++) await wait(1500);
if ((await screen()) === 's-guess') {
  await js(`window.scrollTo(0,55)`);
  await shot('1-slice.png');
  // 마지막 회차(조립판)까지 넘긴다
  for (let i = 0; i < 8; i++) {
    const last = await js(`document.getElementById('assembledWrap')?.style.display !== 'none'`);
    if (last) break;
    await js(`(()=>{const b=document.getElementById('skipBtn'); if(b&&!b.disabled) b.click(); return 1})()`);
    await wait(2200);
  }
  await js(`window.scrollTo(0,55)`);
  await shot('4-assembled.png');
}

// ── 끝까지 돌려 최종 화면 ──
for (let i = 0; i < 60; i++) {
  const s = await screen();
  if (s === 's-final') break;
  if (s === 's-guess') await js(`(()=>{const b=document.getElementById('skipBtn'); if(b&&!b.disabled)b.click(); return 1})()`);
  else if (s === 's-round') await js(`(()=>{const n=document.getElementById('nextBtn'); if(n&&!n.disabled)n.click(); return 1})()`);
  else if (s === 's-draw') await js(DRAW).then(()=>js(`document.getElementById('doneBtn').click()`)).catch(()=>{});
  await wait(1800);
}
if ((await screen()) === 's-final') {
  await js(`window.scrollTo(0,55)`);
  await shot('5-final.png');
}

console.log('\n  끝났습니다 →', OUT);
ws.close(); chrome.kill(); process.exit(0);
