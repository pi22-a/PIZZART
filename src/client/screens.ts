import type { Point } from '../shared/drawing';
import type { AnswerRow, ChatLine, PlayerInfo, RoomInfo } from '../shared/protocol';
import { drawSlice, startSpinHint } from './slice-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SCREENS = ['enter', 'rooms', 'lobby', 'draw', 'wait', 'guess', 'round', 'final'] as const;
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

/** 방장이 볼 때만 강퇴 버튼을 붙인다. 누른 사람을 알려주는 것은 부르는 쪽이 맡는다. */
let onKick: ((playerId: string) => void) | null = null;
export function setKickHandler(fn: (playerId: string) => void): void { onKick = fn; }

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
      // 방장에게만, 자기 자신 말고. 강퇴는 방장 전권이다.
      const kick = onKick && youId === hostId && p.id !== youId
        ? `<button class="kick" data-kick="${p.id}" title="${escape(p.name)} 내보내기">✕</button>`
        : '';
      return `<span class="${cls}" title="${p.spectator ? '관전 중 — 정답을 보고 있습니다' : ''}">`
        + `${host}${escape(p.name)}${score}${mark}${watch}${kick}</span>`;
    })
    .join('');
  flashHostId = '';

  if (onKick) {
    for (const el of $('players').querySelectorAll('[data-kick]')) {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.kick!;
        const who = players.find((p) => p.id === id)?.name ?? '';
        // 되돌릴 수 없는 일이다. 그 방에 다시 못 들어오고, 방이 잠긴다.
        if (confirm(`${who} 님을 내보낼까요?\n\n이 방에 다시 들어올 수 없게 되고, 새 사람의 입장도 잠깁니다.`)) {
          onKick?.(id);
        }
      });
    }
  }
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

  // 'N/4'로 적지 않는다. 분수로 보이면 4가 정원처럼 읽혀서 다섯 명, 여섯 명은
  // 안 되는 줄 안다. 4는 하한이지 상한이 아니다(상한은 maxPlayers다).
  if (playing < minPlayers) {
    const needMore = minPlayers - playing;
    setTag('lobbyNote',
      `참가자 ${playing}명${aside} — 최소 ${minPlayers}명이 모여야 시작할 수 있습니다 (${needMore}명 더)`);
  } else if (isHost) {
    setTag('lobbyNote', `참가자 ${playing}명${aside} — 시작할 수 있습니다`);
  } else {
    setTag('lobbyNote', `참가자 ${playing}명${aside} — 방장이 시작하기를 기다립니다`);
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
 * 주제 고르기. 방장에게만 누를 수 있게 두고, 나머지에게는 무엇이 골라졌는지만 보여준다.
 * 남이 고른 것을 못 보면 "왜 계속 동물만 나오지?"가 된다.
 *
 * 여러 개를 고를 수 있다. 맨 앞의 `전체`는 고른 것을 지우는 버튼이다 —
 * 아무것도 안 고른 상태가 곧 전체이므로 따로 둘 필요가 없다.
 */
export function renderTopics(
  topics: string[],
  selected: string[],
  isHost: boolean,
  onPick: (topics: string[]) => void,
): void {
  const box = $('topicBtns');
  box.innerHTML = '';
  // 주제 목록이 안 왔으면 조용히 비워둔다. 로비가 통째로 죽는 것보다 낫다.
  const list = topics ?? [];
  const picked = new Set(selected ?? []);

  const all = document.createElement('button');
  all.textContent = '전체';
  all.className = picked.size === 0 ? 'on' : '';
  all.disabled = !isHost;
  all.addEventListener('click', () => onPick([]));
  box.appendChild(all);

  for (const t of list) {
    const b = document.createElement('button');
    b.textContent = t;
    b.className = picked.has(t) ? 'on' : '';
    b.disabled = !isHost;
    b.addEventListener('click', () => {
      // 누른 것을 넣거나 뺀다. 전부 빼면 저절로 전체가 된다.
      const next = new Set(picked);
      if (next.has(t)) next.delete(t); else next.add(t);
      onPick([...next]);
    });
    box.appendChild(b);
  }

  const names = [...picked].join(' · ');
  $('topicNote').textContent = isHost
    ? (picked.size === 0
        ? '전체 — 모든 주제에서 나옵니다. 눌러서 원하는 것만 고를 수 있습니다.'
        : `고른 ${picked.size}개에서만 나옵니다: ${names}`)
    : (picked.size === 0 ? '방장이 고른 주제: 전체' : `방장이 고른 주제: ${names}`);
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
  // 화면이 숨겨져 있으면 높이가 전부 0이라 "바닥"으로 읽힌다 — 그 편이 맞다.
  // 다시 보일 때 최신 줄이 보여야 하기 때문이다(scrollChatToBottom).
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

/**
 * 이야기판을 바닥으로 붙인다. 결과·최종 화면이 다시 뜰 때 부른다.
 *
 * 화면 전환은 display:none으로 하는데, 그 사이 브라우저가 스크롤 위치를 0으로 되돌린다.
 * 그래서 라운드가 하나 끝날 때마다 이야기판이 맨 위(제일 오래된 줄)로 올라가 있었다 —
 * 줄이 쌓일수록 방금 나눈 말이 화면 밖으로 밀려났다.
 *
 * 다시 그리는 것으로는 못 고친다. 화면이 뜨는 시점에는 새 줄이 없어서 renderChat이
 * 아예 안 불리기 때문이다.
 */
export function scrollChatToBottom(boxId: string): void {
  const box = $(boxId);
  box.scrollTop = box.scrollHeight;
}

/**
 * 로비의 방 목록.
 *
 * 게임 중인 방도 보여준다. 관전이 있는 게임이라 들어갈 데가 있고, 감추면 친구가 어느 방에
 * 있는지 알 방법이 없다. 대신 들어가면 관전이 된다는 것을 줄에 적어둔다.
 */
export function renderRooms(rooms: RoomInfo[], onEnter: (code: string) => void): void {
  const box = $('roomList');
  box.innerHTML = '';
  if (rooms.length === 0) {
    box.innerHTML = '<li class="empty">아직 방이 없습니다 — 위에서 하나 만들어 보세요</li>';
    return;
  }
  for (const r of rooms) {
    const playing = r.phase !== 'lobby';
    const li = document.createElement('li');
    const state = playing
      ? `<span class="r-state play">게임 중 · 라운드 ${r.round + 1}/${r.totalRounds}</span>`
      : '<span class="r-state">대기 중</span>';
    li.innerHTML = `
      <span class="r-name">${escape(r.name)}</span>
      ${state}
      <span class="r-meta">${r.count}/${r.max}명${r.locked ? ' · 🔒 입장 잠김' : ''}</span>`;
    const go = document.createElement('button');
    go.className = 'r-go';
    // 들어가면 무엇이 되는지 버튼에 적는다. 게임 중인 방은 관전으로만 들어갈 수 있다.
    go.textContent = playing ? '관전으로 입장' : '입장';
    go.disabled = r.locked || r.count >= r.max;
    if (go.disabled) go.title = r.locked ? '방장이 입장을 막아두었습니다' : '방이 가득 찼습니다';
    go.addEventListener('click', () => onEnter(r.code));
    li.appendChild(go);
    box.appendChild(li);
  }
}
