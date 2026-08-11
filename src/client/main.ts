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

const net = new Net(room, onMsg);
net.onStatus((ok) => setTag('netTag', ok ? '연결됨' : '끊김'));

const drawCanvas = new CircleCanvas($('drawCanvas') as HTMLCanvasElement, { interactive: true });
drawCanvas.onPoint((p: Point) => net.pushPoint(p));
drawCanvas.onStroke(() => net.endStroke());

const nameInput = $('nameInput') as HTMLInputElement;
nameInput.value = params.get('name') ?? '';
const join = () => net.send({ t: 'join', name: nameInput.value.trim() || '손님', cid: cid! });
join();
nameInput.addEventListener('change', join);

$('startBtn').addEventListener('click', () => net.send({ t: 'start' }));
$('doneBtn').addEventListener('click', () => net.send({ t: 'drawDone' }));
$('undoBtn').addEventListener('click', () => net.send({ t: 'undo' }));
$('nextBtn').addEventListener('click', () => net.send({ t: 'next' }));
$('skipBtn').addEventListener('click', () => net.send({ t: 'skip' }));

const answerInput = $('answerInput') as HTMLInputElement;
let answerTimer = 0;
answerInput.addEventListener('input', () => {
  clearTimeout(answerTimer);
  answerTimer = window.setTimeout(() => net.send({ t: 'answer', text: answerInput.value }), 250);
});

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

    ($('startBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('nextBtn') as HTMLButtonElement).disabled = youId !== hostId;
    $('lobbyNote').textContent =
      youId === hostId ? '방장입니다. 4명이 모이면 시작하세요.' : '방장이 시작하기를 기다립니다.';

    if (m.phase !== lastPhase) onPhase(m.phase, iDraw, m.players);
    lastPhase = m.phase;

    if (m.phase === 'guessing') {
      $('guessNote').textContent =
        `시도 ${m.attempt}/${m.maxAttempts} — 못 맞히면 조각이 하나 늘어납니다`;
    }
    return;
  }

  if (m.t === 'word') { setTag('wordTag', m.word); return; }
  if (m.t === 'canvas') { drawCanvas.render(m.strokes); return; }

  if (m.t === 'slices') {
    sliceCount = m.count;
    renderSlices(m.slices, sliceCount);
    return;
  }

  if (m.t === 'attemptResult') {
    renderAnswers('lastAnswers', m.answers, names);
    return;
  }

  if (m.t === 'roundEnd') {
    sliceCount = m.sliceCount;
    setTag('revealWord', `정답: ${m.word}`);
    renderAnswers('revealAnswers', m.scores.map((s) => ({
      playerId: s.playerId,
      text: s.delta > 0 ? `+${s.delta}점 (합계 ${s.total})` : `합계 ${s.total}`,
      correct: m.correct.includes(s.playerId),
    })), names);
    revealRound($('revealCanvas') as HTMLCanvasElement, m.drawing, m.sliceCount, m.owners, youId);
    return;
  }

  if (m.t === 'final') { renderRanking(m.ranking); return; }
  if (m.t === 'error') { alert(m.msg); return; }
}

function onPhase(phase: string, iDraw: boolean, players: PlayerInfo[]): void {
  if (phase !== 'guessing') stopSpinHint();

  if (phase === 'lobby') return show('lobby');
  if (phase === 'drawing') {
    if (iDraw) { drawCanvas.clear(); return show('draw'); }
    const drawer = players.find((p) => p.isDrawer);
    $('waitTopic').textContent = document.getElementById('topicTag')!.textContent ?? '';
    $('waitWho').textContent = `${drawer?.name ?? '누군가'} 님이 그리는 중입니다`;
    return show('wait');
  }
  if (phase === 'guessing') {
    if (iDraw) { $('waitWho').textContent = '모두가 당신의 그림을 맞히는 중입니다'; return show('wait'); }
    answerInput.value = '';
    return show('guess');
  }
  if (phase === 'roundEnd') return show('round');
  if (phase === 'final') return show('final');
}
