import type { Point } from '../shared/drawing';
import type { AnswerRow, PlayerInfo } from '../shared/protocol';
import { drawSlice, startSpinHint } from './slice-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SCREENS = ['lobby', 'draw', 'wait', 'guess', 'round', 'final'] as const;
export type ScreenName = typeof SCREENS[number];

export function show(name: ScreenName): void {
  for (const s of SCREENS) $(`s-${s}`).classList.toggle('on', s === name);
}

export function setTag(id: string, text: string): void {
  $(id).textContent = text;
}

export function renderPlayers(players: PlayerInfo[], youId: string, hostId: string = '', phase: string = ''): void {
  $('players').innerHTML = players
    .map((p) => {
      const meClass = p.id === youId ? ' me' : '';
      const cls = ['p', p.connected ? '' : 'off', p.isDrawer ? 'drawer' : '', meClass].filter(Boolean).join(' ');
      const mark = p.answered ? ' ✎' : p.skipped ? ' ⏩' : '';
      const host = p.id === hostId ? '👑' : '';
      const score = phase !== 'lobby' ? ` ${p.score}` : '';
      return `<span class="${cls}">${host}${escape(p.name)}${score}${mark}</span>`;
    })
    .join('');
}

export function renderLobbyNote(
  players: PlayerInfo[],
  youId: string,
  hostId: string,
  minPlayers: number,
): void {
  const connectedCount = players.filter((p) => p.connected).length;
  const isHost = youId === hostId;

  if (connectedCount < minPlayers) {
    // 참가자 X/Y — Y명 더 모이면 시작할 수 있습니다
    const needMore = minPlayers - connectedCount;
    setTag('lobbyNote', `참가자 ${connectedCount}/${minPlayers} — ${needMore}명 더 모이면 시작할 수 있습니다`);
  } else if (isHost) {
    // 참가자 X/Y — 시작할 수 있습니다
    setTag('lobbyNote', `참가자 ${connectedCount}/${minPlayers} — 시작할 수 있습니다`);
  } else {
    // 참가자 X/Y — 방장이 시작하기를 기다립니다
    setTag('lobbyNote', `참가자 ${connectedCount}/${minPlayers} — 방장이 시작하기를 기다립니다`);
  }
}

/**
 * 힌트받기 옆 집계와, 내가 눌렀는지를 버튼 자체에 반영한다.
 *
 * 프로토콜에 새 필드를 추가하지 않는다 — room이 이미 실어 보내는 PlayerInfo만으로 계산된다.
 * 힌트받기를 누를 수 있는 사람(=서버가 정족수를 세는 대상)은 출제자가 아니고 접속 중인
 * 플레이어다(session.ts의 guessers()와 같은 조건). 그중 skipped가 true인 수를 세면 집계다.
 */
export function renderHintTally(players: PlayerInfo[], youId: string): void {
  const guessers = players.filter((p) => !p.isDrawer && p.connected);
  const pressed = guessers.filter((p) => p.skipped).length;
  setTag('hintTally', guessers.length > 0 ? `${pressed}/${guessers.length}명이 눌렀습니다` : '');

  const me = players.find((p) => p.id === youId);
  $('hintBtn').classList.toggle('pressed', me?.skipped === true);
}

let stopSpin: (() => void) | null = null;

export function renderSlices(
  slices: Array<{ id: string; strokes: Point[][]; shared: boolean }>,
  sliceCount: number,
): void {
  const box = $('sliceBox');
  box.innerHTML = '';
  for (const s of slices) {
    // 캔버스 하나만 덜렁 붙이면 내 조각과 공개된 조각이 구별 안 된다 — 감싸는 칸에
    // 라벨을 달아 "이건 나만 보는 것" / "이건 다 같이 본 것"을 글자로 못박는다.
    const wrap = document.createElement('div');
    wrap.className = s.shared ? 'slice shared' : 'slice mine';
    const c = document.createElement('canvas');
    wrap.appendChild(c);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = s.shared ? '모두 공개' : '내 조각';
    wrap.appendChild(tag);
    box.appendChild(wrap);
    // 붙인 뒤에 그려야 clientWidth가 잡힌다
    drawSlice(c, s.strokes, sliceCount);
  }
  stopSpin?.();
  stopSpin = startSpinHint($('spinHint'), sliceCount);
}

export function stopSpinHint(): void {
  stopSpin?.();
  stopSpin = null;
}

export function renderAnswers(target: string, rows: AnswerRow[], names: Map<string, string>): void {
  $(target).innerHTML = rows
    .map((r) => `<li class="${r.correct ? 'ok' : ''}">${escape(names.get(r.playerId) ?? '?')} — ${escape(r.text || '(무응답)')}</li>`)
    .join('');
}

/**
 * 주제 고르기 버튼. 방장에게만 누를 수 있게 두고, 나머지에게는 무엇이 골라졌는지만 보여준다.
 * 남이 고른 것을 못 보면 "왜 계속 동물만 나오지?"가 된다.
 */
export function renderTopics(
  topics: string[],
  selected: string | null,
  isHost: boolean,
  onPick: (topic: string | null) => void,
): void {
  const box = $('topicBtns');
  box.innerHTML = '';
  // 주제 목록이 안 왔으면 조용히 비워둔다. 로비가 통째로 죽는 것보다 낫다.
  const opts: Array<{ label: string; value: string | null }> = [
    ...(topics ?? []).map((t) => ({ label: t, value: t as string | null })),
    { label: '랜덤', value: null },
  ];
  for (const o of opts) {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.className = o.value === selected ? 'on' : '';
    b.disabled = !isHost;
    b.addEventListener('click', () => onPick(o.value));
    box.appendChild(b);
  }
  $('topicNote').textContent = isHost
    ? '고른 주제로만 문제가 나옵니다. 랜덤이면 라운드마다 바뀝니다.'
    : `방장이 고른 주제: ${selected ?? '랜덤'}`;
}

export function renderRanking(rows: Array<{ playerId: string; name: string; score: number }>): void {
  $('ranking').innerHTML = rows
    .map((r, i) => `<li>${i + 1}. ${escape(r.name)} — ${r.score}점</li>`)
    .join('');
}

export function countdown(deadline: number | null): void {
  const tick = () => {
    if (deadline === null) { setTag('timeTag', ''); return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setTag('timeTag', `${left}초`);
  };
  tick();
  clearInterval(timer);
  if (deadline !== null) timer = window.setInterval(tick, 250);
}
let timer = 0;

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
