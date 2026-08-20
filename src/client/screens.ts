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
 * 라운드 스킵 옆 집계와, 내가 눌렀는지를 버튼 자체에 반영한다.
 *
 * 프로토콜에 새 필드를 추가하지 않는다 — room이 이미 실어 보내는 PlayerInfo만으로 계산된다.
 * 스킵을 누를 수 있는 사람(=서버가 정족수를 세는 대상)은 출제자가 아니고 접속 중인
 * 플레이어다(session.ts의 guessers()와 같은 조건). 그중 skipped가 true인 수를 세면 집계다.
 *
 * 이미 맞힌 사람은 서버가 기다리지 않으므로 분모에서 뺀다 — 안 빼면 3/4에서 영영
 * 멈춘 것처럼 보인다.
 */
export function renderSkipTally(players: PlayerInfo[], youId: string): void {
  // 조각을 못 받은 관전자는 스킵을 누를 수 없다 — 서버가 세지 않으므로 분모에서도 뺀다.
  const waiting = players.filter((p) => !p.isDrawer && p.connected && !p.solved && p.sliceCount > 0);
  const pressed = waiting.filter((p) => p.skipped).length;
  setTag('skipTally', waiting.length > 0 ? `${pressed}/${waiting.length}명이 스킵을 눌렀습니다` : '');

  const me = players.find((p) => p.id === youId);
  $('skipBtn').classList.toggle('pressed', me?.skipped === true);
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
  // 남은 초를 매 프레임 물어보게 넘긴다 — countdown이 갱신하는 값을 그대로 읽는다.
  stopSpin = startSpinHint($('spinHint'), sliceCount, () => secondsLeftNow);
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

/**
 * 남은 시간을 화면에 쓴다. 초가 실제로 바뀔 때만 onSecond를 부른다 —
 * 250ms마다 부르면 소리가 초당 네 번 난다.
 *
 * 같은 마감으로 다시 불려도(방 상태는 자주 온다) 이미 지나간 초를 다시 알리지 않는다.
 */
/** 지금 남은 초. 회전 안내 원이 매 프레임 읽어간다. 없으면 null. */
let secondsLeftNow: number | null = null;

export function countdown(deadline: number | null, onSecond?: (left: number) => void): void {
  if (deadline !== lastDeadline) {
    lastDeadline = deadline;
    lastLeft = -1;
  }
  const tick = () => {
    if (deadline === null) { setTag('timeTag', ''); secondsLeftNow = null; return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    secondsLeftNow = left;
    setTag('timeTag', `${left}초`);
    if (left !== lastLeft) {
      lastLeft = left;
      onSecond?.(left);
    }
  };
  tick();
  clearInterval(timer);
  if (deadline !== null) timer = window.setInterval(tick, 250);
}
let timer = 0;
let lastDeadline: number | null = null;
let lastLeft = -1;

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/**
 * 출제자·이미 맞힌 사람이 보는 현황판. 맞히는 사람마다 한 줄씩, 그 사람이 실제로
 * 보고 있는 조각을 그대로 그린다.
 *
 * 예전에는 모두의 조각을 원판 하나에 합쳐 보여줬다. 그러면 "그림의 절반이 나가 있다"는
 * 사실만 남고, 정작 재미있는 것 — 누가 어떤 조각 하나로 헤매고 있는지 — 이 사라진다.
 */
export function renderWatch(
  el: HTMLElement,
  watching: Array<{
    playerId: string;
    slices: Point[][][];
    solved: boolean;
    history: Array<{ attempt: number; text: string; skipped: boolean; correct: boolean }>;
  }>,
  sliceCount: number,
  names: Map<string, string>,
): void {
  el.innerHTML = '';
  for (const w of watching) {
    const row = document.createElement('div');
    row.className = w.solved ? 'watch-row done' : 'watch-row';

    const tag = document.createElement('div');
    tag.className = 'watch-name';
    tag.textContent = `${names.get(w.playerId) ?? '?'}${w.solved ? ' — 맞힘' : ` · ${w.slices.length}조각`}`;
    row.appendChild(tag);

    const strip = document.createElement('div');
    strip.className = 'watch-slices';
    row.appendChild(strip);

    // 회차마다 뭐라고 냈는지. 회차가 끝날 때만 쌓이므로 여기 보이는 것은 이미 지난 회차다.
    const log = document.createElement('div');
    log.className = 'watch-log';
    log.innerHTML = w.history.length === 0
      ? '<span class="watch-none">아직 없음</span>'
      : w.history.map((h) => {
          const what = h.skipped ? '스킵' : h.text ? escape(h.text) : '안 씀';
          const cls = h.correct ? 'ok' : h.skipped || !h.text ? 'none' : '';
          return `<span class="watch-item ${cls}"><b>${h.attempt}</b> ${what}</span>`;
        }).join('');
    row.appendChild(log);

    el.appendChild(row);

    // 붙인 뒤에 그려야 clientWidth가 잡힌다
    for (const strokes of w.slices) {
      const c = document.createElement('canvas');
      strip.appendChild(c);
      drawSlice(c, strokes, sliceCount);
    }
  }
}
