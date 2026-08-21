import { Net } from './net';
import { CircleCanvas } from './canvas';
import type { Point } from '../shared/drawing';
import type { PlayerInfo, ServerMsg } from '../shared/protocol';
import {
  show, setTag, renderPlayers, renderSlices, renderAnswers,
  renderRanking,
  renderTopics,
  syncClock,
  renderWatch, countdown, stopSpinHint, renderLobbyNote, renderSkipTally,
} from './screens';
import { DoodleBoard, COLORS as DOODLE_COLORS } from './doodle';
import { armAudio, isMuted, loadMuted, setMuted, timeTick } from './sound';
import { revealRound, drawBoard, drawAssembled } from './reveal';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * 밝게/어둡게. 고른 값은 이 브라우저에 남는다.
 * 피자 캔버스는 어느 쪽에서도 종이처럼 읽히므로 배경과 글자색만 바꾼다.
 */
const themeBtn = $('themeBtn') as HTMLButtonElement;
function applyTheme(light: boolean): void {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeBtn.textContent = light ? '☀️' : '🌙';
  themeBtn.title = light ? '어둡게 보기' : '밝게 보기';
}
applyTheme(localStorage.getItem('pizza-theme') === 'light');
themeBtn.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  localStorage.setItem('pizza-theme', light ? 'light' : 'dark');
  applyTheme(light);
});

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
/** 회차가 넘어갔으니 입력칸에 커서를 돌려줘야 한다 — 화면 상태가 다 정해진 뒤에 쓴다. */
let refocusAfterRender = false;

/**
 * 회차가 넘어가면 커서가 풀려서 매번 입력칸을 다시 눌러야 했다.
 *
 * 비활성 여부가 room 처리 끝에서야 정해지므로, 회차 전환 시점에 바로 focus()를 부르면
 * 그 뒤 disabled 처리에 묻힌다. 그래서 표시만 해두고 여기서 준다.
 */
function restoreFocus(): void {
  if (!refocusAfterRender) return;
  // 아직 잠겨 있으면 표시를 남겨둔다. room이 조각(slices)보다 먼저 오므로 이 시점에는
  // 아직 조각을 못 받아 입력칸이 잠겨 있고, 여기서 표시를 지워버리면 영영 커서가 안 온다.
  if (answerInput.disabled || !$('s-guess').classList.contains('on')) return;
  refocusAfterRender = false;
  answerInput.focus();
}
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

/**
 * 대기 화면 낙서판. 출제자가 그리는 동안 기다리는 사람들이 같이 갈긴다.
 * 내 id는 늦게 정해지므로(joined 메시지) 값이 아니라 함수로 넘긴다.
 */
const doodle = new DoodleBoard($('doodleCanvas') as HTMLCanvasElement, () => youId);
doodle.onStroke((points: Point[]) => net.send({ t: 'doodle', points, color: doodle.getColor() }));

/**
 * 낙서 색 고르기.
 *
 * 색은 한 사람당 하나다. 두 사람이 같은 색을 쓰면 누가 그린 선인지 구분이 안 되고,
 * 그 상태에서 한쪽이 자기 낙서를 지우면 다른 쪽은 자기 그림이 지워졌다고 오해한다.
 * 그래서 임자가 있는 색은 아예 못 고르게 막는다. 색은 서버가 정한다.
 */
function renderDoodleColors(players: PlayerInfo[]): void {
  const box = $('doodleColors');
  if (box.childElementCount === 0) {
    for (const c of DOODLE_COLORS) {
      const b = document.createElement('button');
      b.style.background = c;
      b.dataset.color = c;
      b.addEventListener('click', () => net.send({ t: 'doodleColor', color: c }));
      box.appendChild(b);
    }
  }
  const mine = players.find((p) => p.id === youId)?.doodleColor ?? '';
  const taken = new Map(players.filter((p) => p.doodleColor).map((p) => [p.doodleColor, p.name]));
  if (mine) doodle.setColor(mine);
  for (const el of box.querySelectorAll('button')) {
    const b = el as HTMLButtonElement;
    const c = b.dataset.color!;
    const owner = taken.get(c);
    b.classList.toggle('on', c === mine);
    b.disabled = owner !== undefined && c !== mine;
    b.title = c === mine ? '내 색' : owner ? `${owner} 님이 쓰는 색` : '이 색으로 바꾸기';
  }
}
// 자동재생 정책 때문에 사람이 한 번 누르기 전에는 소리가 안 난다. 첫 조작에서 깨운다.
armAudio();
const muteBtn = $('muteBtn') as HTMLButtonElement;
const paintMute = () => {
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.title = isMuted() ? '초읽기 소리 켜기' : '초읽기 소리 끄기';
};
loadMuted();
paintMute();
muteBtn.addEventListener('click', () => { setMuted(!isMuted()); paintMute(); });

$('doodleClearBtn').addEventListener('click', () => {
  doodle.clearMine();
  net.send({ t: 'doodleClear' });
});

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
// 스킵은 "이번 회차는 접는다"는 뜻이다. 적어둔 답을 밀어 보내지 않는다 —
// 스킵으로 점수를 지키려던 사람이 그 답으로 채점되면 안 된다.
// 서버도 같은 이유로 스킵한 사람의 답을 지운다.
$('skipBtn').addEventListener('click', () => net.send({ t: 'skip' }));

const answerInput = $('answerInput') as HTMLInputElement;
/**
 * 치는 것만으로는 제출되지 않는다. 제출은 버튼이나 엔터로만 한다.
 *
 * 예전에는 250ms마다 자동으로 보냈다. 그래서 "고양"까지 치다가 회차가 끝나면 그게
 * 오답 제출로 채점돼 1점이 깎였다 — 낼 생각도 없던 답이었는데.
 */
answerInput.addEventListener('input', () => {
  // 제출 뒤에 글자를 고치면 "제출됨" 표시가 지금 값과 어긋난 거짓말이 된다 — 바로 지운다.
  markAnswerSaved(false);
  markAnswerPending(answerInput.value.trim().length > 0);
});
// 엔터는 모두의 반사 신경이다. 여기서 안 받으면 아무 일도 안 일어난 것처럼 보인다.
// 제출 버튼과 똑같이 즉시 반영 + 확인 표시까지 간다.
answerInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') submitAnswer();
});
$('answerSubmitBtn').addEventListener('click', submitAnswer);

/**
 * 제출 버튼과 엔터가 공유하는 경로. 무조건 보내고 "제출됨" 확인을 켠다 —
 * 답은 최종이 아니라 지금 서버에 저장된 값이라는 뜻이라, 다시 고치면 확인은 다시 꺼진다.
 */
function submitAnswer(): void {
  net.send({ t: 'answer', text: answerInput.value });
  markAnswerSaved(true);
}

function markAnswerSaved(saved: boolean): void {
  if (saved) markAnswerPending(false);
  $('answerSavedNote').textContent = saved ? '제출됨 ✓' : '';
}

/**
 * 쓰기만 하고 아직 안 낸 상태를 알려준다.
 *
 * 자동 제출을 없앴으므로, 적어놓고 제출을 안 누르면 아무 일도 안 일어난다.
 * 그걸 모르면 "냈는데 왜 무응답이지?"가 된다.
 */
function markAnswerPending(pending: boolean): void {
  $('answerSavedNote').textContent = pending ? '아직 제출 안 함 — 엔터나 제출' : '';
}

/**
 * 조각을 못 받은 사람에게 살아 있는 척하는 입력창을 주지 않는다.
 * 라운드 도중 합류자와, 조각을 나눌 때 끊겨 있던 사람이 여기 해당한다.
 * 그대로 두면 열심히 답을 쳐 넣지만 서버는 조용히 버린다.
 */
function setSpectating(on: boolean): void {
  answerInput.disabled = on;
  ($('answerSubmitBtn') as HTMLButtonElement).disabled = on;
  ($('skipBtn') as HTMLButtonElement).disabled = on;
  $('spectateNote').textContent = on ? '이번 라운드는 관전입니다 — 다음 라운드부터 참여합니다' : '';
}

function onMsg(m: ServerMsg): void {
  if (m.t === 'joined') { youId = m.youId; return; }

  if (m.t === 'room') {
    hostId = m.hostId;
    names = new Map(m.players.map((p) => [p.id, p.name]));
    syncClock(m.now);
    renderPlayers(m.players, youId, hostId, m.phase);
    // 색은 서버가 정하고 room으로 내려온다. 남이 색을 바꿔도 바로 팔레트에 반영돼야
    // "임자 있는 색"을 눌러보는 일이 없다.
    if (m.phase === 'drawing') renderDoodleColors(m.players);
    setTag('roundTag', m.phase === 'lobby' ? '' : `라운드 ${m.round + 1}/${m.totalRounds}`);
    setTag('topicTag', m.topic ? `주제 ${m.topic}` : '');
    // 소리는 시간이 도는 단계에서만 낸다. 결과 화면처럼 마감이 없는 곳은 조용하다.
    countdown(m.deadline, (left) => {
      if (m.phase === 'drawing' || m.phase === 'guessing') timeTick(left);
    });

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

    // 회차가 바뀌었다. 쓰던 글자는 그대로 둔다 — 치는 도중에 회차가 넘어가면 글자가
    // 사라져 처음부터 다시 쳐야 했다. 이제 제출은 버튼·엔터로만 하므로 남겨둬도
    // 실수로 다시 나가지 않는다.
    if (m.attempt !== lastAttempt) {
      lastAttempt = m.attempt;
      markAnswerSaved(false); // 지난 회차의 "제출됨"이 새 회차까지 이어지면 거짓말이다
      markAnswerPending(answerInput.value.trim().length > 0);
      hasSlices = false;
      // 커서는 여기서 주면 안 된다. 입력칸의 비활성 여부가 이 아래에서 정해지므로
      // 지금 focus()를 부르면 그 뒤 disabled 처리에 묻힌다. 표시만 해두고 끝에서 준다.
      refocusAfterRender = true;
    }

    if (m.phase === 'lobby') {
      renderTopics(m.topics, m.selectedTopic, youId === hostId,
        (topic) => net.send({ t: 'setTopic', topic }));
    }
    ($('startBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('nextBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('againBtn') as HTMLButtonElement).disabled = youId !== hostId;
    // 잠긴 버튼만 덩그러니 두면 "왜 안 눌리지"로 끝난다. 누가 눌러야 하는지 적어준다.
    $('againNote').textContent = youId === hostId
      ? ''
      : `${names.get(hostId) ?? '방장'} 님이 눌러야 새 판이 시작됩니다`;
    renderLobbyNote(m.players, youId, hostId, m.minPlayers);

    if (m.phase !== lastPhase) onPhase(m.phase, iDraw, m.players, m.topic);
    lastPhase = m.phase;

    if (m.phase === 'guessing') {
      const last = m.attempt >= m.maxAttempts;
      const skipped = me?.skipped === true;
      $('scoreTag').textContent = iSolved
        ? '맞혔습니다 — 점수 확정'
        : `지금 맞히면 ${me?.pendingScore ?? 0}점`;
      $('solvedWrap').style.display = iSolved ? '' : 'none';
      // 관전 처리가 입력창 잠금을 통째로 다시 쓴다. 먼저 부르지 않으면 아래에서 건
      // 잠금이 그 자리에서 풀린다 — 스킵을 누르고도 답이 나가는 길이 열린다.
      setSpectating(!hasSlices);
      // 스킵을 눌렀으면 이번 회차는 접은 것이다. 입력까지 잠가야 실수로 답을 내고
      // 점수를 잃는 길이 아예 막힌다 — 버튼만 잠그면 엔터로 그대로 나간다.
      const mute = iSolved || skipped || !hasSlices;
      ($('answerSubmitBtn') as HTMLButtonElement).disabled = mute;
      answerInput.disabled = mute;
      ($('skipBtn') as HTMLButtonElement).disabled = mute || last;
      $('skipNote').style.display = iSolved || last ? 'none' : '';
      $('guessNote').textContent = last
        ? `시도 ${m.attempt}/${m.maxAttempts} — 마지막 기회입니다`
        : `시도 ${m.attempt}/${m.maxAttempts} — 다음 회차로 넘어가면 조각이 하나 늘고 1점 깎입니다`;
      renderSkipTally(m.players, youId);
    }
    restoreFocus();
    return;
  }

  if (m.t === 'word') { setTag('wordTag', m.word); return; }
  if (m.t === 'canvas') { drawCanvas.render(m.strokes); return; }

  if (m.t === 'doodleStroke') { doodle.add({ by: m.by, points: m.points, color: m.color }); return; }
  if (m.t === 'doodleBoard') { doodle.setBoard(m.strokes); return; }

  if (m.t === 'slices') {
    sliceCount = m.count;
    hasSlices = true;
    // 지난 라운드 마지막 회차에서 켜둔 조립판을 여기서 되돌린다. 되돌리지 않으면
    // 조각칸이 숨겨진 채로 다음 라운드에 들어가 지난 그림이 그대로 남는다 —
    // 조립판을 받은 적이 없는 직전 출제자만 새 그림을 보게 된다.
    $('sliceBox').style.display = '';
    $('assembledWrap').style.display = 'none';
    renderSlices(m.slices, sliceCount);
    // 조각이 도착해야 입력칸이 열린다. 회차 전환 때 미뤄둔 커서를 지금 준다.
    setSpectating(false);
    restoreFocus();
    setSpectating(false);
    return;
  }

  if (m.t === 'attemptResult') {
    renderAnswers('lastAnswers', m.answers, names);
    return;
  }

  if (m.t === 'board') {
    const left = m.watching.filter((w) => !w.solved).length;
    const note = left > 0
      ? `${left}명이 아직 맞히는 중입니다 — 각자 지금 보고 있는 조각입니다`
      : '모두 맞혔습니다';
    // 출제자는 대기 화면에서, 먼저 맞힌 사람은 추론 화면 안에서 같은 현황판을 본다.
    $('boardWrap').style.display = '';
    renderWatch($('boardWatch'), m.watching, m.sliceCount, names);
    $('boardNote').textContent = note;
    if (iSolved) {
      $('solvedWrap').style.display = '';
      renderWatch($('solvedWatch'), m.watching, m.sliceCount, names);
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
    if (iDraw) {
      $('doodleWrap').style.display = 'none';
      drawCanvas.clear();
      return show('draw');
    }
    const drawer = players.find((p) => p.isDrawer);
    $('waitTopic').textContent = topic ? `주제 ${topic}` : '';
    $('waitWho').textContent = `${drawer?.name ?? '누군가'} 님이 그리는 중입니다`;
    $('boardWrap').style.display = 'none';
    // 판을 먼저 띄우고 나서 비운다. 반대로 하면 아직 숨겨진 캔버스에 그려
    // 폭 0으로 뭉개지고, 그 뒤로 아무도 다시 그려주지 않아 빈 판이 된다.
    $('doodleWrap').style.display = '';
    show('wait');
    // 라운드가 바뀌면 낙서판도 새 판이다. 서버도 라운드 시작에서 비운다.
    doodle.clear();
    return;
  }
  if (phase === 'guessing') {
    $('doodleWrap').style.display = 'none';
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
