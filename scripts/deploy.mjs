/**
 * 서버에 배포한다.
 *
 *   npm run deploy            (main을 올린다)
 *   npm run deploy -- --force (사람이 있어도 강행)
 *
 * SSH로 들어가 pull → 빌드 → 재시작까지 하고, 끝나면 실제로 열리는지 확인한다.
 * 손으로 하면 다섯 단계인데 빠뜨리기 쉬워서 한 줄로 묶었다.
 *
 * **재시작하면 돌던 판이 사라진다.** 방 상태가 서버 메모리에만 있어서다. 재시작 자체는
 * 1초쯤이고 클라이언트가 알아서 다시 붙지만, 그 방의 진행은 리셋된다. 그래서 올리기 전에
 * **지금 사람이 있는지 먼저 물어본다** — 이게 이 스크립트의 가장 중요한 일이다.
 */
import { execSync } from 'node:child_process';
import WebSocket from 'ws';

// 서버 주소와 키 경로는 저장소에 두지 않는다. 저장소가 공개라서다.
// ~/.zshrc 등에 PIZZART_HOST=ubuntu@<서버IP>, PIZZART_KEY=<키 경로>를 넣어둔다.
const HOST = process.env.PIZZART_HOST;
const KEY = process.env.PIZZART_KEY;
const SITE = process.env.PIZZART_SITE ?? 'pizzagame.app';
const force = process.argv.includes('--force');

if (!HOST || !KEY) {
  console.error('\n  PIZZART_HOST 와 PIZZART_KEY 를 먼저 설정하세요.\n');
  process.exit(1);
}

const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
            dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const ssh = (cmd) => sh(`ssh -i ${KEY} -o StrictHostKeyChecking=no ${HOST} ${JSON.stringify(cmd)}`);
const die = (msg) => { console.error(c.red(`\n  ✗ ${msg}\n`)); process.exit(1); };

console.log(c.bold('\n  PIZZART 배포\n'));

// ── 1. 로컬이 올릴 만한 상태인가 ──
if (sh('git status --porcelain').split('\n').filter((l) => l && !l.includes('node_modules')).length) {
  die('작업 트리에 커밋 안 한 변경이 있습니다. 커밋하거나 치우고 다시 하세요.');
}
sh('git fetch -q origin');
const local = sh('git rev-parse main');
const remote = sh('git rev-parse origin/main');
if (local !== remote) die('main이 origin/main과 다릅니다. 먼저 푸시하세요.');

let tag = '';
try { tag = sh('git describe --tags --exact-match main'); }
catch {
  // 태그가 없어도 배포는 되지만, 그러면 "지금 뭐가 떠 있나"에 답할 수 없고 롤백 지점도 없다
  console.log(c.red('  ⚠ main에 태그가 없습니다. 되돌릴 지점이 안 남습니다.'));
  if (!force) die('git tag -a vX.Y.Z 로 태그를 찍고 다시 하세요 (--force로 무시 가능).');
}
console.log(`  올릴 것: ${c.green(tag || local.slice(0, 7))}`);

// ── 2. 지금 사람이 있나 ──
const rooms = await new Promise((res) => {
  const ws = new WebSocket(`wss://${SITE}/ws`);
  const t = setTimeout(() => { ws.close(); res(null); }, 8000);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'roomList') { clearTimeout(t); ws.close(); res(m.rooms); }
  });
  ws.on('error', () => { clearTimeout(t); res(null); });
});

if (rooms === null) {
  console.log(c.dim('  방 목록을 못 받았습니다 (서버가 이미 내려가 있을 수 있습니다)'));
} else {
  const busy = rooms.filter((r) => r.count > 0);
  if (busy.length === 0) {
    console.log(c.green('  지금 방에 아무도 없습니다 — 올리기 좋은 때입니다'));
  } else {
    console.log(c.red(`\n  지금 ${busy.length}개 방에 사람이 있습니다:`));
    for (const r of busy) {
      const 상태 = r.phase === 'lobby' ? '대기 중' : `게임 중 (라운드 ${r.round + 1}/${r.totalRounds})`;
      console.log(`    · ${r.name} — ${r.count}명, ${상태}`);
    }
    console.log(c.dim('\n  올리면 이 판들이 리셋됩니다.'));
    if (!force) die('사람이 없을 때 다시 하거나, 정말 지금 해야 하면 --force 를 붙이세요.');
    console.log(c.red('  --force 라서 그대로 진행합니다.\n'));
  }
}

// ── 3. 올린다 ──
console.log(c.dim('\n  서버에서 받아 빌드하는 중…'));
// --force로 받는다. 태그를 옮긴 적이 있으면(옮기지 말아야 하지만) 평범한 fetch는
// "would clobber existing tag"로 거부하고, 그러면 배포가 통째로 멈춘다.
ssh('cd ~/PIZZART && git fetch --tags --force -q && git checkout -q main && git pull -q --ff-only && npm ci --silent && npm run build');
console.log(c.dim('  재시작…'));
ssh('sudo systemctl restart pizzart');

// ── 4. 진짜로 열리는지 ──
await new Promise((r) => setTimeout(r, 2500));
let ok = false;
for (let i = 0; i < 10; i++) {
  try {
    const res = await fetch(`https://${SITE}/`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) { ok = true; break; }
  } catch { /* 아직 */ }
  await new Promise((r) => setTimeout(r, 1500));
}
if (!ok) die('올렸는데 사이트가 안 열립니다. journalctl -u pizzart -n 50 을 보세요.');

const now = ssh('cd ~/PIZZART && git describe --tags');
console.log(c.green(`\n  ✓ https://${SITE} — ${now}\n`));
