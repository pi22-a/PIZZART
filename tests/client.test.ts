// @vitest-environment jsdom
//
// 화면 쪽 수정(8·9)과 결과 화면 렌더링(4)을 실제 DOM 위에서 확인한다.
// index.html을 그대로 읽어 붙이므로, 버튼 id가 바뀌면 여기서 먼저 깨진다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join as pjoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatLine, ClientMsg, ServerMsg } from '../src/shared/protocol';

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
  /** 등록된 이벤트 처리기. 재연결을 흉내 내려면 실제로 불러줄 수 있어야 한다. */
  private handlers: Record<string, Array<() => void>> = {};
  constructor(public url: string) { live = this; sockets.push(this); }
  send(raw: string): void { this.out.push(JSON.parse(raw) as ClientMsg); }
  addEventListener(type: string, fn: () => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  fire(type: string): void { for (const f of this.handlers[type] ?? []) f(); }
  /** 서버가 끊긴 상황. Net이 다시 붙기 시작해야 한다. */
  drop(): void { this.readyState = FakeSocket.CLOSED; this.fire('close'); }
  close(): void { this.readyState = FakeSocket.CLOSED; }
}
let live: FakeSocket;
let sockets: FakeSocket[] = [];

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
  { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
  { id: 'd', name: '출제자', connected: true, score: 0, isDrawer: true, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
  { id: 'x', name: '친구', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
];

function room(over: Partial<Extract<ServerMsg, { t: 'room' }>> = {}): ServerMsg {
  return {
    t: 'room', phase: 'guessing', players: PLAYERS, hostId: 'd',
    round: 0, totalRounds: 3, topic: '동물', attempt: 1, maxAttempts: 3, deadline: null, minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false,
    ...over,
  } as ServerMsg;
}

function slices(): ServerMsg {
  return { t: 'slices', count: 8, slices: [{ id: 'a', strokes: [{ points: [[500, 500], [600, 500]], color: '#1f1b17' }], shared: false }] };
}

function slicesWithShared(): ServerMsg {
  return {
    t: 'slices',
    count: 8,
    slices: [
      { id: 'a', strokes: [{ points: [[500, 500], [600, 500]], color: '#1f1b17' }], shared: false },
      { id: 'b', strokes: [{ points: [[500, 500], [600, 500]], color: '#1f1b17' }], shared: true },
      { id: 'c', strokes: [{ points: [[500, 500], [600, 500]], color: '#1f1b17' }], shared: true },
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
  // 이름과 자리 식별자가 localStorage에 남는다. 안 비우면 앞 테스트가 정한 이름을 들고
  // 다음 테스트가 시작해서, 이름 화면을 건너뛰어 버린다.
  try { localStorage.clear(); } catch { /* 무시 */ }
  sockets = [];
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

// 스킵의 뜻이 뒤집혔다. 예전 넘기기는 적어둔 답을 먼저 밀어 보냈지만, 지금 스킵은
// "이번 회차는 접는다"는 선언이라 답이 나가면 안 된다 — 나가면 오답으로 점수를 잃는다.
describe('스킵은 적어둔 답을 버린다 (점수 손실 방지)', () => {
  it('스킵을 누르면 적어둔 답이 나가지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    // 디바운스 250ms가 아직 안 지났다 — 여기서 스킵을 누르는 게 실제 상황이다
    $('skipBtn').click();

    const kinds = live.out.map((m) => m.t);
    expect(kinds).toContain('skip');
    expect(kinds).not.toContain('answer');
  });

  it('스킵 뒤에 유령 답이 나중에 나가지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('skipBtn').click();
    vi.advanceTimersByTime(1000);
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(0);
  });

  it('스킵을 누른 사람은 입력과 제출이 잠긴다', async () => {
    await guessing();
    deliver(room({
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, skipped: true } : p)),
    }));
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(true);
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
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
    expect($('spectateNote').textContent).toContain('관전');
  });

  it('조각을 받으면 입력이 열린다', async () => {
    await guessing();
    expect($<HTMLInputElement>('answerInput').disabled).toBe(false);
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(false);
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
  it('방장이 아니면 한 판 더 버튼이 잠기고 누가 눌러야 하는지 알려준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'final', hostId: 'd' }));
    expect($<HTMLButtonElement>('againBtn').disabled).toBe(true);
    expect($('againNote').textContent).toContain('출제자');
  });

  it('방장이면 버튼이 열리고 again을 보낸다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'final', hostId: 'me' }));
    expect($<HTMLButtonElement>('againBtn').disabled).toBe(false);
    expect($('againNote').textContent).toBe('');
    $('againBtn').click();
    expect(live.out.map((m) => m.t)).toContain('again');
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

describe('이름칸은 두 곳뿐이다', () => {
  it('방 대기 화면에는 따로 이름칸이 없다', async () => {
    // 로비가 생기기 전에는 여기가 이름을 정하는 유일한 자리였다. 이제 같은 일을 하는 칸이
    // 셋이 되면 한 곳을 고칠 때 나머지를 잊는다.
    await boot();
    expect(document.getElementById('nameInput')).toBeNull();
    expect(document.getElementById('nameSaveBtn')).toBeNull();
  });

  it('들어올 때 이름을 정하면 저장되고 방 목록으로 간다', async () => {
    await boot();
    expect($('s-enter').classList.contains('on')).toBe(true);
    $<HTMLInputElement>('enterName').value = '피자';
    $('enterBtn').click();
    expect($('s-rooms').classList.contains('on')).toBe(true);
    expect($('whoami').textContent).toBe('피자');
  });

  it('빈 이름으로는 넘어가지 않는다 — 손님 다섯 줄이 되면 누가 누군지 모른다', async () => {
    await boot();
    $<HTMLInputElement>('enterName').value = '   ';
    $('enterBtn').click();
    expect($('s-enter').classList.contains('on')).toBe(true);
    expect($('enterHint').textContent).toContain('비워둘 수 없습니다');
  });

  it('방 안에서는 대기 중일 때 이름칸이 열린다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, canRename: true } : p)),
    }));
    expect($('renameBar').style.display).not.toBe('none');
    // 대기 중에는 굳이 설명을 붙이지 않는다 — 새로 온 사람에게만 하는 말이다.
    expect($('lateNameNote').textContent).toBe('');
  });
});

describe('로비 카운트 라인', () => {
  it('참가자가 부족하면 더 필요한 인원을 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
      ],
      minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 2명 — 최소 4명이 모여야 시작할 수 있습니다 (2명 더)');
  });

  it('참가자가 충분하고 내가 방장이면 시작 가능 메시지를 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      hostId: 'me',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p3', name: '친구3', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p4', name: '친구4', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
      ],
      minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 4명 — 시작할 수 있습니다');
  });

  it('참가자가 충분하지만 내가 방장이 아니면 대기 메시지를 보여준다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      hostId: 'd',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'd', name: '방장', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p3', name: '친구3', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p4', name: '친구4', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
      ],
      minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 4명 — 방장이 시작하기를 기다립니다');
  });

  it('접속 해제된 참가자는 카운트에 포함되지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: [
        { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p2', name: '친구2', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'p3', name: '친구3', connected: false, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
      ],
      minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false,
    }));
    expect($('lobbyNote').textContent).toBe('참가자 2명 — 최소 4명이 모여야 시작할 수 있습니다 (2명 더)');
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

describe('초읽기 소리', () => {
  afterEach(() => localStorage.clear());

  it('음소거 버튼이 아이콘과 저장된 설정을 함께 바꾼다', async () => {
    await boot();
    const btn = $<HTMLButtonElement>('muteBtn');
    expect(btn.textContent).toBe('🔊');
    btn.click();
    expect(btn.textContent).toBe('🔇');
    expect(localStorage.getItem('pizza-muted')).toBe('1');
  });

  it('껐던 설정은 새로고침해도 유지된다', async () => {
    localStorage.setItem('pizza-muted', '1');
    await boot();
    expect($<HTMLButtonElement>('muteBtn').textContent).toBe('🔇');
  });

  it('초읽기 콜백은 초가 바뀔 때만 온다 — 안 그러면 초당 네 번 울린다', async () => {
    const { countdown } = await import('../src/client/screens');
    const seen: number[] = [];
    countdown(Date.now() + 3000, (l) => seen.push(l));
    vi.advanceTimersByTime(3000);
    countdown(null);
    expect(seen).toEqual([3, 2, 1, 0]);
  });

  it('AudioContext가 없는 환경에서도 조용히 넘어간다', async () => {
    const { timeTick, setMuted } = await import('../src/client/sound');
    expect(() => timeTick(3)).not.toThrow();
    expect(() => setMuted(true)).not.toThrow();
  });
});

describe('라운드 스킵 집계와 눌림 표시 (Fix 3)', () => {
  const withSkips = (skips: Record<string, boolean>) => room({
    players: PLAYERS.map((p) => ({ ...p, skipped: skips[p.id] ?? false })),
  });

  it('출제자를 뺀 접속 중 인원 기준으로 집계가 뜬다', async () => {
    await guessing();
    deliver(withSkips({ me: true }));
    // 게서는 me, x 둘뿐(d는 출제자라 제외) — 그중 1명이 눌렀다.
    expect($('skipTally').textContent).toBe('1/2명이 이번 회차를 마쳤습니다 — 스킵 1');
  });

  it('전원이 누르면 2/2로 올라간다', async () => {
    await guessing();
    deliver(withSkips({ me: true, x: true }));
    expect($('skipTally').textContent).toBe('2/2명이 이번 회차를 마쳤습니다 — 스킵 2');
  });

  it('내가 누른 상태가 버튼 자체에 pressed 클래스로 나타난다', async () => {
    await guessing();
    expect($('skipBtn').classList.contains('pressed')).toBe(false);
    deliver(withSkips({ me: true }));
    expect($('skipBtn').classList.contains('pressed')).toBe(true);
  });

  it('접속이 끊긴 사람은 집계 분모에서 빠진다', async () => {
    await guessing();
    deliver(room({
      players: [
 { id: 'me', name: '나', connected: true, score: 0, isDrawer: false, answered: false, skipped: true, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'd', name: '출제자', connected: true, score: 0, isDrawer: true, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
        { id: 'x', name: '친구', connected: false, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 1, pendingScore: 10, doodleColor: '', spectator: false, canRename: false },
      ],
    }));
    expect($('skipTally').textContent).toBe('1/1명이 이번 회차를 마쳤습니다 — 스킵 1');
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
    expect($('answerSavedNote').textContent).toContain('제출됨 ✓');
  });

  it('엔터도 제출 버튼과 똑같이 확인을 켠다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '펭귄';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect($('answerSavedNote').textContent).toContain('제출됨 ✓');
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
  });

  it('치기만 해서는 제출되지 않는다', async () => {
    // 예전에는 250ms마다 자동으로 보냈다. 그래서 "고양"까지 치다가 회차가 끝나면
    // 그게 오답 제출로 채점돼 1점이 깎였다 — 낼 생각도 없던 답이었는데.
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(1000);
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(0);
    expect($('answerSavedNote').textContent).toContain('아직 제출 안 함');
  });

  it('제출 뒤 글자를 고치면 확인이 사라진다 — 화면이 거짓말하면 안 된다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect($('answerSavedNote').textContent).toContain('제출됨 ✓');

    input.value = '코끼리다';
    input.dispatchEvent(new Event('input'));
    expect($('answerSavedNote').textContent).toContain('아직 제출 안 함');
  });

  it('새 회차가 시작되면 지난 회차의 확인 표시가 넘어오지 않는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼리';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    expect($('answerSavedNote').textContent).toContain('제출됨 ✓');

    deliver(room({ attempt: 2 }));
    expect($('answerSavedNote').textContent).not.toBe('제출됨 ✓');
  });

  it('회차가 넘어가도 쓰던 글자가 지워지지 않는다', async () => {
    // 치는 도중에 회차가 넘어가면 글자가 사라져 처음부터 다시 쳐야 했다.
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '코끼';
    input.dispatchEvent(new Event('input'));

    deliver(room({ attempt: 2 }));
    expect(input.value).toBe('코끼');
    expect($('answerSavedNote').textContent).toContain('아직 제출 안 함');
  });
});

describe('그린 획이 서버까지 간다', () => {
  // 실제로 브라우저에서 그려보니 그림이 통째로 사라졌다. 원인은 50ms 배치였다 —
  // 사람이 천천히 그으면 점 사이 간격이 50ms를 넘어 점 하나짜리 stroke 메시지가 나가고,
  // 서버는 점이 둘 미만인 획을 버린다. 봇은 완성된 획을 직접 보내서 여태 안 걸렸다.
  it('서버는 점이 하나뿐인 획을 버린다', async () => {
    const { Session } = await import('../src/server/session');
    const s = new Session(() => {}, {
      scheduler: { after: () => () => {} },
      rules: { ...TEST_RULES_CLIENT },
    });
    for (const n of ['a', 'b', 'c', 'd']) s.join(n, n);
    s.start('a');
    s.addStroke(s.drawerId, [[500, 500]]);
    expect(s.strokeCount).toBe(0);
  });

  it('점이 둘 이상인 획은 받는다 — 클라이언트는 획을 통째로 보내야 한다', async () => {
    const { Session } = await import('../src/server/session');
    const s = new Session(() => {}, {
      scheduler: { after: () => () => {} },
      rules: { ...TEST_RULES_CLIENT },
    });
    for (const n of ['a', 'b', 'c', 'd']) s.join(n, n);
    s.start('a');
    s.addStroke(s.drawerId, [[500, 500], [600, 520], [640, 610]]);
    expect(s.strokeCount).toBe(1);
  });
});

const TEST_RULES_CLIENT = {
  minPlayers: 4, topics: ['동물', '음식', '물건'], selectedTopics: [],
    roomName: '테스트 방', roomCode: 'TEST', locked: false, maxPlayers: 9, sliceCountMin: 8,
  drawSeconds: 60, guessSeconds: 30, roundEndSeconds: 0,
  maxAttempts: 6, maxSlices: 5,
  startScore: 10, wrongSubmitCost: 1, attemptCost: 1, finalAttemptScore: 1, drawerScore: 5, wordRerolls: 2,
};

describe('새 라운드가 지난 라운드 조립판을 덮어쓴다 (버그: 직전 출제자만 새 그림이 보인다)', () => {
  const assembled = (): ServerMsg => ({
    t: 'assembled', sliceCount: 8,
    pieces: [{ index: 0, strokes: [{ points: [[500, 500], [600, 500]], color: '#1f1b17' }] }],
  });

  it('조립판을 본 뒤 새 라운드 조각을 받으면 조각칸이 돌아온다', async () => {
    await guessing();
    deliver(assembled());
    expect($('sliceBox').style.display).toBe('none');
    expect($('assembledWrap').style.display).toBe('');

    // 다음 라운드가 시작되면 조각이 새로 온다. 여기서 안 되돌리면 지난 그림이 남는다.
    deliver(room({ round: 1 }));
    deliver(slices());
    expect($('assembledWrap').style.display).toBe('none');
    expect($('sliceBox').style.display).not.toBe('none');
    expect($('sliceBox').children.length).toBe(1);
  });

  it('마지막 회차에는 조립판이 이긴다 — 서버가 조각 다음에 조립판을 보내기 때문이다', async () => {
    await guessing();
    deliver(slices());
    deliver(assembled());
    expect($('sliceBox').style.display).toBe('none');
    expect($('assembledWrap').style.display).toBe('');
  });
});

describe('제출과 스킵은 서로를 잠근다', () => {
  const answered = (over = {}) => room({
    players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, answered: true } : p)),
    ...over,
  });

  it('답을 내면 스킵이 잠긴다 — 스킵은 낸 답을 지우기 때문이다', async () => {
    await guessing();
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(false);
    deliver(answered());
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(true);
  });

  it('스킵이 잠긴 이유를 그 자리에 적는다', async () => {
    await guessing();
    deliver(answered());
    expect($('skipLocked').textContent).toContain('답을 냈습니다');
    expect($('skipNote').style.display).toBe('none');
  });

  it('답을 내도 입력칸과 제출은 열려 있다 — 고쳐 내는 것은 손해가 아니다', async () => {
    await guessing();
    deliver(answered());
    expect($<HTMLInputElement>('answerInput').disabled).toBe(false);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(false);
  });

  it('스킵을 누르면 입력칸과 제출이 잠긴다', async () => {
    await guessing();
    deliver(room({
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, skipped: true } : p)),
    }));
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
  });
});

describe('낸 답만 지운다', () => {
  it('제출한 뒤 회차가 넘어가면 입력칸을 비우고 지난 답을 알려준다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '고양이';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();

    deliver(room({ attempt: 2 }));
    deliver(slices());
    expect(input.value).toBe('');
    expect($('prevAnswer').textContent).toBe('지난 회차에 낸 답: 고양이');
  });

  it('제출하지 않은 글자는 회차가 넘어가도 남는다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '고양';
    input.dispatchEvent(new Event('input'));

    deliver(room({ attempt: 2 }));
    deliver(slices());
    expect(input.value).toBe('고양');
    expect($('prevAnswer').textContent).toBe('');
  });

  it('라운드가 바뀌면 지난 답 기억도 지운다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '고양이';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();
    deliver(room({ attempt: 2 }));
    expect($('prevAnswer').textContent).toContain('고양이');

    deliver(room({ round: 1, attempt: 1 }));
    deliver(slices());
    expect($('prevAnswer').textContent).toBe('');
    expect(input.value).toBe('');
  });
});

describe('상단바는 조용해야 한다', () => {
  it('붙어 있을 때는 연결 상태를 알리지 않는다', async () => {
    await guessing();
    expect($('netTag').textContent).toBe('');
  });

  it('방 코드는 상단바가 아니라 방 표시줄에만 있다', async () => {
    // 두 군데 적으면 같은 코드가 화면에 두 번 나온다.
    await boot();
    expect(document.getElementById('roomTag')).toBeNull();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'lobby' }));
    expect($('roomNameTag').textContent).toContain('TEST');
  });

  it('라운드는 점으로 센다', async () => {
    await guessing();
    deliver(room({ round: 1, totalRounds: 4 }));
    expect($('roundDots').textContent).toBe('●●○○');
    expect($('roundDots').title).toBe('라운드 2/4');
  });

  it('주제는 상단이 아니라 맞히는 화면에 있다', async () => {
    await guessing();
    expect($('guessTopic').textContent).toBe('동물');
  });
});

describe('로비 인원은 관전자를 빼고 센다', () => {
  it('관전자는 참가자 수에 안 들어가고, 몇 명이 관전 중인지는 따로 적는다', async () => {
    // 같이 세면 인원이 찼다고 해놓고 서버가 시작을 거절한다.
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby', hostId: 'me', minPlayers: 4,
      players: [
        ...PLAYERS.map((p) => ({ ...p, isDrawer: false })),
        { id: 'w', name: '구경꾼', connected: true, score: 0, isDrawer: false, answered: false, skipped: false, solved: false, sliceCount: 0, pendingScore: 0, doodleColor: '', spectator: true, canRename: false },
      ],
    }));
    expect($('lobbyNote').textContent).toBe('참가자 3명 · 관전 1명 — 최소 4명이 모여야 시작할 수 있습니다 (1명 더)');
  });
});

describe('이야기판', () => {
  const line = (over: Partial<ChatLine> = {}): ChatLine => ({
    id: Math.random().toString(36), by: 'x', name: '친구', color: '#6fb6e8',
    text: '아 그게 그거였어?', round: 0, word: '낙타', ...over,
  });

  it('아무도 안 썼으면 빈 상자 대신 한 줄을 둔다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chatLog', lines: [] });
    expect($('roundChatLog').textContent).toContain('아직 아무도 말하지 않았습니다');
  });

  it('결과 화면과 최종 화면이 같은 로그를 그린다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chat', line: line({ text: '낙타였구나' }) });
    expect($('roundChatLog').textContent).toContain('낙타였구나');
    expect($('finalChatLog').textContent).toContain('낙타였구나');
  });

  it('라운드가 바뀌는 자리에 구분선을 넣는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chatLog', lines: [
      line({ round: 0, word: '우산', text: '가' }),
      line({ round: 0, word: '우산', text: '나' }),
      line({ round: 1, word: '낙타', text: '다' }),
      line({ round: -1, word: '', text: '라' }),
    ] });
    const seps = [...$('roundChatLog').querySelectorAll('.sep')].map((e) => e.textContent);
    expect(seps).toEqual(['라운드 1 · 우산', '라운드 2 · 낙타', '최종']);
  });

  it('한 사람이 이어서 쓴 줄이 전부 남는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chat', line: line({ text: '한마디' }) });
    deliver({ t: 'chat', line: line({ text: '두마디' }) });
    deliver({ t: 'chat', line: line({ text: '세마디' }) });
    const log = $('roundChatLog').textContent ?? '';
    expect(log).toContain('한마디');
    expect(log).toContain('두마디');
    expect(log).toContain('세마디');
  });

  it('보내면 입력칸을 비운다 — 남아 있으면 또 보낸 줄 안다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    const box = $<HTMLInputElement>('roundChatInput');
    box.value = '재밌었다';
    $('roundChatSend').click();
    expect(live.out.filter((m) => m.t === 'chat').length).toBe(1);
    expect((live.out.at(-1) as { text: string }).text).toBe('재밌었다');
    expect(box.value).toBe('');
  });

  it('빈 칸으로는 보내지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    $<HTMLInputElement>('roundChatInput').value = '   ';
    $('roundChatSend').click();
    expect(live.out.filter((m) => m.t === 'chat').length).toBe(0);
  });

  it('이름과 글은 그대로 새어 나가지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chat', line: line({ name: '<img>', text: '<script>x</script>' }) });
    expect($('roundChatLog').querySelector('img')).toBeNull();
    expect($('roundChatLog').querySelector('script')).toBeNull();
    expect($('roundChatLog').textContent).toContain('<script>x</script>');
  });
});

describe('방장이 넘어오면 알린다', () => {
  const hosted = (hostId: string) => room({ phase: 'lobby', hostId });

  it('나에게 넘어오면 팝업과 왕관 강조가 뜬다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(hosted('d'));                       // 처음에는 남이 방장
    expect($('toast').classList.contains('on')).toBe(false);

    deliver(hosted('me'));                      // 넘어왔다
    expect($('toast').classList.contains('on')).toBe(true);
    expect($('toast').textContent).toContain('방장이 되었습니다');
    expect($('players').querySelector('.justhost')).not.toBeNull();
  });

  it('처음 들어와서 방장이 되는 것은 알리지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(hosted('me'));
    expect($('toast').classList.contains('on')).toBe(false);
  });

  it('남에게 넘어간 것은 알리지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(hosted('me'));
    deliver(hosted('d'));
    expect($('toast').classList.contains('on')).toBe(false);
  });

  it('방 상태가 또 와도 왕관 강조가 계속 깜빡이지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(hosted('d'));
    deliver(hosted('me'));
    expect($('players').querySelector('.justhost')).not.toBeNull();
    deliver(hosted('me'));                      // 같은 방장으로 한 번 더
    expect($('players').querySelector('.justhost')).toBeNull();
  });

  it('팝업은 스스로 사라진다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(hosted('d'));
    deliver(hosted('me'));
    expect($('toast').classList.contains('on')).toBe(true);
    vi.advanceTimersByTime(6000);
    expect($('toast').classList.contains('on')).toBe(false);
  });
});

describe('이야기판은 결과 화면이 다시 떠도 최신 줄을 보여준다', () => {
  /** jsdom에는 레이아웃이 없다. 넘치는 로그를 흉내 낸다. */
  function fakeOverflow(id: string, scrollHeight = 500, clientHeight = 132) {
    const box = $(id);
    Object.defineProperty(box, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: clientHeight, configurable: true });
    return box;
  }

  it('결과 화면이 뜨면 바닥으로 붙인다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'chat', line: {
      id: 'a', by: 'x', name: '친구', color: '#6fb6e8', text: '가', round: 0, word: '낙타',
    } });

    // 화면이 숨겨진 동안 브라우저가 스크롤을 0으로 되돌린 상태를 만든다
    const box = fakeOverflow('roundChatLog');
    box.scrollTop = 0;

    deliver(room({ phase: 'roundEnd' }));
    expect(box.scrollTop).toBe(500);
  });

  it('최종 화면도 마찬가지다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    const box = fakeOverflow('finalChatLog', 800);
    box.scrollTop = 0;

    deliver(room({ phase: 'final' }));
    expect(box.scrollTop).toBe(800);
  });

  it('바닥에 있을 때 새 줄이 오면 따라 내려간다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    const box = fakeOverflow('roundChatLog', 300);
    box.scrollTop = 300 - 132;   // 바닥

    deliver({ t: 'chat', line: {
      id: 'b', by: 'x', name: '친구', color: '#6fb6e8', text: '새 줄', round: 0, word: '낙타',
    } });
    expect(box.scrollTop).toBe(300);
  });

  it('위를 읽고 있으면 새 줄이 와도 끌어내리지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    const box = fakeOverflow('roundChatLog', 300);
    box.scrollTop = 0;           // 맨 위를 읽는 중

    deliver({ t: 'chat', line: {
      id: 'c', by: 'x', name: '친구', color: '#6fb6e8', text: '새 줄', round: 0, word: '낙타',
    } });
    expect(box.scrollTop).toBe(0);
  });
});

describe('한글 조합 중 엔터는 보내지 않는다', () => {
  const enter = (el: HTMLElement, isComposing: boolean) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true }));

  it('답 입력칸 — 조합 중이면 안 나간다', async () => {
    await guessing();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '고양';
    input.dispatchEvent(new Event('input'));
    enter(input, true);                       // 아직 '이'가 확정되기 전
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(0);

    input.value = '고양이';
    input.dispatchEvent(new Event('input'));
    enter(input, false);                      // 확정된 뒤
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(1);
    expect((live.out.at(-1) as { text: string }).text).toBe('고양이');
  });

  it('이야기칸 — 조합 중이면 안 나간다', async () => {
    await guessing();
    const box = $<HTMLInputElement>('roundChatInput');
    box.value = '다리';
    enter(box, true);
    expect(live.out.filter((m) => m.t === 'chat').length).toBe(0);
    enter(box, false);
    expect(live.out.filter((m) => m.t === 'chat').length).toBe(1);
    expect((live.out.at(-1) as { text: string }).text).toBe('다리');
  });
});

describe('관전자 화면', () => {
  const watching = (over = {}) => room({
    phase: 'drawing',
    players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, spectator: true } : p)),
    ...over,
  });

  it('관전 중 그리는 동안에는 전환 줄이 뜬다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(watching());
    expect($('watchBar').style.display).not.toBe('none');
  });

  it('맞히는 동안에는 전환 줄이 숨는다 — 볼 것이 하나뿐이다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(watching({ phase: 'guessing' }));
    expect($('watchBar').style.display).toBe('none');
  });

  it('낙서판으로 바꾸면 대기 화면이 뜨고 낙서판이 열린다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(watching());
    expect($('s-draw').classList.contains('on')).toBe(true);

    $('viewDoodleBtn').click();
    expect($('s-wait').classList.contains('on')).toBe(true);
    expect($('doodleWrap').style.display).not.toBe('none');
    // 볼 수는 있어도 그리지는 못한다
    expect($('doodleCanvas').classList.contains('watching')).toBe(true);

    $('viewDrawBtn').click();
    expect($('s-draw').classList.contains('on')).toBe(true);
  });

  it('관전자에게는 그리기 버튼이 안 보인다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(watching());
    expect($('doneBtn').style.display).toBe('none');
    expect($('rerollBtn').style.display).toBe('none');
    expect($('drawCanvas').classList.contains('watching')).toBe(true);
  });
});

describe('그리는 화면에도 주제가 있다', () => {
  it('출제자와 관전자 모두 주제를 본다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'drawing', topic: '동물' }));
    expect($('drawTopic').textContent).toBe('주제 동물');
  });
});

describe('제시어 바꾸기 버튼', () => {
  it('남은 횟수를 버튼에 적고, 다 쓰면 잠근다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'word', word: '낙타', rerollsLeft: 2 });
    expect($('rerollBtn').textContent).toBe('제시어 바꾸기 (2)');
    expect($<HTMLButtonElement>('rerollBtn').disabled).toBe(false);

    deliver({ t: 'word', word: '펭귄', rerollsLeft: 0 });
    expect($<HTMLButtonElement>('rerollBtn').disabled).toBe(true);
  });

  it('누르면 서버에 알린다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver({ t: 'word', word: '낙타', rerollsLeft: 2 });
    live.out = [];
    $('rerollBtn').click();
    expect(live.out.filter((m) => m.t === 'reroll').length).toBe(1);
  });
});

describe('도중에 들어온 사람 이름칸', () => {
  it('바꿀 수 있는 사람에게만 뜬다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'drawing' }));
    expect($('renameBar').style.display).toBe('none');

    deliver(room({
      phase: 'drawing',
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, canRename: true } : p)),
    }));
    expect($('renameBar').style.display).not.toBe('none');
  });

  it('저장하면 이름을 실어 보낸다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'drawing',
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, canRename: true } : p)),
    }));
    $<HTMLInputElement>('lateNameInput').value = '늦둥이';
    live.out = [];
    $('lateNameBtn').click();
    const sentJoin = live.out.find((m) => m.t === 'join') as { name: string } | undefined;
    expect(sentJoin?.name).toBe('늦둥이');
  });
});

describe('방 대기 화면은 방에 대한 것만 보여준다', () => {
  it('PIZZA 제목과 소개문은 이름 화면에만 있다', async () => {
    // 로비로 들어올 때 이미 읽은 것이다. 방 안에서 또 나오면 주제와 시작 버튼이
    // 그만큼 아래로 밀린다.
    await boot();
    const lobby = $('s-lobby');
    expect(lobby.querySelector('h1')).toBeNull();
    expect($('s-enter').querySelector('h1')?.textContent).toContain('P I Z Z A');
  });

  it('주제와 시작이 게임 방법보다 먼저 온다', async () => {
    await boot();
    const kids = [...$('s-lobby').children];
    const topic = kids.findIndex((e) => e.id === 'topicPick');
    const start = kids.findIndex((e) => e.classList.contains('lobby-start'));
    const rules = kids.findIndex((e) => e.id === 'rules');
    expect(topic).toBeGreaterThanOrEqual(0);
    expect(rules).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(topic);
  });
});

describe('방 목록 새로고침', () => {
  it('붙어 있으면 목록을 다시 달라고 한다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    live.out = [];
    $('refreshRoomsBtn').click();
    expect(live.out.filter((m) => m.t === 'rooms').length).toBe(1);
  });

  it('눌린 티를 낸다 — 목록이 그대로면 아무 일도 없어 보인다', async () => {
    await boot();
    const before = $('roomsNote').textContent;
    $('refreshRoomsBtn').click();
    expect($('roomsNote').textContent).toContain('다시 받았습니다');
    vi.advanceTimersByTime(2000);
    expect($('roomsNote').textContent).toBe(before);
  });
});

describe('방 목록 새로고침 — 끊겼을 때', () => {
  it('끊긴 소켓으로는 보내지 않는다', async () => {
    // 끊긴 채로 보내면 조용히 사라진다. 화면에는 마지막 목록이 그대로 남아 있어서
    // 멀쩡해 보이는데 실제로는 아무것도 안 온다 — 그래서 이때는 페이지를 새로 연다.
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    live.readyState = FakeSocket.CLOSED;
    live.out = [];
    let reloaded = false;
    const reload = () => { reloaded = true; };
    // jsdom의 location.reload는 그냥 부르면 "구현 안 됨" 오류를 낸다. 갈아 끼운다.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, search: '', pathname: '/', hostname: 'localhost' },
    });

    $('refreshRoomsBtn').click();
    expect(live.out.filter((m) => m.t === 'rooms').length).toBe(0);
    expect(reloaded).toBe(true);
  });
});

describe('주제는 여러 개 고른다', () => {
  const lobby = (over = {}) => room({
    phase: 'lobby', hostId: 'me',
    topics: ['동물', '음식', '도구'], selectedTopics: [], ...over,
  });
  const btns = () => [...document.querySelectorAll('#topicBtns button')] as HTMLButtonElement[];

  it('전체가 맨 앞이고, 아무것도 안 고르면 전체가 켜져 있다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby());
    expect(btns().map((b) => b.textContent)).toEqual(['전체', '동물', '음식', '도구']);
    expect(btns()[0].classList.contains('on')).toBe(true);
  });

  it('주제를 누르면 그것만 담아 보낸다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby());
    live.out = [];
    btns()[1].click();   // 동물
    expect(live.out.at(-1)).toEqual({ t: 'setTopics', topics: ['동물'] });
  });

  it('이미 고른 것 위에 하나 더 누르면 둘이 된다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby({ selectedTopics: ['동물'] }));
    live.out = [];
    btns()[3].click();   // 도구
    expect((live.out.at(-1) as { topics: string[] }).topics.sort()).toEqual(['도구', '동물']);
  });

  it('고른 것을 다시 누르면 빠진다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby({ selectedTopics: ['동물', '음식'] }));
    live.out = [];
    btns()[1].click();   // 동물을 뺀다
    expect((live.out.at(-1) as { topics: string[] }).topics).toEqual(['음식']);
  });

  it('전체를 누르면 고른 것이 비워진다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby({ selectedTopics: ['동물', '음식'] }));
    live.out = [];
    btns()[0].click();
    expect(live.out.at(-1)).toEqual({ t: 'setTopics', topics: [] });
  });

  it('고른 것을 안내문에 적는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby({ selectedTopics: ['동물', '도구'] }));
    expect($('topicNote').textContent).toContain('2개');
    expect($('topicNote').textContent).toContain('동물 · 도구');
  });

  it('방장이 아니면 못 누르고, 뭘 골랐는지만 본다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(lobby({ hostId: 'd', selectedTopics: ['음식'] }));
    expect(btns().every((b) => b.disabled)).toBe(true);
    expect($('topicNote').textContent).toBe('방장이 고른 주제: 음식');
  });
});

describe('관전자는 명단 맨 뒤로', () => {
  const P = (id: string, over = {}) => ({
    id, name: id, connected: true, score: 0, isDrawer: false, answered: false,
    skipped: false, solved: false, sliceCount: 1, pendingScore: 10,
    doodleColor: '', spectator: false, canRename: false, ...over,
  });
  const names = () => [...document.querySelectorAll('#players .p')]
    .map((e) => (e.textContent ?? '').replace(/[^가-힣A-Za-z0-9]/g, ''));

  it('중간에 낀 관전자가 뒤로 간다', async () => {
    // 이 줄은 사실상 출제 순번표다. 안 그리는 사람이 중간에 끼면 다음이 누구인지
    // 세는 데 방해가 된다.
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({
      phase: 'lobby',
      players: [P('가'), P('구경1', { spectator: true }), P('나'), P('구경2', { spectator: true }), P('다')],
    }));
    expect(names()).toEqual(['가', '나', '다', '구경1', '구경2']);
  });

  it('참가자끼리의 순서는 그대로다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    deliver(room({ phase: 'lobby', players: [P('다'), P('가'), P('나')] }));
    expect(names()).toEqual(['다', '가', '나']);
  });
});

describe('끊기면 스스로 다시 붙는다', () => {
  it('끊기면 잠시 뒤 새 소켓을 만든다', async () => {
    await guessing();
    const before = sockets.length;
    live.drop();
    expect(sockets.length).toBe(before);   // 곧바로가 아니라 잠시 뒤에
    vi.advanceTimersByTime(600);
    expect(sockets.length).toBe(before + 1);
  });

  it('방에 있었으면 같은 자리로 돌아가려고 join을 보낸다', async () => {
    // 서버는 같은 cid면 원래 자리에 앉히고 그 라운드에 준 것을 다시 보내준다.
    // 그래서 재연결은 사실상 join 한 번이면 끝난다.
    const real = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...real, search: '?room=TEST', pathname: '/', hostname: 'localhost',
               protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    });
    try {
      await boot();
      deliver({ t: 'joined', youId: 'me' });
      live.drop();
      vi.advanceTimersByTime(600);
      live.out = [];
      live.fire('open');
      const hello = live.out.find((m) => m.t === 'join') as { cid: string } | undefined;
      expect(hello).toBeDefined();
      expect(hello?.cid.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real });
    }
  });

  it('로비에 서 있었으면 방 목록을 다시 달라고 한다', async () => {
    // 로비에는 돌아갈 자리가 없다. 대신 목록이 멎어 있으므로 그것부터 되살린다.
    await boot();
    live.drop();
    vi.advanceTimersByTime(600);
    live.out = [];
    live.fire('open');
    expect(live.out.filter((m) => m.t === 'rooms').length).toBe(1);
  });

  it('끊긴 사이에 친 답은 되살아나지 않는다', async () => {
    // 되살아나면 이미 지난 회차의 답으로 채점된다.
    await guessing();
    live.drop();
    const input = $<HTMLInputElement>('answerInput');
    input.value = '고양이';
    input.dispatchEvent(new Event('input'));
    $('answerSubmitBtn').click();

    vi.advanceTimersByTime(600);
    live.out = [];
    live.fire('open');
    expect(live.out.filter((m) => m.t === 'answer').length).toBe(0);
  });

  it('기다리는 시간이 점점 길어진다', async () => {
    await guessing();
    const n = sockets.length;
    live.drop();
    vi.advanceTimersByTime(600);          // 0.5초
    expect(sockets.length).toBe(n + 1);
    live.drop();
    vi.advanceTimersByTime(600);          // 이번엔 1초라 아직이다
    expect(sockets.length).toBe(n + 1);
    vi.advanceTimersByTime(600);
    expect(sockets.length).toBe(n + 2);
  });

  it('끊기면 화면에 알린다', async () => {
    await guessing();
    live.drop();
    expect($('netTag').textContent).toContain('다시 붙는 중');
  });

  it('강퇴당하면 다시 두드리지 않는다', async () => {
    await boot();
    deliver({ t: 'joined', youId: 'me' });
    const n = sockets.length;
    deliver({ t: 'kicked', msg: '방장이 내보냈습니다' });
    live.drop();
    vi.advanceTimersByTime(20_000);
    expect(sockets.length).toBe(n);
  });
});

describe('판이 끝나면 그림을 모아 보여준다', () => {
  const recap = (word: string, correct: string[] = ['친구']) => ({
    round: 0,
    topic: '동물',
    word,
    drawing: [{ points: [[300, 200], [400, 300]] as [number, number][], color: '#e03131' }],
    sliceCount: 8,
    drawer: '출제자',
    correct,
  });

  const finished = (rounds = [recap('낙타'), recap('고래', [])]) => ({
    t: 'final' as const,
    ranking: [
      { playerId: 'x', name: '친구', score: 12 },
      { playerId: 'me', name: '나', score: 4 },
    ],
    rounds,
  });

  it('회차 화면에는 저장 버튼이 없다', async () => {
    // 판을 끊고 아홉 개의 파일로 흩어지게 하던 자리다. 한자리로 모았다.
    await guessing();
    expect(document.getElementById('shareBtn')).toBeNull();
  });

  it('그림마다 제시어와 그린 사람을 붙여 보여준다', async () => {
    await guessing();
    deliver(finished());
    const figs = $('gallery').querySelectorAll('figure');
    expect(figs.length).toBe(2);
    expect(figs[0].textContent).toContain('낙타');
    expect(figs[0].textContent).toContain('출제자');
    expect(figs[0].textContent).toContain('1명 맞힘');
    expect(figs[1].textContent).toContain('아무도 못 맞힘');
  });

  it('캔버스 크기는 화면에 안 물어본다', async () => {
    // 이 화면은 그려질 때 아직 감춰져 있을 수 있다. 그때 화면에서 재면 0이 나온다.
    await guessing();
    deliver(finished());
    const cv = $('gallery').querySelector('canvas') as HTMLCanvasElement;
    expect(cv.width).toBeGreaterThan(0);
    expect(cv.height).toBeGreaterThan(0);
  });

  it('그림이 하나도 없으면 저장 버튼도 안 보인다', async () => {
    await guessing();
    deliver(finished([]));
    expect($('gallery').children.length).toBe(0);
    expect($('galleryBar').style.display).toBe('none');
  });

  it('눌러서 한 장으로 만든다', async () => {
    await guessing();
    deliver(finished());
    const canvas = $<HTMLCanvasElement>('shareCanvas');
    canvas.width = 0;
    $('galleryShareBtn').click();
    // 캔버스에 크기가 잡혔다는 것은 그리기가 실제로 돌았다는 뜻이다.
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it('결과가 오기 전에는 눌러도 아무 일이 없다', async () => {
    await guessing();
    $('galleryShareBtn').click();
    expect($('galleryNote').textContent).toBe('');
  });

  it('다음 판이 끝나면 지난 안내는 지운다', async () => {
    await guessing();
    deliver(finished());
    $('galleryNote').textContent = '그림으로 저장했습니다';
    deliver(finished());
    expect($('galleryNote').textContent).toBe('');
  });
});

describe('공유는 한 번에 한 장만 나간다', () => {
  const recap = (word: string) => ({
    round: 0, topic: '동물', word,
    drawing: [{ points: [[300, 200], [400, 300]] as [number, number][], color: '#e03131' }],
    sliceCount: 8, drawer: '출제자', correct: ['친구'],
  });
  const finished = () => ({
    t: 'final' as const,
    ranking: [{ playerId: 'me', name: '나', score: 4 }],
    rounds: [recap('낙타'), recap('고래')],
  });

  /** navigator.share를 가로채 몇 번, 몇 장이 나갔는지 센다. */
  function spyShare() {
    const calls: Array<{ files: number; keys: string[] }> = [];
    // jsdom에는 toBlob이 없다. 없으면 그림을 못 만들어 공유까지 가지도 못한다.
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array(8)], { type: 'image/png' }));
    } as HTMLCanvasElement['toBlob'];
    const real = Object.getOwnPropertyDescriptor(window, 'navigator');
    Object.defineProperty(window, 'navigator', {
      configurable: true,
      value: {
        ...navigator,
        canShare: () => true,
        share: (d: { files?: unknown[] }) => {
          calls.push({ files: d.files?.length ?? 0, keys: Object.keys(d) });
          return Promise.resolve();
        },
      },
    });
    return { calls, restore: () => { if (real) Object.defineProperty(window, 'navigator', real); } };
  }

  it('한 번 누르면 공유도 한 번, 파일도 한 장이다', async () => {
    // 카카오톡 전송창에 pizza.png가 두 장 떴다는 제보. 눌린 횟수와 실린 장수를 센다.
    const spy = spyShare();
    try {
      await boot();
      deliver(finished());
      $('galleryShareBtn').click();
      await vi.waitFor(() => expect(spy.calls.length).toBeGreaterThan(0));
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].files).toBe(1);
      // 글자를 같이 실으면 받는 앱이 그림과 글자를 각각 한 덩이로 세어
      // 카카오톡 전송창에 같은 그림이 두 장으로 뜬다. 그림만 보낸다.
      expect(spy.calls[0].keys).toEqual(['files']);
    } finally {
      spy.restore();
    }
  });

  it('연달아 눌러도 겹쳐서 나가지 않는다', async () => {
    const spy = spyShare();
    try {
      await boot();
      deliver(finished());
      $('galleryShareBtn').click();
      $('galleryShareBtn').click();
      $('galleryShareBtn').click();
      await vi.waitFor(() => expect(spy.calls.length).toBeGreaterThan(0));
      expect(spy.calls.length).toBe(1);
    } finally {
      spy.restore();
    }
  });
});

describe('공유 버튼은 무슨 일이 일어날지 그대로 적는다', () => {
  /** navigator를 잠깐 갈아 끼운다. 되돌리는 것을 잊으면 뒤 테스트가 휘말린다. */
  async function bootWith(share: boolean) {
    const real = Object.getOwnPropertyDescriptor(window, 'navigator');
    Object.defineProperty(window, 'navigator', {
      configurable: true,
      value: share
        ? { ...navigator, share: () => Promise.resolve(), canShare: () => true }
        : { ...navigator, share: undefined, canShare: undefined },
    });
    try { await boot(); } finally {
      if (real) Object.defineProperty(window, 'navigator', real);
    }
  }

  it('공유창이 되는 기기에서는 공유하기', async () => {
    await bootWith(true);
    expect($('galleryShareBtn').textContent).toBe('공유하기');
    expect($('galleryShareBtn').title).toContain('공유합니다');
  });

  it('안 되는 기기에서는 그림으로 저장', async () => {
    // 폰에서 '그림으로 저장'이라고 적어두면 공유창이 뜨는 것이 놀랍고,
    // PC에서 '공유하기'라고 적어두면 파일이 내려와서 또 놀란다.
    await bootWith(false);
    expect($('galleryShareBtn').textContent).toBe('그림으로 저장');
    expect($('galleryShareBtn').title).toContain('내려받습니다');
  });
});

describe('맞힌 뒤에는 답을 더 못 낸다', () => {
  const solvedRoom = (attempt: number) => room({
    attempt,
    players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, solved: true } : p)),
  });

  it('맞히면 입력칸과 두 버튼이 잠긴다', async () => {
    await guessing();
    deliver(solvedRoom(2));
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(true);
  });

  it('회차가 넘어가 조각을 더 받아도 잠금이 풀리지 않는다', async () => {
    // 맞힌 사람도 seen에 남아 있어서 회차마다 조각을 계속 받는다(session.endAttempt).
    // 그 조각을 받는 자리에서 잠금을 통째로 풀어버리면, 맞혀놓고도 답을 또 낼 수 있다.
    await guessing();
    deliver(solvedRoom(2));
    deliver(slices());
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
    expect($<HTMLButtonElement>('answerSubmitBtn').disabled).toBe(true);
  });

  it('스킵을 누른 뒤에도 조각이 오면 잠금이 유지된다', async () => {
    await guessing();
    deliver(room({
      players: PLAYERS.map((p) => (p.id === 'me' ? { ...p, skipped: true } : p)),
    }));
    deliver(slices());
    expect($<HTMLInputElement>('answerInput').disabled).toBe(true);
  });
});
