import type { Point } from '../shared/drawing';
import type { AnswerRow, ChatLine, PlayerInfo } from '../shared/protocol';
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

/**
 * 방금 방장이 된 사람. 다음 renderPlayers에서 그 알약을 한 번 빛나게 한다.
 * 한 번 쓰고 지운다 — 방 상태는 자주 오므로 안 지우면 계속 깜빡인다.
 */
let flashHostId = '';
export function flashHost(id: string): void { flashHostId = id; }

export function renderPlayers(players: PlayerInfo[], youId: string, hostId: string = '', phase: string = ''): void {
  $('players').innerHTML = players
    .map((p) => {
      const meClass = p.id === youId ? ' me' : '';
      const cls = ['p', p.connected ? '' : 'off', p.isDrawer ? 'drawer' : '',
                   p.spectator ? 'spectator' : '',
                   p.id === flashHostId ? 'justhost' : '', meClass].filter(Boolean).join(' ');
      const mark = p.answered ? ' ✎' : p.skipped ? ' ⏩' : '';
      const host = p.id === hostId ? '👑' : '';
      // 관전자는 점수가 없다. 0점을 붙이면 꼴찌로 읽힌다.
      const score = phase !== 'lobby' && !p.spectator ? ` ${p.score}` : '';
      const watch = p.spectator ? ' 👁' : '';
      return `<span class="${cls}" title="${p.spectator ? '관전 중 — 정답을 보고 있습니다' : ''}">`
        + `${host}${escape(p.name)}${score}${mark}${watch}</span>`;
    })
    .join('');
  flashHostId = '';
}

export function renderLobbyNote(
  players: PlayerInfo[],
  youId: string,
  hostId: string,
  minPlayers: number,
): void {
  // 관전자는 세지 않는다. 서버의 시작 정족수가 관전자를 빼고 세므로(session.ts의 start),
  // 여기서 같이 세면 "참가자 5/4 — 시작할 수 있습니다"라고 해놓고 시작이 거절된다.
  const playing = players.filter((p) => p.connected && !p.spectator).length;
  const watching = players.filter((p) => p.connected && p.spectator).length;
  const isHost = youId === hostId;
  // 다섯이 앉아 있는데 4/4라고 하면 틀려 보인다. 어디로 갔는지 적어준다.
  const aside = watching > 0 ? ` · 관전 ${watching}명` : '';

  if (playing < minPlayers) {
    const needMore = minPlayers - playing;
    setTag('lobbyNote', `참가자 ${playing}/${minPlayers}${aside} — ${needMore}명 더 모이면 시작할 수 있습니다`);
  } else if (isHost) {
    setTag('lobbyNote', `참가자 ${playing}/${minPlayers}${aside} — 시작할 수 있습니다`);
  } else {
    setTag('lobbyNote', `참가자 ${playing}/${minPlayers}${aside} — 방장이 시작하기를 기다립니다`);
  }
}

/**
 * 이번 회차를 몇 명이 마쳤는지와, 내가 스킵을 눌렀는지를 버튼 자체에 반영한다.
 *
 * 프로토콜에 새 필드를 추가하지 않는다 — room이 이미 실어 보내는 PlayerInfo만으로 계산된다.
 *
 * 분모는 서버가 기다리는 사람과 같아야 한다(session.ts의 maybeEndAttempt).
 * 조각을 못 받은 사람과 이미 맞힌 사람은 서버가 안 기다리므로 여기서도 뺀다.
 *
 * 분자는 예전에 스킵만 셌다. 그런데 서버는 "답을 냈거나 스킵을 누른" 사람을 똑같이
 * 마친 것으로 세므로, 2/3인데 나머지 하나가 이미 답을 냈으면 실제로는 3/3이고 회차는
 * 그 자리에서 끝났다 — 화면만 아직 한 명을 기다리는 것처럼 보였다.
 *
 * 빠진 사람 수도 같이 적는다. 방에 다섯이 앉아 있는데 분모가 3이면 숫자가 맞아도
 * 틀려 보이기 때문이다.
 */
export function renderSkipTally(players: PlayerInfo[], youId: string): void {
  const waiting = players.filter((p) => !p.isDrawer && p.connected && !p.solved && p.sliceCount > 0);
  const done = waiting.filter((p) => p.skipped || p.answered).length;
  const skipped = waiting.filter((p) => p.skipped).length;
  const answered = waiting.filter((p) => p.answered).length;

  const watchers = players.filter((p) => p.spectator && p.connected).length;
  const solved = players.filter((p) => !p.isDrawer && p.connected && p.solved).length;
  const extra = [
    solved > 0 ? `맞힘 ${solved}명` : '',
    watchers > 0 ? `관전 ${watchers}명` : '',
  ].filter(Boolean).join(' · ');

  const detail = [answered > 0 ? `답 ${answered}` : '', skipped > 0 ? `스킵 ${skipped}` : '']
    .filter(Boolean).join(' · ');

  setTag('skipTally', waiting.length === 0 ? '' :
    `${done}/${waiting.length}명이 이번 회차를 마쳤습니다`
    + (detail ? ` — ${detail}` : '')
    + (extra ? ` (${extra}은 세지 않습니다)` : ''));

  const me = players.find((p) => p.id === youId);
  $('skipBtn').classList.toggle('pressed', me?.skipped === true);
}

/** 라운드 진행도를 점으로. 숫자를 읽는 것보다 세는 것이 빠르다. */
export function renderRoundDots(round: number, total: number): void {
  const box = $('roundDots');
  if (total <= 0) { box.innerHTML = ''; box.removeAttribute('title'); return; }
  box.innerHTML = Array.from({ length: total }, (_, i) =>
    i <= round ? '●' : '<span class="off">○</span>').join('');
  box.title = `라운드 ${round + 1}/${total}`;
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

/**
 * 내 시계와 서버 시계의 차이. 남은 시간을 잴 때 빼준다.
 *
 * 이게 없으면 기기 시계가 어긋난 사람만 혼자 시간이 빨리 가서, 아직 시간이 남았는데
 * 화면에서는 0이 되고 답을 낼 기회를 잃는다. 실제로 겪은 일이다.
 */
let clockSkew = 0;
export function syncClock(serverNow: number): void {
  clockSkew = Date.now() - serverNow;
}

export function countdown(deadline: number | null, onSecond?: (left: number) => void): void {
  if (deadline !== lastDeadline) {
    lastDeadline = deadline;
    lastLeft = -1;
  }
  const tick = () => {
    if (deadline === null) { secondsLeftNow = null; return; }
    const left = Math.max(0, Math.ceil((deadline - (Date.now() - clockSkew)) / 1000));
    secondsLeftNow = left;
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

/**
 * 결과·최종 화면의 이야기판. 두 화면이 같은 로그를 그린다.
 *
 * 라운드가 바뀌는 자리에 구분선을 넣는다. 로그가 한 판 내내 이어지므로,
 * 최종 화면에서는 이 구분선이 그 판 전체를 되짚는 눈금이 된다.
 */
export function renderChat(boxId: string, lines: ChatLine[]): void {
  const box = $(boxId);
  if (lines.length === 0) {
    box.innerHTML = '<div class="empty">아직 아무도 말하지 않았습니다</div>';
    return;
  }
  // 바닥에 붙어 있었으면 새 줄이 와도 계속 바닥에 둔다. 위를 읽고 있었으면 건드리지 않는다.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;

  let lastRound = Number.NaN;
  const html: string[] = [];
  for (const l of lines) {
    if (l.round !== lastRound) {
      lastRound = l.round;
      const label = l.round < 0 ? '최종' : `라운드 ${l.round + 1}${l.word ? ` · ${escape(l.word)}` : ''}`;
      html.push(`<div class="sep">${label}</div>`);
    }
    html.push(`<div><span class="who" style="color:${escape(l.color)}">${escape(l.name)}</span>${escape(l.text)}</div>`);
  }
  box.innerHTML = html.join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/**
 * 작은 팝업. 몇 초 뒤 스스로 사라지고, 클릭을 통과시켜 아무것도 막지 않는다.
 *
 * 소리는 내지 않는다. 이 게임은 대개 통화를 켜고 하므로 남의 방에서 갑자기
 * 소리가 나면 곤란하다 — 초읽기 소리에 끄는 스위치를 달아둔 것과 같은 이유다.
 */
let toastTimer = 0;
export function toast(html: string, ms = 5000): void {
  const box = $('toast');
  box.innerHTML = html;
  box.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.remove('on'), ms);
}
