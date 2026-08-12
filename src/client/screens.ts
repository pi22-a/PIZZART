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
