/**
 * 가짜 플레이어 하나를 방에 붙인다. 브라우저 창을 여러 개 띄우지 않고
 * 인원 수를 채우거나 다른 사람의 선이 보이는지 확인할 때 쓴다.
 *
 *   node scripts/fake-player.mjs <방코드> [이름] [--draw] [--ready]
 *
 * --draw   구간마다 물결선을 한 번 그린다
 * --ready  구간마다 "완성"을 누른다
 * 살아 있는 동안 방에 남아 있으므로, 끝내려면 Ctrl+C.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const [, , roomArg, nameArg, ...flags] = process.argv;
const room = (roomArg ?? 'TEST').toUpperCase();
const name = nameArg && !nameArg.startsWith('--') ? nameArg : '가짜';
const all = [nameArg, ...flags];
const wantDraw = all.includes('--draw');
const wantReady = all.includes('--ready');

// 기본은 게임 서버에 직접 붙는다. 터널·배포로 붙일 때는 페이지 주소를 넣는다:
//   TAKBON_WS=wss://xxx.trycloudflare.com node scripts/fake-player.mjs ...
const base = (process.env.TAKBON_WS ?? 'ws://localhost:8080').replace(/\/+$/, '');
const ws = new WebSocket(`${base}/ws?room=${encodeURIComponent(room)}`);

ws.on('open', () => {
  console.log(`[${name}] ${room} 방에 접속`);
  ws.send(JSON.stringify({ t: 'join', name, cid: randomUUID() }));
});

/** 조각을 받을 때마다(= 구간이 시작될 때마다) 그리고/또는 완성을 누른다. */
function playSegment(zone) {
  if (wantDraw) {
    const [x0, x1] = zone;
    const points = Array.from({ length: 20 }, (_, i) => {
      const t = i / 19;
      return [Math.round(x0 + (x1 - x0) * t), Math.round(300 + Math.sin(t * 5) * 120)];
    });
    ws.send(JSON.stringify({ t: 'stroke', points }));
    console.log(`[${name}] 내 구역에 물결선`);
  }
  if (wantReady) {
    setTimeout(() => {
      ws.send(JSON.stringify({ t: 'ready' }));
      console.log(`[${name}] 완성`);
    }, 300);
  }
}

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'error') console.log(`[${name}] 에러: ${m.msg}`);
  if (m.t === 'room') console.log(`[${name}] ${m.phase} · 인원 ${m.players.length} · 구간 ${m.segmentIndex + 1}/${m.segments}`);
  if (m.t === 'fragment') {
    console.log(`[${name}] 조각 수신 — 구역 ${JSON.stringify(m.zone)}, 선 ${m.strokes.length}개`);
    playSegment(m.zone);
  }
  if (m.t === 'result') console.log(`[${name}] 정확도 ${Math.round(m.accuracy * 100)}%`);
  if (m.t === 'final') console.log(`[${name}] 최종 ${m.grade} (평균 ${Math.round(m.average * 100)}%)`);
});

ws.on('error', (e) => {
  console.error(`[${name}] 연결 실패: ${e.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  ws.close();
  process.exit(0);
});
