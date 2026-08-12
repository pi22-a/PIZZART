import { Net } from './net';
import { CircleCanvas } from './canvas';
import type { Point } from '../shared/drawing';
import type { PlayerInfo, ServerMsg } from '../shared/protocol';
import {
  show, setTag, renderPlayers, renderSlices, renderAnswers,
  renderRanking, countdown, stopSpinHint, renderLobbyNote, renderHintTally,
} from './screens';
import { revealRound, drawBoard, drawAssembled } from './reveal';

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
let iSolved = false;
let lastAttempt = -1;
let drawerId = '';
/** 이번 시도에 내 조각을 받았는가. 못 받았으면 이 라운드는 관전이다. */
let hasSlices = false;

const net = new Net(room, onMsg);
net.onStatus((ok) => setTag('netTag', ok ? '연결됨' : '끊김'));

const drawCanvas = new CircleCanvas($('drawCanvas') as HTMLCanvasElement, { interactive: true });
/**
 * 획은 다 그은 뒤에 통째로 보낸다.
 *
 * 예전에는 점이 찍힐 때마다 net에 넣고 50ms마다 모아 보냈다. 그 방식은 전원이 동시에
 * 그리며 서로의 선을 실시간으로 보던 이전 게임의 것이고, PIZZA는 출제자 혼자 그리며
 * 아무도 그 과정을 보지 않으므로 쪼개 보낼 이유가 없다.
 *
 * 게다가 쪼개면 실제로 망가졌다. 사람이 천천히 그으면 점 사이 간격이 50ms를 넘어
 * 점 하나짜리 메시지가 나가는데, 서버는 점이 둘 미만인 획을 버린다. 즉 또박또박 그린
 * 그림일수록 통째로 사라졌다.
 */
drawCanvas.onStroke((points: Point[]) => net.send({ t: 'stroke', points }));

const nameInput = $('nameInput') as HTMLInputElement;
const nameSaveBtn = $('nameSaveBtn') as HTMLButtonElement;
const NAME_HINT_DEFAULT = '엔터를 쳐도 저장됩니다 · 최대 12자';
// 새로고침해도 이름을 잃지 않는다. 잃으면 서버가 이름을 받아줘도 다시 '손님'이 된다.
nameInput.value = params.get('name') ?? sessionStorage.getItem('pizza-name') ?? '';
/** 지금까지 서버에 확정된 이름. 빈 이름 저장 시도를 되돌릴 때 여기로 복원한다. */
let lastName = nameInput.value.trim() || '손님';
const join = () => net.send({ t: 'join', name: lastName, cid: cid! });
join();

/**
 * 저장 버튼 클릭·엔터·change(포커스 이탈) 세 경로가 전부 여기로 모인다.
 * 세 경로가 각자 다른 걸 보내면 "엔터가 저장 버튼과 같은 일을 하는지" 아무도 확신할 수 없다.
 *
 * 이름을 비우고 저장하면 서버는 조용히 '손님'으로 바꿔버린다 — 파티에서 그렇게 되면
 * 누가 자기인지 아무도 못 알아본다. 그래서 빈 이름은 거부하고 이전 이름을 지킨다.
 */
const saveName = () => {
  const raw = nameInput.value.trim();
  if (!raw) {
    nameInput.value = lastName;
    setTag('nameHint', `이름을 비워둘 수 없어 이전 이름(${lastName})을 유지합니다`);
    return;
  }
  lastName = raw;
  sessionStorage.setItem('pizza-name', raw);
  net.send({ t: 'join', name: raw, cid: cid! });
  setTag('nameHint', NAME_HINT_DEFAULT);
};
nameSaveBtn.addEventListener('click', saveName);
nameInput.addEventListener('change', saveName);
nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') saveName();
});

$('startBtn').addEventListener('click', () => net.send({ t: 'start' }));
$('doneBtn').addEventListener('click', () => net.send({ t: 'drawDone' }));
$('undoBtn').addEventListener('click', () => net.send({ t: 'undo' }));
$('nextBtn').addEventListener('click', () => net.send({ t: 'next' }));
$('againBtn').addEventListener('click', () => net.send({ t: 'again' }));
// 버튼 라벨은 "힌트받기"로 바뀌었지만 서버로 나가는 메시지 이름(skip)은 그대로다 —
// 서버·프로토콜은 이 작업 범위 밖이고, 이름을 바꿔봐야 서버 테스트만 흔들린다.
$('hintBtn').addEventListener('click', () => {
  // 적어둔 답을 먼저 밀어 보낸다. 이 힌트받기로 정족수가 차면 서버가 그 자리에서
  // 시도를 끝내버려, 250ms 뒤에 갈 예정이던 답은 영영 못 간다 — 다 쳐놓고 (무응답).
  flushAnswer();
  net.send({ t: 'skip' });
});

const answerInput = $('answerInput') as HTMLInputElement;
let answerTimer = 0;
answerInput.addEventListener('input', () => {
  // 제출 뒤에 글자를 고치면 "제출됨" 표시가 지금 값과 어긋난 거짓말이 된다 — 바로 지운다.
  markAnswerSaved(false);
  clearTimeout(answerTimer);
  answerTimer = window.setTimeout(() => {
    answerTimer = 0;
    net.send({ t: 'answer', text: answerInput.value });
  }, 250);
});
// 엔터는 모두의 반사 신경이다. 여기서 안 받으면 아무 일도 안 일어난 것처럼 보인다.
// 제출 버튼과 똑같이 즉시 반영 + 확인 표시까지 간다.
answerInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') submitAnswer();
});
$('answerSubmitBtn').addEventListener('click', submitAnswer);

/** 디바운스 대기 중인 답을 지금 당장 보낸다 (넘기기 직전에 쓰는 조용한 경로) */
function flushAnswer(): void {
  if (!answerTimer) return;
  clearTimeout(answerTimer);
  answerTimer = 0;
  net.send({ t: 'answer', text: answerInput.value });
}

/**
 * 제출 버튼과 엔터가 공유하는 경로. flushAnswer와 달리 대기 중인 디바운스가 없어도
 * (예: 아무것도 안 고친 채 다시 눌렀을 때) 무조건 보내고, "제출됨" 확인을 켠다 —
 * 답은 최종이 아니라 지금 서버에 저장된 값이라는 뜻이라, 다시 고치면 확인은 다시 꺼진다.
 */
function submitAnswer(): void {
  clearTimeout(answerTimer);
  answerTimer = 0;
  net.send({ t: 'answer', text: answerInput.value });
  markAnswerSaved(true);
}

function markAnswerSaved(saved: boolean): void {
  $('answerSavedNote').textContent = saved ? '제출됨 ✓' : '';
}

/**
 * 조각을 못 받은 사람에게 살아 있는 척하는 입력창을 주지 않는다.
 * 라운드 도중 합류자와, 조각을 나눌 때 끊겨 있던 사람이 여기 해당한다.
 * 그대로 두면 열심히 답을 쳐 넣지만 서버는 조용히 버린다.
 */
function setSpectating(on: boolean): void {
  answerInput.disabled = on;
  ($('answerSubmitBtn') as HTMLButtonElement).disabled = on;
  ($('hintBtn') as HTMLButtonElement).disabled = on;
  $('spectateNote').textContent = on ? '이번 라운드는 관전입니다 — 다음 라운드부터 참여합니다' : '';
}

function onMsg(m: ServerMsg): void {
  if (m.t === 'joined') { youId = m.youId; return; }

  if (m.t === 'room') {
    hostId = m.hostId;
    names = new Map(m.players.map((p) => [p.id, p.name]));
    renderPlayers(m.players, youId, hostId, m.phase);
    setTag('roundTag', m.phase === 'lobby' ? '' : `라운드 ${m.round + 1}/${m.totalRounds}`);
    setTag('topicTag', m.topic ? `주제 ${m.topic}` : '');
    countdown(m.deadline);

    const me = m.players.find((p) => p.id === youId);
    iSolved = me?.solved === true;
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
      markAnswerSaved(false); // 지난 시도의 "제출됨"이 새 시도까지 이어지면 거짓말이다
      hasSlices = false;
    }

    ($('startBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('nextBtn') as HTMLButtonElement).disabled = youId !== hostId;
    renderLobbyNote(m.players, youId, hostId, m.minPlayers);

    if (m.phase !== lastPhase) onPhase(m.phase, iDraw, m.players, m.topic);
    lastPhase = m.phase;

    if (m.phase === 'guessing') {
      const last = m.attempt >= m.maxAttempts;
      $('scoreTag').textContent = iSolved
        ? '맞혔습니다 — 점수 확정'
        : `지금 맞히면 ${me?.pendingScore ?? 0}점`;
      $('solvedWrap').style.display = iSolved ? '' : 'none';
      ($('answerSubmitBtn') as HTMLButtonElement).disabled = iSolved;
      ($('hintBtn') as HTMLButtonElement).disabled = iSolved || last || me?.skipped === true;
      $('hintNote').style.display = iSolved || last ? 'none' : '';
      $('guessNote').textContent =
        `시도 ${m.attempt}/${m.maxAttempts} — 못 맞히면 조각이 하나 늘어납니다`;
      setSpectating(!hasSlices);
      renderHintTally(m.players, youId);
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

  if (m.t === 'board') {
    const note = `${m.sliceCount}조각 중 ${m.visible.length}조각이 나가 있습니다 — 밝은 부분만 보입니다`;
    // 출제자는 대기 화면에서, 먼저 맞힌 사람은 추론 화면 안에서 같은 현황판을 본다.
    $('boardWrap').style.display = '';
    drawBoard($('boardCanvas') as HTMLCanvasElement, m.drawing, m.sliceCount, m.visible);
    $('boardNote').textContent = note;
    if (iSolved) {
      $('solvedWrap').style.display = '';
      drawBoard($('solvedBoard') as HTMLCanvasElement, m.drawing, m.sliceCount, m.visible);
      $('solvedNote').textContent = note;
    }
    return;
  }

  if (m.t === 'assembled') {
    // 마지막 회차. 회전을 풀어 제자리에 끼운 조각을 보여준다.
    $('sliceBox').style.display = 'none';
    $('assembledWrap').style.display = '';
    drawAssembled($('assembledCanvas') as HTMLCanvasElement, m.pieces, m.sliceCount);
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
    $('boardWrap').style.display = 'none';
    return show('wait');
  }
  if (phase === 'guessing') {
    if (iDraw) {
      $('waitTopic').textContent = topic ? `주제 ${topic}` : '';
      $('waitWho').textContent = '모두가 당신의 그림을 맞히는 중입니다';
      $('boardWrap').style.display = '';
      return show('wait');
    }
    return show('guess');
  }
  if (phase === 'roundEnd') return show('round');
  if (phase === 'final') return show('final');
}
