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
const bodyHtml = readFileSync(pjoin(root, 'index.html'), 'utf8')
  .split('<body>')[1]
  .split('</body>')[0];

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
    round: 0, totalRounds: 3, topic: '동물', attempt: 1, maxAttempts: 3, deadline: null,
    ...over,
  } as ServerMsg;
}

function slices(): ServerMsg {
  return { t: 'slices', count: 8, slices: [{ id: 'a', strokes: [[[500, 500], [600, 500]]], shared: false }] };
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
    $('skipBtn').click();

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
    $('skipBtn').click();
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
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(true);
    expect($('spectateNote').textContent).toContain('관전');
  });

  it('조각을 받으면 입력이 열린다', async () => {
    await guessing();
    expect($<HTMLInputElement>('answerInput').disabled).toBe(false);
    expect($<HTMLButtonElement>('skipBtn').disabled).toBe(false);
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
