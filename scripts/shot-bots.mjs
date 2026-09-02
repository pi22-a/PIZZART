/**
 * 스토어 스크린샷을 찍기 위한 들러리 셋.
 *
 * 사람 넷이 모여야 판이 시작되는데 스크린샷 찍자고 넷을 부를 수는 없다.
 * 이 봇들은 자기 차례에 그림을 그리고, 맞히는 차례에는 넘긴다 —
 * 판이 조립판까지 굴러가야 찍을 화면이 다 나온다.
 */
import WebSocket from 'ws';

const ROOM = process.env.ROOM ?? 'SHOT';
const PORT = process.env.PORT ?? '8080';
const NAMES = ['민준', '서연', '도윤'];
/** 그럴듯한 오답들. 실제 판에서 사람들이 내는 답이 대개 이런 모양이다. */
const GUESSES = ['비행기', '기차역', '공장', '병원', '체육관', '주차장'];
/** 그리는 봇이 받은 제시어. 같은 프로세스라 나눠 쓴다 (스크린샷용 장치). */
let word = '';

/** 원판을 채우는 단순한 집 모양. 무슨 제시어든 그림은 그림이다. */
const SHAPE = [
  [[300, 620], [300, 400], [500, 250], [700, 400], [700, 620], [300, 620]],
  [[430, 620], [430, 480], [570, 480], [570, 620]],
  [[350, 430], [350, 350], [400, 350], [400, 400]],
];

for (let i = 0; i < 3; i++) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${ROOM}`);
  let me = '';
  let drew = -1;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: NAMES[i], cid: `shot-${i}` })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'joined') me = m.youId;
    if (m.t === 'word') word = m.word;
    if (m.t !== 'room') return;
    const drawer = m.players.find((p) => p.isDrawer)?.id;

    if (m.phase === 'drawing' && drawer === me && drew !== m.round) {
      drew = m.round;
      for (const points of SHAPE) ws.send(JSON.stringify({ t: 'stroke', points, color: '#1f1b17' }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'drawDone' })), 700);
    }
    /*
     * 맞히는 차례. 스크린샷용이라 **그럴듯한 오답**을 낸다 — 전부 (무응답)이면
     * 결과 화면이 텅 비어서, 이 게임의 알맹이인 "다들 뭐라고 답했나"가 안 보인다.
     *
     * 마지막 회차에는 한 명이 정답을 맞힌다. 그림 그리는 봇이 제시어를 알고 있고
     * 같은 프로세스 안이라 그 값을 나눠 쓴다 — 판을 겨루는 것이 아니라 화면을 찍는
     * 장치이므로 이렇게 해도 된다.
     */
    if (m.phase === 'guessing' && drawer !== me) {
      const mine = m.players.find((p) => p.id === me);
      if (!mine || mine.answered || mine.skipped || mine.solved) return;
      const last = m.attempt >= m.maxAttempts;
      const text = last && i === 0 && word ? word : GUESSES[(i + m.attempt) % GUESSES.length];
      setTimeout(() => ws.send(JSON.stringify({ t: 'answer', text })), 600);
    }
  });
  ws.on('error', (e) => console.error('봇 오류:', e.message));
}
console.log('들러리 셋이 들어갔습니다. 브라우저에서 진행하세요.');
setTimeout(() => process.exit(0), 15 * 60 * 1000);
