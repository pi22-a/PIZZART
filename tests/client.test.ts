// @vitest-environment jsdom
//
// 화면 쪽 수정(8·9)과 결과 화면 렌더링(4)을 실제 DOM 위에서 확인한다.
// index.html을 그대로 읽어 붙이므로, 버튼 id가 바뀌면 여기서 먼저 깨진다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join as pjoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';

const root = pjoin(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(pjoin(root, 'index.html'), 'utf8');
// #sliceBox 위쪽 여백(수정 2)은 CSS 문제라 <style>도 실제로 붙여야 getComputedStyle로 잴 수 있다.
const styleHtml = indexHtml.split('<style>')[1].split('</style>')[0];
const bodyHtml = indexHtml.split('<body>')[1].split('</body>')[0];

/** main.ts가 만드는 웹소켓을 가로챈다 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  out: ClientMsg[] = [];
  constructor(public url: string) { live = this; }
  send(raw: string): void { this.out.push(JSON.parse(raw) as ClientMsg); }
  addEventListener(): void {}
  close(): void {}
}
let live: FakeSocket;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function boot(): Promise<void> {
  vi.resetModules();
  if (!document.getElementById('test-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'test-style';
    styleEl.textContent = styleHtml;
    document.head.appendChild(styleEl);
  }
  document.body.innerHTML = bodyHtml;
  await import('../src/client/main');
  live.out = [];
}

function deliver(m: ServerMsg): void {
  live.onmessage?.({ data: JSON.stringify(m) });
}

const PLAYERS = [
  { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
  { id: 'd', name: '출제자', connected: true, score: 0, isDrawer: true, answered: false, skipped: false },
  { id: 'x', name: '친구', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
];

function room(over: Partial<Extract<ServerMsg, { t: 'room' }>> = {}): ServerMsg {
  return {
    t: 'room', phase: 'guessing', players: PLAYERS, hostId: 'd',
    round: 0, totalRounds: 3, topic: '동물', attempt: 1, maxAttempts: 3, deadline: null, minPlayers: 4,
    ...over,
  } as ServerMsg;
}

function slices(): ServerMsg {
  return { t: 'slices', count: 8, slices: [{ id: 'a', strokes: [[[500, 500], [600, 500]]], shared: false }] };
}

function slicesWithShared(): ServerMsg {
  return {
    t: 'slices',
    count: 8,
    slices: [
      { id: 'a', strokes: [[[500, 500], [600, 500]]], shared: false },
      { id: 'b', strokes: [[[500, 500], [600, 500]]], shared: true },
      { id: 'c', strokes: [[[500, 500], [600, 500]]], shared: true },
    ],
  };
}

/** 내 조각까지 받아 정상적으로 참여 중인 추론 화면 */
async function guessing(): Promise<void> {
  await boot();
  deliver({ t: 'joined', youId: 'me' });
  deliver(room());
  deliver(slices());
  live.out = [];
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom에는 캔버스 구현이 없다. 그리기 호출을 전부 삼키는 가짜 컨텍스트를 끼운다.
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  HTMLCanvasElement.prototype.getContext = () => ctx as never;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-cid' });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('넘기기가 적어둔 답을 버리지 않는다 (수정 8)', () => {
  it('넘기기를 누르면 답이 먼저 나간다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    // 디바운스 250ms가 아직 안 지났다 — 여기서 넘기기를 누르는 게 실제 상황이다
    $('hintBtn').click();

    const kinds = live.out.map((m) => m.t);
    expect(kinds).toContain('answer');
    expect(kinds.indexOf('answer')).toBeLessThan(kinds.indexOf('skip'));
    expect((live.out.find((m) => m.t === 'answer') as { text: string }).text).toBe('코끼리');
  });

  it('넘기기 뒤에 유령 답이 한 번 더 가지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('hintBtn').click();
    vi.advanceTimersByTime(1000);
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
  });

  it('엔터를 치면 답이 바로 나간다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '펭귄';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
    expect((live.out[0] as { text: string }).text).toBe('펭귄');
  });
});

describe('관전자에게 살아 있는 척하는 화면을 주지 않는다 (수정 9)', () => {
  it('조각을 못 받았으면 입력과 넘기기가 잠긴다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room()); // 조각은 오지 않는다 — 라운드 도중 합류자다
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
    expect($<HTMLButtonElement>('hintBtn').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
    expect($('spectateNote').textContent).toContain('관전');
  });

  it('조각을 받으면 입력이 열린다', async () => {
    await guessing();
    expect($<HTMLInputElement>('answerInput').disabled).toBe(false);
    expect($<HTMLButtonElement>('hintBtn').disabled).toBe(false);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(false);
    expect($('spectateNote').textContent).toBe('');
  });

  it('다음 라운드가 오면 관전 상태가 초기화된다', async () => {
    await guessing();
    deliver(room({ phase: 'drawing', round: 1 }));
    deliver(room({ phase: 'guessing', round: 1 }));
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true); // 아직 조각 전
    deliver(slices());
    expect($<HTMLInputElement>('answerInput').disabled).toBe(false);
  });
});

describe('결과 화면이 새로고침 뒤에도 답을 보여준다 (수정 4)', () => {
  const end = (): ServerMsg => ({
    t: 'roundEnd',
    word: '코끼리',
    drawing: [],
    sliceCount: 8,
    owners: [],
    scores: [
      { playerId: 'me', delta: 3, total: 3 },
      { playerId: 'd', delta: 1, total: 1 },
      { playerId: 'x', delta: 0, total: 0 },
    ],
    correct: ['me'],
    answers: [
      { playerId: 'me', text: '코끼리', correct: true },
      { playerId: 'x', text: '하마', correct: false },
    ],
  });

  it('attemptResult를 한 번도 못 봤어도 답이 그대로 뜬다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'roundEnd' })); // 새로고침 — 복구는 room과 roundEnd만 준다
    deliver(end());
    const html = $('revealAnswers').innerHTML;
    expect(html).toContain('코끼리');
    expect(html).toContain('하마');
    expect(html).not.toContain('(무응답)');
  });

  it('출제자 줄에는 점수만 나온다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'roundEnd' }));
    deliver(end());
    const items = [...$('revealAnswers').querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items.find((t) => t.startsWith('출제자'))).toContain('+1점');
  });
});

describe('한 판 더 버튼 (수정 2)', () => {
  it('최종 화면의 버튼이 again을 보낸다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'final' }));
    $('againBtn').click();
    expect(live.out.map((m) => m.t)).toContain('again');
  });

  it('방장이 아니어도 눌릴 수 있다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' }); // hostId는 'd'다
    deliver(room({ phase: 'final' }));
    expect($<HTMLButtonElement>('againBtn').disabled).toBe(false);
  });
});

describe('내 조각과 공개된 조각을 라벨로 구별한다 (버그 2)', () => {
  it('내 조각에는 "내 조각", 공개 조각에는 "모두 공개"가 붙는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room());
    deliver(slicesWithShared());

    const items = [...$('sliceBox').children] as HTMLElement[];
    expect(items.length).toBe(3);
    expect(items[0].classList.contains('mine')).toBe(true);
    expect(items[0].querySelector('.tag')?.textContent).toBe('내 조각');
    expect(items[1].classList.contains('shared')).toBe(true);
    expect(items[1].querySelector('.tag')?.textContent).toBe('모두 공개');
    expect(items[2].classList.contains('shared')).toBe(true);
  });
});

describe('플레이어 카드 렌더링', () => {
  it('로비에서는 점수가 숨겨진다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'lobby' }));
    const playersHtml = $('players').innerHTML;
    expect(playersHtml).not.toContain(' 0');
  });

  it('추론 단계에서는 점수가 보인다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'guessing' }));
    const playersHtml = $('players').innerHTML;
    expect(playersHtml).toContain(' 0');
  });

  it('내 카드에는 me 클래스가 붙는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room());
    const meCard = [...$('players').querySelectorAll('.p')].find((el) =>
      el.textContent?.includes('나'));
    expect(meCard?.classList.contains('me')).toBe(true);
  });

  it('다른 사람 카드에는 me 클래스가 없다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room());
    const otherCard = [...$('players').querySelectorAll('.p')].find((el) =>
      el.textContent?.includes('친구'));
    expect(otherCard?.classList.contains('me')).toBe(false);
  });

  it('별 문자는 더 이상 표시되지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room());
    const playersHtml = $('players').innerHTML;
    expect(playersHtml).not.toContain('★');
  });

  it('왕관 문자는 계속 표시된다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ hostId: 'me' }));
    const playersHtml = $('players').innerHTML;
    expect(playersHtml).toContain('👑');
  });
});

describe('로비 레이아웃 — 이름 블록과 저장 경로 (레이아웃 개선)', () => {
  it('이름 라벨, 저장 버튼, 엔터 힌트가 마크업에 존재한다', async () => {
    await boot();
    const label = document.querySelector('label[for="nameInput"]');
    expect(label?.textContent).toBe('이름');
    expect($('nameSaveBtn').textContent).toBe('저장');
    expect($('nameHint').textContent).toBe('엔터를 쳐도 저장됩니다 · 최대 12자');
  });

  it('저장 버튼 클릭이 join 메시지를 보낸다', async () => {
    await boot();
    const input = $<HTMLInputElement>('nameInput');
    input.value = '피자';
    $('nameSaveBtn').click();
    const joinMsg = live.out.find((m) => m.t === 'join') as { name: string } | undefined;
    expect(joinMsg?.name).toBe('피자');
  });

  it('엔터 keydown이 저장 버튼과 같은 join 메시지를 보낸다', async () => {
    await boot();
    const input = $<HTMLInputElement>('nameInput');
    input.value = '피자';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const joinMsg = live.out.find((m) => m.t === 'join') as { name: string } | undefined;
    expect(joinMsg?.name).toBe('피자');
  });

  it('change(포커스 이탈)도 같은 join 메시지를 보낸다 — 세 경로가 일치해야 한다', async () => {
    await boot();
    const input = $<HTMLInputElement>('nameInput');
    input.value = '피자';
    input.dispatchEvent(new Event('change'));
    const joinMsg = live.out.find((m) => m.t === 'join') as { name: string } | undefined;
    expect(joinMsg?.name).toBe('피자');
  });

  it('빈 이름으로 저장하면 손님이 되지 않고 이전 이름을 유지한다', async () => {
    await boot();
    const input = $<HTMLInputElement>('nameInput');
    input.value = '피자';
    $('nameSaveBtn').click();
    live.out = [];

    input.value = '';
    $('nameSaveBtn').click();

    expect(live.out.some((m) => m.t === 'join')).toBe(false);
    expect(input.value).toBe('피자');
    expect($('nameHint').textContent).toContain('피자');
  });
});

describe('로비 카운트 라인', () => {
  it('참가자가 부족하면 더 필요한 인원을 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
      ],
      minPlayers: 4,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 2/4 — 2명 더 모이면 시작할 수 있습니다');
  });

  it('참가자가 충분하고 내가 방장이면 시작 가능 메시지를 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      hostId: 'me',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p3', name: '친구3', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p4', name: '친구4', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
      ],
      minPlayers: 4,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 4/4 — 시작할 수 있습니다');
  });

  it('참가자가 충분하지만 내가 방장이 아니면 대기 메시지를 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      hostId: 'd',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'd', name: '방장', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p3', name: '친구3', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p4', name: '친구4', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
      ],
      minPlayers: 4,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 4/4 — 방장이 시작하기를 기다립니다');
  });

  it('접속 해제된 참가자는 카운트에 포함되지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false },
        { id: 'p3', name: '친구3', connected: false, score: 0, isDrawer: false, answered: false, skipped: false },
      ],
      minPlayers: 4,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 2/4 — 2명 더 모이면 시작할 수 있습니다');
  });
});

describe('조각 액자가 인원 알약과 붙지 않는다 (Fix 2)', () => {
  it('.screen에 위쪽 여백이 생겨 #sliceBox가 인원 줄에서 떨어진다', async () => {
    await boot();
    // 인원 알약 줄(#players)은 .screen 바깥의 형제 요소라, .screen 자체의 margin-top이
    // 곧 "인원 줄 하단 ↔ 화면 내용 상단" 사이의 간격이다. 오너가 잰 실측(0px)이 재발하면
    // 여기서 바로 0px로 돌아와 잡힌다.
    const style = getComputedStyle($('s-guess'));
    expect(style.marginTop).not.toBe('0px');
    expect(style.marginTop).toBe('16px');
  });
});

describe('힌트받기 집계와 눌림 표시 (Fix 3)', () => {
  const withSkips = (skips: Record<string, boolean>) => room({
    players: PLAYERS.map((p) => ({ ...p, skipped: skips[p.id] ?? false })),
  });

  it('출제자를 뺀 접속 중 인원 기준으로 집계가 뜬다', async () => {
    await guessing();
    deliver(withSkips({ me: true }));
    // 게서는 me, x 둘뿐(d는 출제자라 제외) — 그중 1명이 눌렀다.
    expect($('hintTally').textContent).toBe('1/2명이 눌렀습니다');
  });

  it('전원이 누르면 2/2로 올라간다', async () => {
    await guessing();
    deliver(withSkips({ me: true, x: true }));
    expect($('hintTally').textContent).toBe('2/2명이 눌렀습니다');
  });

  it('내가 누른 상태가 버튼 자체에 pressed 클래스로 나타난다', async () => {
    await guessing();
    expect($('hintBtn').classList.contains('pressed')).toBe(false);
    deliver(withSkips({ me: true }));
    expect($('hintBtn').classList.contains('pressed')).toBe(true);
  });

  it('접속이 끊긴 사람은 집계 분모에서 빠진다', async () => {
    await guessing();
    deliver(room({
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: true },
        { id: 'd', name: '출제자', connected: true, score: 0, isDrawer: true, answered: false, skipped: false },
        { id: 'x', name: '친구', connected: false, score: 0, isDrawer: false, answered: false, skipped: false },
      ],
    }));
    expect($('hintTally').textContent).toBe('1/1명이 눌렀습니다');
  });
});

describe('답 제출 버튼과 저장 확인 (Fix 4)', () => {
  it('제출 버튼은 디바운스를 기다리지 않고 즉시 보낸다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
    expect((live.out[0] as { text: string }).text).toBe('코끼리');
  });

  it('제출하면 "제출됨" 확인이 뜬다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect($('answerSavedNote').textContent).toBe('제출됨 ✓');
  });

  it('엔터도 제출 버튼과 똑같이 확인을 켠다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '펭귄';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect($('answerSavedNote').textContent).toBe('제출됨 ✓');
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
  });

  it('디바운스로만 자동 저장됐을 때는 확인이 뜨지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(300);
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1); // 자동 저장 자체는 나갔다
    expect($('answerSavedNote').textContent).toBe(''); // 확인 표시는 명시적 제출에서만
  });

  it('제출 뒤 글자를 고치면 확인이 사라진다 — 화면이 거짓말하면 안 된다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect($('answerSavedNote').textContent).toBe('제출됨 ✓');

    input.value = '코끼리다';
    input.dispatchEvent(new Event('input'));
    expect($('answerSavedNote').textContent).toBe('');
  });

  it('새 시도가 시작되면 지난 시도의 확인 표시가 넘어오지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect($('answerSavedNote').textContent).toBe('제출됨 ✓');

    deliver(room({ attempt: 2 }));
    expect($('answerSavedNote').textContent).toBe('');
  });
});
