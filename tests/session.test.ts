import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../src/server/session';
import type { ServerMsg } from '../src/shared/protocol';
import type { Scheduler } from '../src/server/scheduler';

/** 시간을 손으로 흘리는 스케줄러 */
class ManualScheduler implements Scheduler {
  private jobs: Array<{ fn: () => void; live: boolean }> = [];
  after(_ms: number, fn: () => void) {
    const job = { fn, live: true };
    this.jobs.push(job);
    return () => { job.live = false; };
  }
  /** 지금 걸려 있는 타이머를 전부 터뜨린다 */
  fire(): void {
    const due = this.jobs.filter((j) => j.live);
    this.jobs = [];
    for (const j of due) j.fn();
  }
}

let sent: Array<{ to: string; msg: ServerMsg }>;
let clock: ManualScheduler;
let s: Session;

/** p1이 방장, p1이 첫 출제자. 4명으로 시작한다. */
function newSession(names = ['p1', 'p2', 'p3', 'p4']) {
  sent = [];
  clock = new ManualScheduler();
  s = new Session((to, msg) => sent.push({ to, msg }), {
    scheduler: clock,
    // 무작위를 고정한다 — 늘 첫 번째를 고른다
    pick: () => 0,
    shuffle: (xs) => xs,
  });
  for (const n of names) s.join(n, n);
  return s;
}

function msgsOfType<T extends ServerMsg['t']>(t: T) {
  return sent.filter((e) => e.msg.t === t).map((e) => e.msg) as Extract<ServerMsg, { t: T }>[];
}
function msgsTo(to: string) {
  return sent.filter((e) => e.to === to).map((e) => e.msg);
}

/** 중심을 지나 사방으로 뻗는 별 모양 — 모든 조각에 잉크가 들어간다 */
function drawStar(playerId: string) {
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    s.addStroke(playerId, [
      [500, 500],
      [Math.round(500 + Math.cos(a) * 400), Math.round(500 + Math.sin(a) * 400)],
    ]);
  }
}

beforeEach(() => newSession());

describe('로비', () => {
  it('첫 입장자가 방장이 된다', () => {
    expect(msgsOfType('room').at(-1)!.hostId).toBe('p1');
  });

  it('4명 미만이면 시작할 수 없다', () => {
    const small = new Session(() => {}, { scheduler: new ManualScheduler() });
    small.join('a', 'A');
    small.join('b', 'B');
    small.join('c', 'C');
    small.start('a');
    expect(small.phase).toBe('lobby');
  });

  it('방장이 아니면 시작할 수 없다', () => {
    s.start('p2');
    expect(s.phase).toBe('lobby');
  });

  it('라운드 수는 시작 시점 인원으로 고정된다', () => {
    s.start('p1');
    expect(msgsOfType('room').at(-1)!.totalRounds).toBe(4);
  });
});

describe('그리기 단계', () => {
  beforeEach(() => { s.start('p1'); });

  it('출제자에게만 제시어가 간다', () => {
    expect(msgsTo('p1').filter((m) => m.t === 'word').length).toBe(1);
    for (const other of ['p2', 'p3', 'p4']) {
      expect(msgsTo(other).filter((m) => m.t === 'word').length).toBe(0);
    }
  });

  it('주제는 전원에게 공개된다', () => {
    expect(msgsOfType('room').at(-1)!.topic).not.toBe('');
  });

  it('출제자만 그릴 수 있다', () => {
    s.addStroke('p2', [[500, 500], [600, 500]]);
    s.addStroke('p1', [[500, 500], [600, 500]]);
    expect(s.strokeCount).toBe(1);
  });

  it('원 밖으로 나가는 점은 받지 않는다', () => {
    s.addStroke('p1', [[10, 10], [20, 20]]); // 모서리 — 원 밖이다
    expect(s.strokeCount).toBe(0);
  });

  it('시간이 다 되면 자동으로 넘어간다', () => {
    drawStar('p1');
    clock.fire();
    expect(s.phase).toBe('guessing');
  });

  it('다 그렸다를 누르면 바로 넘어간다', () => {
    drawStar('p1');
    s.drawDone('p1');
    expect(s.phase).toBe('guessing');
  });

  it('출제자가 아니면 다 그렸다를 눌러도 소용없다', () => {
    drawStar('p1');
    s.drawDone('p2');
    expect(s.phase).toBe('drawing');
  });

  it('아무것도 안 그리고 시간이 다 되면 라운드를 건너뛴다', () => {
    clock.fire();
    expect(s.phase).toBe('roundEnd');
  });
});

describe('조각 배분', () => {
  beforeEach(() => { s.start('p1'); drawStar('p1'); s.drawDone('p1'); });

  it('맞히는 사람마다 조각을 하나씩 받는다', () => {
    for (const g of ['p2', 'p3', 'p4']) {
      const slices = msgsTo(g).filter((m) => m.t === 'slices') as Array<Extract<ServerMsg, { t: 'slices' }>>;
      expect(slices.at(-1)!.slices.length).toBe(1);
    }
  });

  it('출제자는 조각을 받지 않는다', () => {
    expect(msgsTo('p1').filter((m) => m.t === 'slices').length).toBe(0);
  });

  it('사람마다 다른 조각을 받는다', () => {
    const shapes = ['p2', 'p3', 'p4'].map((g) => {
      const m = msgsTo(g).filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
      return JSON.stringify(m.slices[0].strokes);
    });
    expect(new Set(shapes).size).toBe(3);
  });

  it('조각에 섹터 번호나 각도가 실리지 않는다', () => {
    const m = msgsTo('p2').filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
    const keys = Object.keys(m.slices[0]).sort();
    expect(keys).toEqual(['id', 'shared', 'strokes']);
  });

  it('전체 조각 수는 알려준다 — 부채꼴을 몇 도로 그릴지 필요하고, 새어도 무해하다', () => {
    const m = msgsTo('p2').filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
    expect(m.count).toBe(8);
  });

  it('화면 전환(room)이 조각보다 먼저 나간다', () => {
    const toP2 = sent.filter((e) => e.to === 'p2');
    const roomAt = toP2.findIndex((e) => e.msg.t === 'room' && e.msg.phase === 'guessing');
    const sliceAt = toP2.findIndex((e) => e.msg.t === 'slices');
    expect(roomAt).toBeGreaterThanOrEqual(0);
    expect(roomAt).toBeLessThan(sliceAt);
  });
});

describe('정보 은닉', () => {
  it('라운드가 끝나기 전에는 어떤 메시지에도 제시어가 없다', () => {
    s.start('p1');
    const word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1');
    s.drawDone('p1');

    for (const { to, msg } of sent) {
      if (to === 'p1' && msg.t === 'word') continue; // 출제자에게 준 한 번은 예외
      expect(JSON.stringify(msg)).not.toContain(word);
    }
  });

  it('라운드가 끝나기 전에는 맞히는 사람에게 전체 획이 가지 않는다', () => {
    s.start('p1');
    drawStar('p1');
    s.drawDone('p1');

    for (const g of ['p2', 'p3', 'p4']) {
      for (const msg of msgsTo(g)) {
        expect(msg.t).not.toBe('canvas');
        expect(msg.t).not.toBe('roundEnd');
      }
    }
  });
});

describe('추론 루프', () => {
  let word: string;

  beforeEach(() => {
    s.start('p1');
    word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
  });

  it('시간이 다 되면 답이 동시에 공개된다', () => {
    s.answer('p2', '엉뚱한답');
    expect(msgsOfType('attemptResult').length).toBe(0);
    clock.fire();
    const res = msgsOfType('attemptResult');
    expect(res.length).toBe(4);
    expect(res[0].answers.find((a) => a.playerId === 'p2')!.text).toBe('엉뚱한답');
  });

  it('맞히는 사람 전원이 넘기기를 누르면 바로 공개된다', () => {
    s.skip('p2');
    s.skip('p3');
    expect(msgsOfType('attemptResult').length).toBe(0);
    s.skip('p4');
    expect(msgsOfType('attemptResult').length).toBe(4);
  });

  it('출제자의 넘기기는 세지 않는다 — 답을 아는 사람이 속도를 정하면 안 된다', () => {
    s.skip('p1');
    s.skip('p2');
    s.skip('p3');
    expect(msgsOfType('attemptResult').length).toBe(0);
  });

  it('아무도 못 맞히면 힌트를 주고 다음 시도로 간다', () => {
    clock.fire();
    expect(s.phase).toBe('guessing');
    const room = msgsOfType('room').at(-1)!;
    expect(room.attempt).toBe(2);
    // 조각이 하나 늘어난다
    const slices = msgsTo('p2').filter((m) => m.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
    expect(slices.slices.length).toBe(2);
  });

  it('힌트로 나온 조각은 전원이 같은 것을 받는다', () => {
    clock.fire();
    const shared = ['p2', 'p3', 'p4'].map((g) => {
      const m = msgsTo(g).filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
      return m.slices.find((x) => x.shared)!.id;
    });
    expect(new Set(shared).size).toBe(1);
  });

  it('한 명이라도 맞히면 라운드가 끝난다', () => {
    s.answer('p3', word);
    clock.fire();
    expect(s.phase).toBe('roundEnd');
    const end = msgsOfType('roundEnd')[0];
    expect(end.word).toBe(word);
    expect(end.correct).toEqual(['p3']);
  });

  it('맞힌 사람은 시도 회차에 따라 점수를 받는다', () => {
    s.answer('p3', word);
    clock.fire();
    const end = msgsOfType('roundEnd')[0];
    expect(end.scores.find((x) => x.playerId === 'p3')!.delta).toBe(3);
  });

  it('늦게 맞힐수록 점수가 낮다', () => {
    clock.fire();               // 1차 실패
    s.answer('p3', word);
    clock.fire();               // 2차에서 맞힘
    const end = msgsOfType('roundEnd')[0];
    expect(end.scores.find((x) => x.playerId === 'p3')!.delta).toBe(2);
  });

  it('출제자는 맞힌 사람 수만큼 받는다', () => {
    s.answer('p2', word);
    s.answer('p3', word);
    clock.fire();
    const end = msgsOfType('roundEnd')[0];
    expect(end.scores.find((x) => x.playerId === 'p1')!.delta).toBe(2);
  });

  it('세 번 다 실패하면 전원 0점으로 끝난다', () => {
    clock.fire();
    clock.fire();
    clock.fire();
    expect(s.phase).toBe('roundEnd');
    const end = msgsOfType('roundEnd')[0];
    expect(end.correct).toEqual([]);
    expect(end.scores.every((x) => x.delta === 0)).toBe(true);
  });

  it('라운드가 끝나야 원본과 섹터 번호가 내려간다', () => {
    s.answer('p2', word);
    clock.fire();
    const end = msgsOfType('roundEnd')[0];
    expect(end.drawing.length).toBeGreaterThan(0);
    expect(end.owners.length).toBe(end.sliceCount);
    expect(end.owners.filter((o) => o.playerId !== null).length).toBe(3);
  });

  it('방장이 다음을 누르면 다음 라운드로 간다', () => {
    s.answer('p2', word);
    clock.fire();
    s.next('p1');
    expect(s.phase).toBe('drawing');
    expect(msgsOfType('room').at(-1)!.round).toBe(1);
  });

  it('마지막 라운드가 끝나면 최종 결과가 나온다', () => {
    for (let i = 0; i < 4; i++) {
      if (s.phase === 'lobby') break;
      if (s.phase === 'drawing') { drawStar(s.drawerId); s.drawDone(s.drawerId); }
      clock.fire(); clock.fire(); clock.fire();
      s.next('p1');
    }
    expect(s.phase).toBe('final');
    expect(msgsOfType('final').at(-1)!.ranking.length).toBe(4);
  });
});

describe('힌트 폴백 — 숨은 조각이 없을 때', () => {
  it('9명이면 처음부터 전원이 조각을 하나씩 갖고, 힌트는 남의 조각 재배포다', () => {
    newSession(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    s.start('p1');
    drawStar('p1');
    s.drawDone('p1');
    sent = [];

    clock.fire(); // 1차 실패 → 힌트

    const m = msgsTo('p2').filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
    expect(m.slices.length).toBe(2);
    // 전원 공개가 아니라 개인 배포다
    expect(m.slices.every((x) => x.shared === false)).toBe(true);
  });
});

describe('이탈과 재입장', () => {
  beforeEach(() => { s.start('p1'); });

  it('출제자가 그리다 나가면 그때까지 그린 것으로 진행한다', () => {
    drawStar('p1');
    s.disconnect('p1');
    clock.fire();
    expect(s.phase).toBe('guessing');
  });

  it('출제자가 아무것도 안 그리고 나가면 라운드를 건너뛴다', () => {
    s.disconnect('p1');
    clock.fire();
    expect(s.phase).toBe('roundEnd');
  });

  it('출제자가 돌아오면 제시어와 자기 그림을 되찾는다', () => {
    drawStar('p1');
    s.disconnect('p1');
    sent = [];
    s.join('p1', 'p1');
    const mine = msgsTo('p1');
    expect(mine.filter((m) => m.t === 'word').length).toBe(1);
    const canvas = mine.find((m) => m.t === 'canvas') as Extract<ServerMsg, { t: 'canvas' }>;
    expect(canvas.strokes.length).toBe(12);
  });

  // 체크포인트 A에서 실제로 걸린 버그다. restore()가 drawing/guessing만 복구해서,
  // 결과 화면에서 새로고침하면 정답도 답 목록도 그림도 없는 빈 화면에 갇혔다.
  // 방장이 아니면 넘길 수도 없다.
  it('결과 화면에서 돌아오면 결과를 다시 받는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    clock.fire(); clock.fire(); clock.fire();
    expect(s.phase).toBe('roundEnd');
    sent = [];
    s.join('p2', 'p2');
    const again = msgsTo('p2').filter((m) => m.t === 'roundEnd');
    expect(again.length).toBe(1);
    expect((again[0] as Extract<ServerMsg, { t: 'roundEnd' }>).word.length).toBeGreaterThan(0);
  });

  it('최종 화면에서 돌아오면 순위를 다시 받는다', () => {
    for (let i = 0; i < 4; i++) {
      if (s.phase === 'drawing') { drawStar(s.drawerId); s.drawDone(s.drawerId); }
      clock.fire(); clock.fire(); clock.fire();
      s.next('p1');
    }
    expect(s.phase).toBe('final');
    sent = [];
    s.join('p3', 'p3');
    expect(msgsTo('p3').filter((m) => m.t === 'final').length).toBe(1);
  });

  it('맞히는 사람이 돌아오면 받았던 조각을 그대로 다시 받는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    const before = (msgsTo('p2').filter((m) => m.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>).slices;
    s.disconnect('p2');
    sent = [];
    s.join('p2', 'p2');
    const after = (msgsTo('p2').filter((m) => m.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>).slices;
    expect(after).toEqual(before);
  });

  it('끊긴 사람이 넘기기 판정을 막지 않는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    s.disconnect('p4');
    sent = [];
    s.skip('p2');
    s.skip('p3');
    expect(msgsOfType('attemptResult').length).toBeGreaterThan(0);
  });

  it('라운드 도중 합류자는 조각을 받지 않는다 (관전)', () => {
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
    s.join('p9', '늦둥이');
    expect(msgsTo('p9').filter((m) => m.t === 'slices').length).toBe(0);
  });

  it('라운드 도중 합류자는 출제 순번에 들어가지 않는다', () => {
    s.join('p9', '늦둥이');
    expect(msgsOfType('room').at(-1)!.totalRounds).toBe(4);
  });

  it('출제 차례인 사람이 없으면 건너뛴다', () => {
    drawStar('p1'); s.drawDone('p1'); clock.fire(); clock.fire(); clock.fire();
    s.disconnect('p2'); // 다음 출제자
    s.next('p1');
    expect(s.drawerId).toBe('p3');
  });

  it('로비 이탈이 쌓여도 방이 막히지 않는다', () => {
    const fresh = new Session(() => {}, { scheduler: new ManualScheduler() });
    for (const id of ['a', 'b', 'c']) fresh.join(id, id);
    for (const id of ['a', 'b', 'c']) fresh.disconnect(id);
    for (let i = 0; i < 9; i++) fresh.join(`n${i}`, `n${i}`);
    fresh.start('n0');
    expect(fresh.phase).toBe('drawing');
  });

  it('인원이 최소 미만이 되면 진행 중 라운드는 마치고 로비로 돌아간다', () => {
    drawStar('p1'); s.drawDone('p1');
    s.disconnect('p3');
    s.disconnect('p4');
    // 남은 사람은 p1, p2 — 진행 중인 라운드는 끝까지 간다
    clock.fire(); clock.fire(); clock.fire();
    expect(s.phase).toBe('roundEnd');
    s.next('p1');
    expect(s.phase).toBe('lobby');
  });

  it('로비로 돌아가도 점수는 남는다', () => {
    const word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1'); s.drawDone('p1');
    s.answer('p2', word);
    clock.fire();
    s.disconnect('p3'); s.disconnect('p4');
    s.next('p1');
    expect(s.phase).toBe('lobby');
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.score).toBe(3);
  });
});
