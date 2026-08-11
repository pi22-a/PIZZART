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

export function renderPlayers(players: PlayerInfo[], youId: string): void {
  $('players').innerHTML = players
    .map((p) => {
      const cls = ['p', p.connected ? '' : 'off', p.isDrawer ? 'drawer' : ''].join(' ');
      const mark = p.answered ? ' ✎' : p.skipped ? ' ⏩' : '';
      const me = p.id === youId ? '★' : '';
      return `<span class="${cls}">${me}${escape(p.name)} ${p.score}${mark}</span>`;
    })
    .join('');
}

let stopSpin: (() => void) | null = null;

export function renderSlices(
  slices: Array<{ id: string; strokes: Point[][]; shared: boolean }>,
  sliceCount: number,
): void {
  const box = $('sliceBox');
  box.innerHTML = '';
  for (const s of slices) {
    const c = document.createElement('canvas');
    if (s.shared) c.className = 'shared';
    box.appendChild(c);
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
