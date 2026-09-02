// 가짜 플레이어. 인원을 채우고 자동으로 한 판을 돌린다.
//
//   node scripts/fake-player.mjs 방코드 봇1 --draw --answer=호랑이
//
//   --draw          출제자가 되면 원 안에 아무 그림이나 그리고 끝낸다
//   --answer=말     추론 단계에서 이 답을 적는다 (없으면 안 적는다)
//   --skip          답을 적은 뒤 넘기기를 누른다
//   --host          방장이 누구든 인원이 차는 대로 게임을 시작한다 (모든 봇에 전달해도 안전)
//   --next          방장이 누구든 결과 화면에서 다음으로 넘긴다 (모든 봇에 전달해도 안전)
//   --again         최종 화면에서 딱 한 번 "한 판 더"를 누른다 (같은 방에서 두 판을 돌려본다)
//   --quiet         받은 메시지를 찍지 않는다
import { WebSocket } from 'ws';

const [room = 'TEST', name = '봇'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const has = (f) => flags.includes(f);
const val = (f) => flags.find((a) => a.startsWith(`${f}=`))?.split('=')[1];

const PORT = process.env.PORT ?? 8080;
const ws = new WebSocket(`ws://localhost:${PORT}/?room=${encodeURIComponent(room)}`);

let youId = '';
let drewThisRound = -1;
let answeredKey = '';
let nextSentForRound = -1;
let startSent = false;
let againSent = false;

const log = (...a) => { if (!has('--quiet')) console.log(`[${name}]`, ...a); };
const send = (m) => ws.send(JSON.stringify(m));

ws.on('open', () => {
  send({ t: 'join', name, cid: `fake-${name}` });
  log('접속');
});

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));

  if (m.t === 'joined') {
    youId = m.youId;
    return;
  }

  if (m.t === 'room') {
    const me = m.players.find((p) => p.id === youId);
    if (!me) return;
    log(`${m.phase} 라운드 ${m.round + 1}/${m.totalRounds} 주제:${m.topic} 시도:${m.attempt}` +
        (me.isDrawer ? ' (내가 출제자)' : ''));

    // 새 게임 시작 시 래치 리셋 (로비에 돌아올 때)
    if (m.phase === 'lobby') {
      drewThisRound = -1;
      answeredKey = '';
      nextSentForRound = -1;
    }

    if (m.phase === 'drawing' && me.isDrawer && has('--draw') && drewThisRound !== m.round) {
      drewThisRound = m.round;
      setTimeout(() => scribble(), 300);
    }
    if (m.phase === 'guessing' && !me.isDrawer && answeredKey !== `${m.round}:${m.attempt}`) {
      answeredKey = `${m.round}:${m.attempt}`;
      const text = val('--answer');
      if (text) setTimeout(() => { send({ t: 'answer', text }); log(`답: ${text}`); }, 200);
      if (has('--skip')) setTimeout(() => send({ t: 'skip' }), 500);
    }

    // startSent 리셋 (로비 떠날 때)
    if (m.phase !== 'lobby') {
      startSent = false;
    }

    // 인원 조건은 서버가 알려준 값을 쓴다. 숫자를 박아두면 최소 인원을 바꿀 때마다
    // 봇이 조용히 시작을 안 해서, 규칙이 아니라 도구 때문에 판이 안 도는 일이 생긴다.
    if (m.phase === 'lobby' && has('--host') && youId === m.hostId
        && m.players.length >= (m.minPlayers ?? 4) && !startSent) {
      startSent = true;
      setTimeout(() => send({ t: 'start' }), 500);
    }
    if (m.phase === 'roundEnd' && has('--next') && youId === m.hostId && nextSentForRound !== m.round) {
      nextSentForRound = m.round;
      setTimeout(() => send({ t: 'next' }), 1500);
    }
    // 한 판만 더 돌린다. 래치를 안 걸면 판이 끝없이 이어진다.
    if (m.phase === 'final' && has('--again') && !againSent) {
      againSent = true;
      setTimeout(() => { send({ t: 'again' }); log('한 판 더'); }, 1000);
    }
    return;
  }

  if (m.t === 'slices') {
    const ink = m.slices.reduce((n, s) => n + s.strokes.length, 0);
    log(`조각 ${m.slices.length}개, 선 ${ink}개`);
    return;
  }

  if (m.t === 'attemptResult') {
    log(`시도 ${m.attempt}:`, m.answers.map((a) => `${a.text || '(무응답)'}${a.correct ? ' O' : ''}`).join(', '));
    return;
  }

  if (m.t === 'roundEnd') {
    log(`정답은 "${m.word}" — 맞힌 사람 ${m.correct.length}명`);
    return;
  }

  if (m.t === 'final') {
    log('최종:', m.ranking.map((r) => `${r.name} ${r.score}`).join(', '));
    return;
  }

  if (m.t === 'error') log('오류:', m.msg);
});

ws.on('close', () => log('끊김'));

/** 원 안에 아무렇게나 몇 획 긋고 끝낸다 */
function scribble() {
  for (let i = 0; i < 8; i++) {
    const a0 = Math.random() * Math.PI * 2;
    const a1 = a0 + (Math.random() - 0.5) * 2;
    const r0 = Math.random() * 380;
    const r1 = Math.random() * 380;
    send({
      t: 'stroke',
      points: [
        [Math.round(500 + Math.cos(a0) * r0), Math.round(500 + Math.sin(a0) * r0)],
        [Math.round(500 + Math.cos(a1) * r1), Math.round(500 + Math.sin(a1) * r1)],
      ],
    });
  }
  send({ t: 'drawDone' });
  log('그리기 끝');
}
