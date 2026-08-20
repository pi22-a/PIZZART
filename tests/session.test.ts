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
/**
 * 테스트가 쓸 규칙. content/rules.json을 읽지 않고 여기 고정한다.
 *
 * 예전에는 주입하지 않아 실제 설정 파일을 그대로 읽었고, 플레이테스트 중 숫자 하나를
 * 조정할 때마다 세션 테스트 서른 개가 한꺼번에 빨개졌다. 규칙 값은 손잡이고,
 * 손잡이를 돌렸다고 테스트가 깨지면 안 된다.
 */
const TEST_RULES = {
  minPlayers: 4, maxPlayers: 9, sliceCountMin: 8,
  drawSeconds: 60, guessSeconds: 30, roundEndSeconds: 0,
  maxAttempts: 6, maxSlices: 5,
  startScore: 10, wrongSubmitCost: 1, attemptCost: 1, finalAttemptScore: 1,
};

function newSession(names = ['p1', 'p2', 'p3', 'p4']) {
  sent = [];
  clock = new ManualScheduler();
  s = new Session((to, msg) => sent.push({ to, msg }), {
    scheduler: clock,
    rules: { ...TEST_RULES },
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

  it('로비에서 방장이 나가도 남은 사람이 시작할 수 있다', () => {
    // 최소 인원(4명)을 밑돌지 않도록 5명으로 시작한다 — 아니면 방장 승계와
    // 무관하게 인원 부족으로 시작이 막혀 이 테스트가 무엇을 증명하는지 흐려진다.
    newSession(['p1', 'p2', 'p3', 'p4', 'p5']);
    s.disconnect('p1'); // 방장이 로비에서 나간다 — 로비에서는 자리가 통째로 사라진다
    const newHost = msgsOfType('room').at(-1)!.hostId;
    expect(newHost).not.toBe('');
    s.start(newHost);
    expect(s.phase).toBe('drawing');
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

describe('대기 화면 낙서판', () => {
  const LINE: Array<[number, number]> = [[10, 10], [200, 300]];

  beforeEach(() => {
    s.start('p1');      // p1이 출제자, 나머지는 대기 화면
    sent = [];
  });

  const doodlesTo = (id: string) => msgsTo(id).filter((m) => m.t === 'doodleStroke');

  it('기다리는 사람끼리 낙서가 오간다', () => {
    s.addDoodle('p2', LINE);
    expect(doodlesTo('p3').length).toBe(1);
    expect(doodlesTo('p4').length).toBe(1);
    // 그린 사람에게도 간다 — 화면을 서버 상태로 맞춰두면 새로고침해도 어긋나지 않는다
    expect(doodlesTo('p2').length).toBe(1);
  });

  it('출제자에게는 낙서가 가지 않는다', () => {
    s.addDoodle('p2', LINE);
    expect(doodlesTo('p1').length).toBe(0);
  });

  it('출제자는 낙서판에 그릴 수 없다 — 자기 캔버스가 따로 있다', () => {
    s.addDoodle('p1', LINE);
    expect(doodlesTo('p2').length).toBe(0);
  });

  it('추론이 시작되면 더 이상 낙서를 받지 않는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
    s.addDoodle('p2', LINE);
    expect(doodlesTo('p3').length).toBe(0);
  });

  it('내 낙서만 지운다 — 남의 낙서는 남는다', () => {
    s.addDoodle('p2', LINE);
    s.addDoodle('p3', LINE);
    sent = [];
    s.clearDoodle('p2');
    const board = msgsTo('p3').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(1);
    expect(board.strokes[0].by).toBe('p3');
  });

  it('돌아온 사람은 지금까지의 낙서판을 통째로 받는다', () => {
    s.addDoodle('p2', LINE);
    s.disconnect('p3');
    sent = [];
    s.join('p3', 'p3');
    const board = msgsTo('p3').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(1);
  });

  it('라운드가 바뀌면 낙서판이 비워진다', () => {
    s.addDoodle('p2', LINE);
    drawStar('p1');
    s.drawDone('p1');
    while (s.phase === 'guessing') clock.fire();
    s.next('p1');                       // 2라운드 — 출제자는 p2, p1은 대기 쪽이다
    sent = [];
    s.disconnect('p1');
    s.join('p1', 'p1');
    const board = msgsTo('p1').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(0);
  });
});

describe('추론 루프 — 개인 점수제', () => {
  let word: string;

  beforeEach(() => {
    s.start('p1');
    word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
  });

  const scoreOf = (id: string) =>
    msgsOfType('room').at(-1)!.players.find((p) => p.id === id)!.pendingScore;

  /** 남은 회차를 끝까지 흘려 라운드를 종료시킨다. 이제 한 명이 맞혀도 라운드는 안 끝난다. */
  const finish = () => { while (s.phase === 'guessing') clock.fire(); };
  const deltaOf = (id: string) =>
    msgsOfType('roundEnd').at(-1)!.scores.find((x) => x.playerId === id)!.delta;

  it('아무것도 안 쓰고 1회차에 맞히면 만점이다', () => {
    s.answer('p2', word);
    finish();
    expect(deltaOf('p2')).toBe(10);
  });

  it('회차가 넘어가면 조각이 한 장씩 자동으로 늘고 점수가 깎인다', () => {
    s.skip('p3');                 // 방 상태를 한 번 흘려보낸다 (p3만으로는 정족수가 안 찬다)
    expect(scoreOf('p2')).toBe(10);
    clock.fire();                 // 2회차로
    expect(scoreOf('p2')).toBe(9);
    expect(scoreOf('p3')).toBe(9);
    const mine = msgsTo('p2').filter((m) => m.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
    expect(mine.slices.length).toBe(2);
    // 아무것도 안 한 사람에게도 똑같이 한 장이 더 간다 — 이제 선택이 아니다
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p4')!.sliceCount).toBe(2);
  });

  it('사람마다 다른 조각을 받는다 — 같은 조각을 주면 게임이 무너진다', () => {
    clock.fire();
    const of = (id: string) => {
      const m = msgsTo(id).filter((x) => x.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
      return m.slices.map((x) => x.id);
    };
    for (const id of ['p2', 'p3', 'p4']) expect(new Set(of(id)).size).toBe(2);
  });

  it('아직 못 맞힌 사람이 전부 스킵을 누르면 남은 시간을 안 기다린다', () => {
    s.skip('p2'); s.skip('p3');
    expect(msgsOfType('attemptResult').length).toBe(0);
    s.skip('p4');
    expect(msgsOfType('attemptResult').length).toBeGreaterThan(0);
    expect(msgsOfType('room').at(-1)!.attempt).toBe(2);
  });

  it('스킵을 누르면 적어둔 답이 채점되지 않는다', () => {
    s.answer('p2', '오답');
    s.skip('p2');
    clock.fire();
    expect(scoreOf('p2')).toBe(9);   // 회차 -1만. 오답 -1은 없다
  });

  it('스킵을 누른 뒤에 온 답은 받지 않는다', () => {
    s.skip('p2');
    s.answer('p2', word);
    clock.fire();
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.solved).toBe(false);
  });

  it('1회차에 틀리면 2회차 정답은 8점', () => {
    s.answer('p2', '엉뚱한답');
    clock.fire();               // 1회차 종료 — 오답 -1, 회차 -1
    s.answer('p2', word);
    finish();
    expect(deltaOf('p2')).toBe(8);
  });

  it('아무것도 안 냈으면 2회차 정답은 9점', () => {
    clock.fire();
    s.answer('p2', word);
    finish();
    expect(deltaOf('p2')).toBe(9);
  });

  it('1~4회차를 전부 틀리면 5회차 정답은 2점', () => {
    for (let i = 0; i < 4; i++) {
      s.answer('p2', '오답');
      clock.fire();
    }
    s.answer('p2', word);
    finish();
    expect(deltaOf('p2')).toBe(2);
  });

  it('먼저 맞혀도 라운드는 남은 사람을 위해 계속된다', () => {
    s.answer('p2', word);
    clock.fire();
    expect(s.phase).toBe('guessing');   // p3, p4가 아직 못 맞혔다
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.solved).toBe(true);
  });

  it('전원이 맞히면 그 자리에서 라운드가 끝난다', () => {
    s.answer('p2', word); s.answer('p3', word); s.answer('p4', word);
    expect(s.phase).toBe('roundEnd');
  });

  it('맞힌 사람은 더 제출할 수도 스킵할 수도 없다', () => {
    s.answer('p2', word);
    clock.fire();
    const before = scoreOf('p2');
    s.skip('p2');
    s.answer('p2', '아무거나');
    expect(scoreOf('p2')).toBe(before);
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.skipped).toBe(false);
  });

  it('마지막 회차는 조립판이고, 거기서 맞히면 1점이다', () => {
    for (let i = 0; i < 5; i++) clock.fire();   // 1~5회차를 그냥 흘려보낸다
    expect(msgsOfType('room').at(-1)!.attempt).toBe(6);
    const asm = msgsTo('p2').filter((m) => m.t === 'assembled');
    expect(asm.length).toBeGreaterThan(0);
    s.answer('p2', word);
    finish();
    expect(deltaOf('p2')).toBe(1);
  });

  it('마지막 회차에서 돌아오면 조립판을 다시 받는다', () => {
    for (let i = 0; i < 5; i++) clock.fire();   // 6회차(조립판)까지 간다
    expect(msgsOfType('room').at(-1)!.attempt).toBe(6);
    s.disconnect('p2');
    sent = [];
    s.join('p2', 'p2');
    expect(msgsTo('p2').filter((m) => m.t === 'assembled').length).toBe(1);
  });

  it('조립판 조각은 회전이 풀려 제자리에 있다', () => {
    for (let i = 0; i < 5; i++) clock.fire();
    const asm = (msgsTo('p2').filter((m) => m.t === 'assembled').at(-1)) as Extract<ServerMsg, { t: 'assembled' }>;
    // 내가 본 조각만, 각자 자기 섹터 번호를 달고 온다
    expect(asm.pieces.length).toBeGreaterThanOrEqual(2);
    for (const piece of asm.pieces) {
      expect(piece.index).toBeGreaterThanOrEqual(0);
      expect(piece.index).toBeLessThan(asm.sliceCount);
    }
  });

  it('출제자는 점수를 받지 않는다', () => {
    s.answer('p2', word); s.answer('p3', word); s.answer('p4', word);
    expect(deltaOf('p1')).toBe(0);
  });

  it('출제자는 스킵도 답도 낼 수 없다', () => {
    s.skip('p1');
    s.answer('p1', word);
    clock.fire();
    const rows = msgsOfType('attemptResult').at(-1)!.answers;
    expect(rows.find((r) => r.playerId === 'p1')).toBeUndefined();
  });

  it('아직 못 맞힌 사람이 모두 답을 내면 시간을 안 기다린다', () => {
    s.answer('p2', '가'); s.answer('p3', '나');
    expect(msgsOfType('attemptResult').length).toBe(0);
    s.answer('p4', '다');
    expect(msgsOfType('attemptResult').length).toBeGreaterThan(0);
  });

  it('라운드가 끝나야 원본과 섹터 번호가 내려간다', () => {
    for (let i = 0; i < 6; i++) clock.fire();
    const end = msgsOfType('roundEnd').at(-1)!;
    expect(end.drawing.length).toBeGreaterThan(0);
    expect(end.owners.length).toBe(end.sliceCount);
  });

  it('방장이 다음을 누르면 다음 라운드로 간다', () => {
    for (let i = 0; i < 6; i++) clock.fire();
    s.next('p1');
    expect(s.phase).toBe('drawing');
  });

  it('결과 화면은 스스로 넘어가지 않는다 — 방장이 눌러야 한다', () => {
    for (let i = 0; i < 6; i++) clock.fire();
    expect(s.phase).toBe('roundEnd');
    expect(msgsOfType('room').at(-1)!.deadline).toBe(null);
    clock.fire();
    expect(s.phase).toBe('roundEnd');
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
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    expect(s.phase).toBe('roundEnd');
    // 원본과 똑같은 참조인지 확인하기 위해, 브로드캐스트 직후와 재입장 사이에
    // 상태를 바꾼다(p3 이탈). 다시 계산하는 구현이면 여기서 값이 달라질 수 있지만,
    // 그때 그 메시지를 그대로 돌려주는 구현이면 이탈과 무관하게 값이 그대로다.
    const before = msgsOfType('roundEnd').at(-1)!;
    s.disconnect('p3');
    sent = [];
    s.join('p2', 'p2');
    const again = msgsTo('p2').filter((m) => m.t === 'roundEnd');
    expect(again.length).toBe(1);
    expect(again[0]).toEqual(before);
  });

  it('최종 화면에서 돌아오면 순위를 다시 받는다', () => {
    for (let i = 0; i < 4; i++) {
      if (s.phase === 'drawing') { drawStar(s.drawerId); s.drawDone(s.drawerId); }
      for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
      s.next('p1');
    }
    expect(s.phase).toBe('final');
    // 위와 같은 이유로, 최종 화면이 나간 뒤 누군가 이탈해도(p4) 이미 본 순위는
    // 바뀌면 안 된다 — 다시 계산했다면 이탈자 처리에 따라 값이 달라질 수 있다.
    const before = msgsOfType('final').at(-1)!;
    s.disconnect('p4');
    sent = [];
    s.join('p3', 'p3');
    const again = msgsTo('p3').filter((m) => m.t === 'final');
    expect(again.length).toBe(1);
    expect(again[0]).toEqual(before);
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
    // 힌트는 이제 개인 선택이라 회차를 끝내지 않는다.
    // 대신 살아있는 사람이 전부 답을 내면 끊긴 사람을 기다리지 않고 넘어가야 한다.
    s.answer('p2', '가');
    s.answer('p3', '나');
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
    drawStar('p1'); s.drawDone('p1'); for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
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
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
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
    while (s.phase === 'guessing') clock.fire();
    s.next('p1');
    expect(s.phase).toBe('lobby');
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.score).toBe(10);
  });

  // 체크포인트 B에서 걸린 버그다. 방장이 게임 도중(로비가 아닐 때) 끊기면 hostId가
  // 그대로 남아, 결과 화면에서 아무도 다음으로 넘길 수 없어 방이 영구히 멈춘다.
  it('방장이 라운드 도중 끊기면 살아있는 다른 사람에게 방장이 넘어간다', () => {
    drawStar('p1');
    s.drawDone('p1');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    expect(s.phase).toBe('roundEnd');
    s.disconnect('p1'); // 방장(출제자)이 결과 화면에서 나간다
    const hostId = msgsOfType('room').at(-1)!.hostId;
    expect(hostId).not.toBe('p1');
    expect(hostId).not.toBe('');
  });

  it('새 방장이 다음을 눌러 라운드를 진행시킬 수 있다', () => {
    drawStar('p1');
    s.drawDone('p1');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.disconnect('p1');
    // newHost를 room 메시지에서 다시 읽지 않고 p2로 못박는다 — 버그가 있으면
    // hostId가 여전히 'p1'을 가리켜, 그 값을 그대로 썼을 때 우연히 통과할 수 있다.
    s.next('p2');
    expect(s.phase).toBe('drawing');
  });

  // 원래 방장이 돌아와도 자리를 되찾지 않는다 — 진행을 맡고 있던 사람 밑에서
  // 방장을 몰래 바꿔치기하면 누가 방장인지 더 헷갈린다.
  it('원래 방장이 돌아와도 방장 자리를 되찾지 않는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.disconnect('p1');
    const newHost = msgsOfType('room').at(-1)!.hostId;
    sent = [];
    s.join('p1', 'p1'); // 원래 방장이 재접속한다
    expect(msgsOfType('room').at(-1)!.hostId).toBe(newHost);
  });

  it('방장이 끊길 때 남은 사람이 아무도 없어도 죽지 않는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.disconnect('p2');
    s.disconnect('p3');
    s.disconnect('p4');
    expect(() => s.disconnect('p1')).not.toThrow(); // 방장까지 끊긴다 — 아무도 안 남는다
    expect(msgsOfType('room').at(-1)!.hostId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 아래는 마지막 전체 리뷰에서 나온 수정들이다. 하나하나가 실제 플레이를 멈춰
// 세울 수 있는 것들이라, 재발 방지용 테스트를 붙여 둔다.
// ---------------------------------------------------------------------------

/** 결과 화면(roundEnd)까지 한 라운드를 끝까지 굴린다 */
/** 한 라운드를 아무도 못 맞힌 채 끝까지 돌린다. 회차 수는 규칙에서 가져온다. */
function playRound(): void {
  if (s.phase === 'drawing') { drawStar(s.drawerId); s.drawDone(s.drawerId); }
  for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
}

describe('결과 화면은 방장이 넘긴다', () => {
  beforeEach(() => { s.start('p1'); });

  // 처음에는 방장이 폰을 잠그면 방이 멈추는 것을 막으려고 자동 넘김을 뒀다.
  // 경쟁 게임으로 방향을 잡으면서 "결과를 언제까지 볼지는 방장이 정한다"로 바꿨다.
  // 그 대가로 방장이 조용하면 방이 기다린다 — 방장이 끊기면 승계는 그대로 일어난다.
  it('결과 화면에는 마감 시각이 없다', () => {
    playRound();
    expect(s.phase).toBe('roundEnd');
    expect(msgsOfType('room').at(-1)!.deadline).toBeNull();
  });

  it('시간이 흘러도 스스로 넘어가지 않는다', () => {
    playRound();
    clock.fire();
    clock.fire();
    expect(s.phase).toBe('roundEnd');
  });

  it('방장이 누르면 넘어간다', () => {
    playRound();
    s.next('p1');
    expect(s.phase).toBe('drawing');
    expect(msgsOfType('room').at(-1)!.round).toBe(1);
  });

  it('방장이 아니면 못 넘긴다', () => {
    playRound();
    s.next('p2');
    expect(s.phase).toBe('roundEnd');
  });

  it('방장이 끊기면 승계받은 사람이 넘길 수 있다', () => {
    playRound();
    s.disconnect('p1');
    const host = msgsOfType('room').at(-1)!.hostId;
    expect(host).not.toBe('p1');
    s.next(host);
    expect(s.phase).not.toBe('roundEnd');
  });
});

describe('한 판 더 (수정 2)', () => {
  function toFinal(): void {
    s.start('p1');
    for (let i = 0; i < 4; i++) { playRound(); s.next('p1'); }
    expect(s.phase).toBe('final');
  }

  it('최종 화면에서 한 판 더를 누르면 로비로 돌아간다', () => {
    toFinal();
    s.again('p1');
    expect(s.phase).toBe('lobby');
  });

  it('방장이 아니면 한 판 더를 누를 수 없다', () => {
    toFinal();
    s.again('p3');
    expect(s.phase).toBe('final');
  });

  // 방장 전용으로 바꿔도 방이 영구히 갇히지 않는 근거다. 이게 깨지면
  // 방장이 자리를 뜬 순간 그 방 코드는 최종 화면에서 죽는다.
  it('방장이 나가면 다음 사람이 한 판 더를 누를 수 있다', () => {
    toFinal();
    s.disconnect('p1');
    const host = msgsOfType('room').at(-1)!.hostId;
    expect(host).not.toBe('p1');
    s.again(host);
    expect(s.phase).toBe('lobby');
  });

  it('한 판 더를 하면 점수가 0으로 돌아간다', () => {
    toFinal();
    sent = [];
    s.again('p1');
    expect(msgsOfType('room').at(-1)!.players.every((p) => p.score === 0)).toBe(true);
  });

  it('한 판 더는 끊긴 사람을 방에서 내보낸다 — 방 코드를 다시 쓸 수 있어야 한다', () => {
    toFinal();
    s.disconnect('p4');
    sent = [];
    s.again('p1');
    const players = msgsOfType('room').at(-1)!.players;
    expect(players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('한 판 더 뒤에 다시 시작할 수 있다', () => {
    toFinal();
    s.again('p1');
    s.start('p1');
    expect(s.phase).toBe('drawing');
    expect(msgsOfType('room').at(-1)!.round).toBe(0);
    expect(msgsOfType('room').at(-1)!.totalRounds).toBe(4);
  });

  it('한 판 더 뒤에 다시 들어온 사람은 옛 순위를 다시 받지 않는다', () => {
    toFinal();
    s.again('p1');
    sent = [];
    s.join('p2', 'p2');
    expect(msgsTo('p2').filter((m) => m.t === 'final').length).toBe(0);
  });

  it('최종 화면이 아니면 한 판 더는 무시된다', () => {
    s.start('p1');
    s.again('p1');
    expect(s.phase).toBe('drawing');
  });
});

describe('이름 갱신 (수정 3)', () => {
  it('같은 사람이 이름을 다시 보내면 갱신된다', () => {
    s.join('p2', '진짜이름');
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.name).toBe('진짜이름');
  });

  it('이름이 비어 있으면 예전 이름을 지우지 않는다', () => {
    s.join('p2', '진짜이름');
    s.join('p2', '');
    expect(msgsOfType('room').at(-1)!.players.find((p) => p.id === 'p2')!.name).toBe('진짜이름');
  });
});

describe('결과 화면이 스스로 완결적이다 (수정 4)', () => {
  beforeEach(() => { s.start('p1'); });

  /** p2가 정답, p3가 오답을 적고 라운드가 끝난다 */
  function endWithAnswers(): void {
    const word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1'); s.drawDone('p1');
    // roundEnd에 실리는 것은 '마지막 회차'의 답이므로, 마지막 회차까지 간 뒤 답을 낸다.
    while (msgsOfType('room').at(-1)!.attempt < TEST_RULES.maxAttempts) clock.fire();
    s.answer('p2', word);
    s.answer('p3', '하마');
    s.answer('p4', '기린');
    while (s.phase === 'guessing') clock.fire();
  }

  it('roundEnd에 마지막 시도의 답이 함께 실린다', () => {
    endWithAnswers();
    const end = msgsOfType('roundEnd').at(-1)!;
    expect(end.answers.find((a) => a.playerId === 'p3')!.text).toBe('하마');
    expect(end.answers.find((a) => a.playerId === 'p2')!.correct).toBe(true);
  });

  it('결과 화면에서 새로고침해도 답 목록이 그대로 온다', () => {
    endWithAnswers();
    sent = [];
    s.join('p4', 'p4'); // 결과 화면에서 새로고침
    const again = msgsTo('p4').filter((m) => m.t === 'roundEnd').at(-1) as Extract<ServerMsg, { t: 'roundEnd' }>;
    expect(again.answers.find((a) => a.playerId === 'p3')!.text).toBe('하마');
  });
});

describe('넘기기 정족수 재확인 (수정 5)', () => {
  beforeEach(() => { s.start('p1'); });

  it('사람이 끊기면 남은 사람의 답만으로 회차가 끝난다', () => {
    // 맞히는 사람 셋 중 둘이 답을 냈다. 남은 한 명이 끊기면 그를 기다릴 이유가 없으므로
    // 아무도 다시 아무것도 하지 않아도 회차가 끝나야 한다.
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.answer('p2', '가');
    s.answer('p3', '나');
    sent = [];
    expect(msgsOfType('attemptResult').length).toBe(0);
    s.disconnect('p4'); // 마지막 한 명이 사라지면 그를 기다릴 이유가 없다
    expect(msgsOfType('attemptResult').length).toBeGreaterThan(0);
  });

  it('맞히는 사람이 전부 끊기면 라운드를 접는다', () => {
    drawStar('p1'); s.drawDone('p1');
    s.disconnect('p2');
    s.disconnect('p3');
    s.disconnect('p4');
    expect(s.phase).toBe('roundEnd');
  });

  it('그리기가 끝날 때 맞히는 사람이 없으면 바로 라운드를 접는다', () => {
    drawStar('p1');
    s.disconnect('p2'); s.disconnect('p3'); s.disconnect('p4');
    s.drawDone('p1');
    expect(s.phase).toBe('roundEnd');
  });
});

describe('라운드 사이 상태 청소 (수정 6)', () => {
  it('다음 라운드에 지난 라운드의 답·넘기기 표시가 남지 않는다', () => {
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.answer('p2', '아무거나');
    s.skip('p3');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.next('p1');
    const room = msgsOfType('room').at(-1)!;
    expect(room.attempt).toBe(1);
    expect(room.players.some((p) => p.answered)).toBe(false);
    expect(room.players.some((p) => p.skipped)).toBe(false);
  });

  it('결과 화면에서도 시도 표시가 새 라운드 값으로 튀지 않는다', () => {
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    expect(msgsOfType('room').at(-1)!.attempt).toBe(TEST_RULES.maxAttempts); // 결과 화면은 방금 끝난 시도를 보여준다
    s.next('p1');
    expect(msgsOfType('room').at(-1)!.attempt).toBe(1);
  });
});

describe('유령 정리 (수정 7)', () => {
  it('로비로 돌아갈 때 끊긴 사람을 내보낸다', () => {
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.disconnect('p3'); s.disconnect('p4');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.next('p1');
    expect(s.phase).toBe('lobby');
    expect(msgsOfType('room').at(-1)!.players.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('유령을 머릿수로 세어 게임을 시작하지 않는다', () => {
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.disconnect('p3'); s.disconnect('p4');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.next('p1');
    s.start('p1'); // 실제로는 두 명뿐이다
    expect(s.phase).toBe('lobby');
  });

  it('유령 때문에 진짜 사람을 방이 가득 찼다고 막지 않는다', () => {
    newSession(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    s.start('p1');
    for (const id of ['p5', 'p6', 'p7', 'p8', 'p9']) s.disconnect(id);
    sent = [];
    s.join('p10', '늦둥이');
    expect(msgsTo('p10').filter((m) => m.t === 'error').length).toBe(0);
    expect(msgsOfType('room').at(-1)!.players.some((p) => p.id === 'p10')).toBe(true);
  });

  it('로비로 돌아간 뒤 라운드 수가 실제 인원과 맞는다', () => {
    newSession(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.disconnect('p5'); s.disconnect('p6');
    for (let _i = 0; _i < TEST_RULES.maxAttempts; _i++) clock.fire();
    s.next('p1');
    expect(s.phase).toBe('drawing'); // 4명 남았으니 계속 간다
    s.disconnect('p3'); s.disconnect('p4');
    playRound();
    s.next(msgsOfType('room').at(-1)!.hostId);
    expect(s.phase).toBe('lobby');
    s.join('a', 'a'); s.join('b', 'b');
    s.start('p1');
    expect(msgsOfType('room').at(-1)!.totalRounds).toBe(4); // p1, p2, a, b
  });
});

describe('한 게임 안에서 제시어가 겹치지 않는다 (수정 10)', () => {
  it('라운드마다 다른 제시어가 나온다', () => {
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock,
      rules: { ...TEST_RULES },
      pick: () => 0, // 늘 첫 번째를 고른다 — 제외 목록이 없으면 매번 같은 단어가 나온다
      shuffle: (xs) => xs,
      topics: [{ topic: '동물', words: ['호랑이', '펭귄', '코끼리', '토끼', '여우'] }],
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
    s.start('p1');

    const words: string[] = [];
    for (let i = 0; i < 4; i++) {
      words.push((msgsTo(s.drawerId).filter((m) => m.t === 'word').at(-1) as Extract<ServerMsg, { t: 'word' }>).word);
      playRound();
      s.next('p1');
    }
    expect(new Set(words).size).toBe(4);
  });

  it('단어가 바닥나면 멈추지 않고 중복을 허용한다', () => {
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock,
      rules: { ...TEST_RULES },
      pick: () => 0,
      shuffle: (xs) => xs,
      topics: [{ topic: '동물', words: ['호랑이', '펭귄'] }], // 4라운드에 2단어뿐
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
    s.start('p1');
    for (let i = 0; i < 4; i++) { playRound(); s.next('p1'); }
    expect(s.phase).toBe('final'); // 무한 루프에 빠지지 않고 끝까지 간다
  });

  it('한 판 더를 하면 제시어 목록이 초기화된다', () => {
    s.start('p1');
    for (let i = 0; i < 4; i++) { playRound(); s.next('p1'); }
    s.again('p1');
    s.start('p1');
    expect(s.phase).toBe('drawing'); // 단어 풀이 비어 멈추면 안 된다
  });
});

describe('주제 고르기', () => {
  const topics = [
    { topic: '동물', words: ['호랑이', '펭귄', '코끼리', '토끼', '여우', '곰'] },
    { topic: '음식', words: ['피자', '김밥', '라면', '치킨', '초밥', '만두'] },
  ];

  function withTopics() {
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs, topics,
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
  }

  it('기본은 랜덤이고, 고를 수 있는 주제가 함께 온다', () => {
    withTopics();
    const room = msgsOfType('room').at(-1)!;
    expect(room.selectedTopic).toBeNull();
    expect(room.topics).toEqual(['동물', '음식']);
  });

  it('방장이 고른 주제로만 문제가 나온다', () => {
    withTopics();
    s.setTopic('p1', '음식');
    s.start('p1');
    for (let i = 0; i < 3; i++) {
      expect(msgsOfType('room').at(-1)!.topic).toBe('음식');
      playRound();
      s.next('p1');
    }
  });

  it('방장이 아니면 못 고른다', () => {
    withTopics();
    s.setTopic('p2', '음식');
    expect(msgsOfType('room').at(-1)!.selectedTopic).toBeNull();
  });

  it('없는 주제는 무시한다', () => {
    withTopics();
    s.setTopic('p1', '우주');
    expect(msgsOfType('room').at(-1)!.selectedTopic).toBeNull();
  });

  it('게임이 시작된 뒤에는 못 바꾼다', () => {
    withTopics();
    s.start('p1');
    s.setTopic('p1', '음식');
    expect(msgsOfType('room').at(-1)!.selectedTopic).toBeNull();
  });

  it('랜덤으로 되돌릴 수 있다', () => {
    withTopics();
    s.setTopic('p1', '음식');
    expect(msgsOfType('room').at(-1)!.selectedTopic).toBe('음식');
    s.setTopic('p1', null);
    expect(msgsOfType('room').at(-1)!.selectedTopic).toBeNull();
  });

  it('고른 주제의 단어가 바닥나도 주제를 바꾸지 않는다', () => {
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs,
      topics: [{ topic: '동물', words: ['호랑이', '펭귄'] }, { topic: '음식', words: ['피자'] }],
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
    s.setTopic('p1', '동물');
    s.start('p1');
    for (let i = 0; i < 4; i++) {
      expect(msgsOfType('room').at(-1)!.topic).toBe('동물'); // 단어가 떨어져도 음식으로 안 샌다
      playRound();
      s.next('p1');
    }
  });
});

describe('현황판은 사람별로 보여준다', () => {
  let wordOfRound: string;

  beforeEach(() => {
    s.start('p1');
    wordOfRound = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
  });

  const boardTo = (id: string) =>
    msgsTo(id).filter((m) => m.t === 'board').at(-1) as Extract<ServerMsg, { t: 'board' }> | undefined;

  it('출제자는 맞히는 사람마다 한 줄씩 받는다', () => {
    clock.fire();
    const b = boardTo('p1')!;
    expect(b.watching.map((w) => w.playerId).sort()).toEqual(['p2', 'p3', 'p4']);
  });

  it('각 줄에는 그 사람이 실제로 들고 있는 조각만 들어간다', () => {
    clock.fire();
    const b = boardTo('p1')!;
    for (const w of b.watching) {
      const mine = msgsTo(w.playerId).filter((m) => m.t === 'slices').at(-1) as Extract<ServerMsg, { t: 'slices' }>;
      expect(w.slices.length).toBe(mine.slices.length);
    }
  });

  it('맞힌 사람은 맞혔다고 표시된다', () => {
    // beforeEach가 sent를 비우기 전에 나간 word 메시지를 라운드 시작 시점에서 되찾는다
    const word = wordOfRound;
    s.answer('p2', word);
    clock.fire();
    const b = boardTo('p1')!;
    expect(b.watching.find((w) => w.playerId === 'p2')!.solved).toBe(true);
  });

  it('맞히는 사람에게는 현황판이 가지 않는다', () => {
    clock.fire();
    expect(boardTo('p3')).toBeUndefined();
  });
});
