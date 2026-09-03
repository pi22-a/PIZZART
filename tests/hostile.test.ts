import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../src/server/session';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';
import type { Scheduler } from '../src/server/scheduler';

/**
 * 고약한 입력에도 서버가 죽지 않는지 본다.
 *
 * 지금까지는 임시 터널로 지인들만 들어왔다. 24시간 고정 주소가 되면 이야기가 달라진다 —
 * 주소를 아는 누구나, 브라우저 콘솔로 아무 메시지나 보낼 수 있다.
 *
 * **이 게임에서 서버가 죽는 것은 특히 비싸다.** 방 상태가 메모리에만 있어서, 예외 하나로
 * 프로세스가 내려가면 그 순간 돌던 판이 전부 날아간다. 실제로 화면 서빙에서 그런 자리를
 * 하나 찾았다(빗금 두 개짜리 주소 하나로 죽었다). 메시지 쪽도 같은 눈으로 훑는다.
 *
 * 여기서 확인하는 것은 "막았는가"가 아니라 **"죽지 않는가"** 다. 이상한 요청은 조용히
 * 무시되면 그만이고, 그 뒤에도 판이 계속 돌면 된다.
 */
class ManualScheduler implements Scheduler {
  private jobs: Array<{ fn: () => void; live: boolean }> = [];
  after(_ms: number, fn: () => void) {
    const job = { fn, live: true };
    this.jobs.push(job);
    return () => { job.live = false; };
  }
  fire(): void {
    const due = this.jobs.filter((j) => j.live);
    this.jobs = [];
    for (const j of due) j.fn();
  }
}

const RULES = {
  minPlayers: 4, maxPlayers: 9, sliceCountMin: 8,
  drawSeconds: 60, guessSeconds: 30, roundEndSeconds: 0, idleDrawSeconds: 0,
  maxAttempts: 6, maxSlices: 5,
  startScore: 10, wrongSubmitCost: 1, attemptCost: 1, finalAttemptScore: 1,
  drawerScore: 5, wordRerolls: 2,
};

let sent: Array<{ to: string; msg: ServerMsg }>;
let clock: ManualScheduler;
let s: Session;

beforeEach(() => {
  sent = [];
  clock = new ManualScheduler();
  s = new Session((to, msg) => sent.push({ to, msg }), {
    scheduler: clock, rules: { ...RULES }, pick: () => 0, shuffle: (xs) => xs,
  });
  for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
});

/** 값이 들어갈 만한 자리마다 넣어볼 고약한 것들 */
const NASTY: unknown[] = [
  undefined, null, 0, -1, NaN, Infinity, -Infinity, 1e309,
  '', ' '.repeat(10_000), 'x'.repeat(100_000),
  true, false, {}, [], [[]], [{}], [null], [undefined],
  { toString() { throw new Error('폭탄'); } },
  { length: 1e9 },
  '__proto__', '{"__proto__":{"a":true}}',
  '../../etc/passwd',
  [[NaN, NaN]], [[1e400, -1e400]], [['a', 'b']],
];

/** 이상한 메시지를 던진 뒤에도 방이 멀쩡히 돌아가는지 */
function stillWorks(): void {
  expect(() => s.start('p1')).not.toThrow();
  expect(['drawing', 'lobby']).toContain(s.phase);
}

describe('아무 메시지나 던져도 서버가 죽지 않는다', () => {
  const TYPES = [
    'join', 'start', 'setTopics', 'setSpectator', 'setLock', 'setColorMode',
    'stroke', 'undo', 'erase', 'drawDone', 'answer', 'skip',
    'doodle', 'doodleClear', 'doodleErase', 'doodleColor',
    'chat', 'reroll', 'next', 'again', 'kick', 'rooms', 'createRoom',
  ];

  it('모든 메시지 종류에 고약한 값을 넣어도 예외가 안 난다', () => {
    let count = 0;
    for (const t of TYPES) {
      for (const bad of NASTY) {
        // 그 메시지가 가질 만한 필드에 전부 같은 값을 꽂아본다
        const msg = {
          t, name: bad, topics: bad, on: bad, mode: bad, points: bad, color: bad,
          text: bad, index: bad, path: bad, playerId: bad,
        } as unknown as ClientMsg;
        for (const who of ['p1', 'p2', 'nobody']) {
          expect(() => s.handle(who, msg)).not.toThrow();
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(1000);
    stillWorks();
  });

  it('메시지 자체가 이상해도 죽지 않는다', () => {
    for (const bad of NASTY) {
      expect(() => s.handle('p1', bad as unknown as ClientMsg)).not.toThrow();
    }
    stillWorks();
  });

  it('프로토타입을 더럽히지 못한다', () => {
    s.handle('p1', JSON.parse('{"t":"chat","text":"x","__proto__":{"a":true}}') as ClientMsg);
    s.handle('p1', { t: 'setTopics', topics: ['__proto__', 'constructor'] } as ClientMsg);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
    stillWorks();
  });

  it('거대한 획을 보내도 버틴다', () => {
    s.start('p1');
    const huge = Array.from({ length: 50_000 }, (_, i) => [i % 1000, (i * 7) % 1000] as [number, number]);
    expect(() => s.addStroke(s.drawerId, huge, '#1f1b17')).not.toThrow();
    expect(() => s.drawDone(s.drawerId)).not.toThrow();
    expect(s.phase).toBe('guessing');
  });

  it('없는 사람이 보낸 메시지는 조용히 무시된다', () => {
    s.start('p1');
    for (const t of ['start', 'drawDone', 'skip', 'next', 'again', 'undo'] as const) {
      expect(() => s.handle('유령', { t } as ClientMsg)).not.toThrow();
    }
    expect(s.phase).toBe('drawing');
  });
});
