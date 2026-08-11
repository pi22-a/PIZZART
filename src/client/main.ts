import { Net } from './net';
import { CircleCanvas } from './canvas';
import type { Point } from '../shared/drawing';
import type { PlayerInfo, ServerMsg } from '../shared/protocol';
import {
  show, setTag, renderPlayers, renderSlices, renderAnswers,
  renderRanking, countdown, stopSpinHint,
} from './screens';
import { revealRound } from './reveal';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const room = (params.get('room') ?? 'LOBBY').toUpperCase();
setTag('roomTag', `방 ${room}`);

/** 새로고침해도 같은 자리로 돌아오게 하는 식별자 */
let cid = sessionStorage.getItem('pizza-cid');
if (!cid) { cid = crypto.randomUUID(); sessionStorage.setItem('pizza-cid', cid); }

let youId = '';
let hostId = '';
let names = new Map<string, string>();
let sliceCount = 8;
let lastPhase = '';
let lastRound = -1;
let lastAttempt = -1;
let drawerId = '';
/** 이번 시도에 내 조각을 받았는가. 못 받았으면 이 라운드는 관전이다. */
let hasSlices = false;

const net = new Net(room, onMsg);
net.onStatus((ok) => setTag('netTag', ok ? '연결됨' : '끊김'));

const drawCanvas = new CircleCanvas($('drawCanvas') as HTMLCanvasElement, { interactive: true });
drawCanvas.onPoint((p: Point) => net.pushPoint(p));
drawCanvas.onStroke(() => net.endStroke());

const nameInput = $('nameInput') as HTMLInputElement;
// 새로고침해도 이름을 잃지 않는다. 잃으면 서버가 이름을 받아줘도 다시 '손님'이 된다.
nameInput.value = params.get('name') ?? sessionStorage.getItem('pizza-name') ?? '';
const join = () => {
  const name = nameInput.value.trim() || '손님';
  sessionStorage.setItem('pizza-name', name === '손님' ? '' : name);
  net.send({ t: 'join', name, cid: cid! });
};
join();
nameInput.addEventListener('change', join);

$('startBtn').addEventListener('click', () => net.send({ t: 'start' }));
$('doneBtn').addEventListener('click', () => net.send({ t: 'drawDone' }));
$('undoBtn').addEventListener('click', () => net.send({ t: 'undo' }));
$('nextBtn').addEventListener('click', () => net.send({ t: 'next' }));
$('againBtn').addEventListener('click', () => net.send({ t: 'again' }));
$('skipBtn').addEventListener('click', () => {
  // 적어둔 답을 먼저 밀어 보낸다. 이 넘기기로 정족수가 차면 서버가 그 자리에서
  // 시도를 끝내버려, 250ms 뒤에 갈 예정이던 답은 영영 못 간다 — 다 쳐놓고 (무응답).
  flushAnswer();
  net.send({ t: 'skip' });
});

const answerInput = $('answerInput') as HTMLInputElement;
let answerTimer = 0;
answerInput.addEventListener('input', () => {
  clearTimeout(answerTimer);
  answerTimer = window.setTimeout(() => {
    answerTimer = 0;
    net.send({ t: 'answer', text: answerInput.value });
  }, 250);
});
// 엔터는 모두의 반사 신경이다. 여기서 안 받으면 아무 일도 안 일어난 것처럼 보인다.
answerInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') flushAnswer();
});

/** 디바운스 대기 중인 답을 지금 당장 보낸다 */
function flushAnswer(): void {
  if (!answerTimer) return;
  clearTimeout(answerTimer);
  answerTimer = 0;
  net.send({ t: 'answer', text: answerInput.value });
}

/**
 * 조각을 못 받은 사람에게 살아 있는 척하는 입력창을 주지 않는다.
 * 라운드 도중 합류자와, 조각을 나눌 때 끊겨 있던 사람이 여기 해당한다.
 * 그대로 두면 열심히 답을 쳐 넣지만 서버는 조용히 버린다.
 */
function setSpectating(on: boolean): void {
  answerInput.disabled = on;
  ($('skipBtn') as HTMLButtonElement).disabled = on;
  $('spectateNote').textContent = on ? '이번 라운드는 관전입니다 — 다음 라운드부터 참여합니다' : '';
}

function onMsg(m: ServerMsg): void {
  if (m.t === 'joined') { youId = m.youId; return; }

  if (m.t === 'room') {
    hostId = m.hostId;
    names = new Map(m.players.map((p) => [p.id, p.name]));
    renderPlayers(m.players, youId);
    setTag('roundTag', m.phase === 'lobby' ? '' : `라운드 ${m.round + 1}/${m.totalRounds}`);
    setTag('topicTag', m.topic ? `주제 ${m.topic}` : '');
    countdown(m.deadline);

    const me = m.players.find((p) => p.id === youId);
    const iDraw = me?.isDrawer === true;
    const drawer = m.players.find((p) => p.isDrawer);
    if (drawer) drawerId = drawer.id;

    // 라운드 번호가 바뀌면 지난 라운드의 답변 잔상을 지운다(Finding 2, 3).
    // 시도 사이에는 phase가 안 바뀌므로 라운드 번호를 트리거로 쓴다.
    if (m.round !== lastRound) {
      lastRound = m.round;
      hasSlices = false;
      renderAnswers('lastAnswers', [], names);
    }

    // 시도 번호가 바뀌면 입력창을 비운다(Finding 4). phase는 시도마다 바뀌지 않는다.
    if (m.attempt !== lastAttempt) {
      lastAttempt = m.attempt;
      answerInput.value = '';
      hasSlices = false;
    }

    ($('startBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('nextBtn') as HTMLButtonElement).disabled = youId !== hostId;
    $('lobbyNote').textContent =
      youId === hostId ? '방장입니다. 4명이 모이면 시작하세요.' : '방장이 시작하기를 기다립니다.';

    if (m.phase !== lastPhase) onPhase(m.phase, iDraw, m.players, m.topic);
    lastPhase = m.phase;

    if (m.phase === 'guessing') {
      $('guessNote').textContent =
        `시도 ${m.attempt}/${m.maxAttempts} — 못 맞히면 조각이 하나 늘어납니다`;
      setSpectating(!hasSlices);
    }
    return;
  }

  if (m.t === 'word') { setTag('wordTag', m.word); return; }
  if (m.t === 'canvas') { drawCanvas.render(m.strokes); return; }

  if (m.t === 'slices') {
    sliceCount = m.count;
    hasSlices = true;
    renderSlices(m.slices, sliceCount);
    setSpectating(false);
    return;
  }

  if (m.t === 'attemptResult') {
    renderAnswers('lastAnswers', m.answers, names);
    return;
  }

  if (m.t === 'roundEnd') {
    sliceCount = m.sliceCount;
    setTag('revealWord', `정답: ${m.word}`);
    // 결과 화면의 핵심은 점수가 아니라 다들 뭐라고 답했는가다(Finding 3).
    // 출제자는 답을 낸 적이 없으니 (무응답)이 아니라 점수 변화만 보여준다.
    //
    // 답은 이 메시지에 실려 온 것만 쓴다. 예전엔 attemptResult로 채워둔 지역 맵을
    // 봤는데, 결과 화면에서 새로고침하면 그 맵이 비어 있어 나만 전원 (무응답)으로 보였다.
    const rows = new Map(m.answers.map((r) => [r.playerId, r]));
    renderAnswers('revealAnswers', m.scores.map((s) => {
      const deltaText = s.delta > 0 ? `+${s.delta}점` : `${s.delta}점`;
      const row = rows.get(s.playerId);
      const text = s.playerId === drawerId
        ? deltaText
        : row?.text
          ? `${row.text} (${deltaText})`
          : '(무응답)';
      return { playerId: s.playerId, text, correct: m.correct.includes(s.playerId) };
    }), names);
    revealRound($('revealCanvas') as HTMLCanvasElement, m.drawing, m.sliceCount, m.owners, youId);
    return;
  }

  if (m.t === 'final') { renderRanking(m.ranking); return; }
  if (m.t === 'error') { alert(m.msg); return; }
}

function onPhase(phase: string, iDraw: boolean, players: PlayerInfo[], topic: string): void {
  if (phase !== 'guessing') stopSpinHint();

  if (phase === 'lobby') return show('lobby');
  if (phase === 'drawing') {
    if (iDraw) { drawCanvas.clear(); return show('draw'); }
    const drawer = players.find((p) => p.isDrawer);
    $('waitTopic').textContent = topic ? `주제 ${topic}` : '';
    $('waitWho').textContent = `${drawer?.name ?? '누군가'} 님이 그리는 중입니다`;
    return show('wait');
  }
  if (phase === 'guessing') {
    if (iDraw) {
      $('waitTopic').textContent = topic ? `주제 ${topic}` : '';
      $('waitWho').textContent = '모두가 당신의 그림을 맞히는 중입니다';
      return show('wait');
    }
    return show('guess');
  }
  if (phase === 'roundEnd') return show('round');
  if (phase === 'final') return show('final');
}
