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
  startScore: 10, wrongSubmitCost: 1, attemptCost: 1, finalAttemptScore: 1, drawerScore: 5, wordRerolls: 2,
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
    s.addDoodle('p2', LINE, '#6fb6e8');
    expect(doodlesTo('p3').length).toBe(1);
    expect(doodlesTo('p4').length).toBe(1);
    // 그린 사람에게도 간다 — 화면을 서버 상태로 맞춰두면 새로고침해도 어긋나지 않는다
    expect(doodlesTo('p2').length).toBe(1);
  });

  it('출제자에게는 낙서가 가지 않는다', () => {
    s.addDoodle('p2', LINE, '#6fb6e8');
    expect(doodlesTo('p1').length).toBe(0);
  });

  it('출제자는 낙서판에 그릴 수 없다 — 자기 캔버스가 따로 있다', () => {
    s.addDoodle('p1', LINE, '#6fb6e8');
    expect(doodlesTo('p2').length).toBe(0);
  });

  it('추론이 시작되면 더 이상 낙서를 받지 않는다', () => {
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
    s.addDoodle('p2', LINE, '#6fb6e8');
    expect(doodlesTo('p3').length).toBe(0);
  });

  it('내 낙서만 지운다 — 남의 낙서는 남는다', () => {
    s.addDoodle('p2', LINE, '#6fb6e8');
    s.addDoodle('p3', LINE, '#6fb6e8');
    sent = [];
    s.clearDoodle('p2');
    const board = msgsTo('p3').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(1);
    expect(board.strokes[0].by).toBe('p3');
  });

  it('돌아온 사람은 지금까지의 낙서판을 통째로 받는다', () => {
    s.addDoodle('p2', LINE, '#6fb6e8');
    s.disconnect('p3');
    sent = [];
    s.join('p3', 'p3');
    const board = msgsTo('p3').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(1);
  });

  it('라운드가 바뀌면 낙서판이 비워진다', () => {
    s.addDoodle('p2', LINE, '#6fb6e8');
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

  it('조각만 보고 다들 맞혀버리면 출제자는 아무것도 못 받는다', () => {
    // 라운드가 조립판에 닿기도 전에 끝난다. 조각으로 알아볼 그림을 그린 값이다.
    s.answer('p2', word); s.answer('p3', word); s.answer('p4', word);
    expect(deltaOf('p1')).toBe(0);
  });

  it('조립판에서 한 명이 맞히면 출제자가 5점을 받는다', () => {
    for (let i = 0; i < 5; i++) clock.fire();   // 조립판까지 아무도 못 맞힌다
    s.answer('p2', word);
    finish();
    expect(deltaOf('p1')).toBe(TEST_RULES.drawerScore);
  });

  it('조립판에서 여럿이 맞혀도 출제자 몫은 그대로 5점이다', () => {
    for (let i = 0; i < 5; i++) clock.fire();
    s.answer('p2', word); s.answer('p3', word); s.answer('p4', word);
    finish();
    expect(deltaOf('p1')).toBe(TEST_RULES.drawerScore);
  });

  it('조립판에서도 아무도 못 맞히면 출제자는 못 받는다', () => {
    for (let i = 0; i < 5; i++) clock.fire();
    s.answer('p2', '엉뚱한답');
    finish();
    expect(deltaOf('p1')).toBe(0);
  });

  it('먼저 맞힌 사람이 있어도 조립판에서 나머지가 맞히면 출제자가 받는다', () => {
    s.answer('p2', word);                       // 1회차에 p2만 맞힌다
    for (let i = 0; i < 5; i++) clock.fire();
    s.answer('p3', word);                       // 조립판에서 p3가 맞힌다
    finish();
    expect(deltaOf('p1')).toBe(TEST_RULES.drawerScore);
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

  it('이미 답을 낸 사람이 끊기면 남은 사람 기준으로 회차가 끝난다', () => {
    // 맞히는 사람 셋 중 둘이 답을 냈다. 남은 한 명이 끊기면 그를 기다릴 이유가 없으므로
    // 아무도 다시 아무것도 하지 않아도 회차가 끝나야 한다.
    s.start('p1');
    drawStar('p1'); s.drawDone('p1');
    s.answer('p2', '가');
    s.answer('p3', '나');
    s.answer('p4', '다');   // p4도 답을 냈다
    // 셋이 다 냈으므로 이 시점에 이미 회차가 끝난다
    expect(msgsOfType('attemptResult').length).toBeGreaterThan(0);
    sent = [];
    s.disconnect('p4');
    expect(s.phase).not.toBe('lobby');
  });

  it('아직 아무것도 안 한 사람이 끊기면 기다려준다 — 잠깐 끊긴 사람의 기회를 뺏지 않는다', () => {
    drawStar('p1'); s.drawDone('p1');
    s.answer('p2', '가');
    s.answer('p3', '나');
    sent = [];
    s.disconnect('p4');  // p4는 답도 스킵도 안 했다
    expect(msgsOfType('attemptResult').length).toBe(0);
    expect(s.phase).toBe('guessing');
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

describe('현황판에 회차별 답 기록이 쌓인다', () => {
  let wordOfRound: string;

  beforeEach(() => {
    s.start('p1');
    wordOfRound = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    drawStar('p1');
    s.drawDone('p1');
    sent = [];
  });

  const board = () =>
    msgsTo('p1').filter((m) => m.t === 'board').at(-1) as Extract<ServerMsg, { t: 'board' }>;
  const historyOf = (id: string) => board().watching.find((w) => w.playerId === id)!.history;

  it('회차가 끝나야 남는다 — 치는 도중에는 안 보인다', () => {
    s.answer('p2', '파스타');
    expect(board()?.watching.find((w) => w.playerId === 'p2')?.history ?? []).toEqual([]);
    clock.fire();
    expect(historyOf('p2')).toEqual([{ attempt: 1, text: '파스타', skipped: false, correct: false }]);
  });

  it('안 쓴 사람은 빈 문자열로 남는다', () => {
    clock.fire();
    expect(historyOf('p3')[0].text).toBe('');
  });

  it('스킵을 누른 사람은 스킵으로 남는다', () => {
    s.skip('p2'); s.skip('p3'); s.skip('p4');
    expect(historyOf('p2')[0].skipped).toBe(true);
  });

  it('회차마다 한 줄씩 쌓인다', () => {
    s.answer('p2', '파스타'); clock.fire();
    s.answer('p2', '라면');   clock.fire();
    expect(historyOf('p2').map((h) => h.text)).toEqual(['파스타', '라면']);
    expect(historyOf('p2').map((h) => h.attempt)).toEqual([1, 2]);
  });

  it('맞힌 답도 정답으로 남는다', () => {
    s.answer('p2', wordOfRound);
    clock.fire();
    expect(historyOf('p2').at(-1)).toMatchObject({ text: wordOfRound, correct: true });
  });

  it('새 라운드가 시작되면 기록이 지워진다', () => {
    s.answer('p2', '파스타');
    while (s.phase === 'guessing') clock.fire();
    s.next('p1');
    drawStar(s.drawerId); s.drawDone(s.drawerId);
    const b = msgsTo(s.drawerId).filter((m) => m.t === 'board').at(-1) as Extract<ServerMsg, { t: 'board' }>;
    for (const w of b.watching) expect(w.history).toEqual([]);
  });
});

describe('낙서 색', () => {
  beforeEach(() => { s.start('p1'); });

  const colorOf = (id: string) =>
    msgsOfType('room').at(-1)!.players.find((p) => p.id === id)!.doodleColor;
  const strokeColor = (to: string) =>
    (msgsTo(to).filter((m) => m.t === 'doodleStroke').at(-1) as Extract<ServerMsg, { t: 'doodleStroke' }>).color;

  /** 라운드 시작에 p2·p3·p4가 앞쪽 색을 가져가므로, 아무도 안 쓰는 색을 찾아 쓴다. */
  const freeColor = () => {
    const taken = new Set(msgsOfType('room').at(-1)!.players.map((p) => p.doodleColor));
    return Session.DOODLE_PALETTE.find((c) => !taken.has(c))!;
  };

  it('고른 색이 그대로 전달된다', () => {
    const c = freeColor();
    s.setDoodleColor('p2', c);
    s.addDoodle('p2', [[10, 10], [20, 20]], c);
    expect(strokeColor('p3')).toBe(c);
  });

  it('팔레트에 없는 색은 무시하고 배정된 색을 쓴다', () => {
    // 색은 남의 화면에 그대로 들어가는 값이라 목록 밖은 받지 않는다.
    s.addDoodle('p2', [[10, 10], [20, 20]], 'red; background:url(x)');
    expect(Session.DOODLE_PALETTE).toContain(strokeColor('p3'));
  });

  it('남이 쓰는 색도 고를 수 있다', () => {
    const p2Color = colorOf('p2');
    s.setDoodleColor('p3', p2Color);
    expect(colorOf('p3')).toBe(p2Color);
    expect(colorOf('p2')).toBe(p2Color); // 뺏기는 것이 아니라 같이 쓴다
  });

  it('색이 같아도 지우기는 사람 단위다 — 색을 풀어줄 수 있는 근거다', () => {
    const c = colorOf('p2');
    s.setDoodleColor('p3', c);
    s.addDoodle('p2', [[10, 10], [20, 20]], c);
    s.addDoodle('p3', [[30, 30], [40, 40]], c);
    sent = [];
    s.clearDoodle('p2');
    const board = msgsTo('p4').filter((m) => m.t === 'doodleBoard').at(-1) as Extract<ServerMsg, { t: 'doodleBoard' }>;
    expect(board.strokes.length).toBe(1);
    expect(board.strokes[0].by).toBe('p3');
    expect(board.strokes[0].color).toBe(c);
  });

  it('아무도 안 쓰는 색은 고를 수 있다', () => {
    const c = freeColor();
    s.setDoodleColor('p2', c);
    expect(colorOf('p2')).toBe(c);
  });

  it('라운드가 시작되면 기다리는 사람 전원이 서로 다른 색을 미리 받는다', () => {
    // 그릴 때 배정하면, 첫 획을 긋기 전까지 남의 팔레트에는 그 색이 비어 보인다.
    const cs = [colorOf('p2'), colorOf('p3'), colorOf('p4')];
    expect(cs.every((c) => c !== '')).toBe(true);
    expect(new Set(cs).size).toBe(3);
  });
});


describe('관전 자리', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;
  const info = (id: string) => roomNow().players.find((p) => p.id === id)!;

  beforeEach(() => { newSession(['p1', 'p2', 'p3', 'p4', 'p5']); });

  it('로비에서 관전을 고를 수 있다', () => {
    s.setSpectator('p5', true);
    expect(info('p5').spectator).toBe(true);
  });

  it('시작한 뒤에는 관전을 켜지도 끄지도 못한다', () => {
    s.setSpectator('p5', true);
    s.start('p1');
    s.setSpectator('p5', false);
    expect(info('p5').spectator).toBe(true);   // 못 껐다
    s.setSpectator('p4', true);
    expect(info('p4').spectator).toBe(false);  // 못 켰다
  });

  it('관전자는 조각을 받지 않고 출제 차례도 안 온다', () => {
    s.setSpectator('p5', true);
    s.start('p1');
    expect(roomNow().totalRounds).toBe(4);     // p5는 순번에 없다
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    expect(msgsTo('p5').filter((m) => m.t === 'slices').length).toBe(0);
    expect(info('p5').sliceCount).toBe(0);
  });

  it('관전자는 제시어와 그려지는 원본을 본다', () => {
    s.setSpectator('p5', true);
    sent = [];
    s.start('p1');
    const word = msgsTo('p5').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>;
    expect(word).toBeDefined();
    expect(word.word.length).toBeGreaterThan(0);

    sent = [];
    s.addStroke('p1', [[300, 200], [400, 300]]);
    const canvas = msgsTo('p5').filter((m) => m.t === 'canvas').at(-1) as Extract<ServerMsg, { t: 'canvas' }>;
    expect(canvas.strokes.length).toBe(1);
  });

  it('관전자는 추론 중에 현황판을 받는다', () => {
    s.setSpectator('p5', true);
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    sent = [];
    s.drawDone('p1');
    expect(msgsTo('p5').filter((m) => m.t === 'board').length).toBeGreaterThan(0);
  });

  it('관전자는 낙서판에 그릴 수 없다 — 정답을 아는 사람이 그리면 그게 유출이다', () => {
    s.setSpectator('p5', true);
    s.start('p1');
    sent = [];
    s.addDoodle('p5', [[10, 10], [20, 20]], '#6fb6e8');
    expect(msgsOfType('doodleStroke').length).toBe(0);
  });

  it('관전자도 남의 낙서는 볼 수 있다 — 보는 것으로는 아무것도 새지 않는다', () => {
    s.setSpectator('p5', true);
    s.start('p1');
    sent = [];
    s.addDoodle('p2', [[10, 10], [20, 20]], '#6fb6e8');
    expect(msgsTo('p5').filter((m) => m.t === 'doodleStroke').length).toBe(1);
    expect(msgsTo('p3').filter((m) => m.t === 'doodleStroke').length).toBe(1);
    // 출제자는 여전히 안 받는다. 그릴 화면 자체가 다르다.
    expect(msgsTo('p1').filter((m) => m.t === 'doodleStroke').length).toBe(0);
  });

  it('관전자만 남으면 시작할 수 없다', () => {
    for (const id of ['p2', 'p3', 'p4', 'p5']) s.setSpectator(id, true);
    sent = [];
    s.start('p1');
    expect(msgsTo('p1').some((m) => m.t === 'error')).toBe(true);
    // 거절당하면 room을 다시 보내지 않으므로 세션을 직접 본다.
    expect(s.phase).toBe('lobby');
  });
});

describe('게임 도중 들어온 사람은 판이 끝날 때까지 관전이다', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;
  const info = (id: string) => roomNow().players.find((p) => p.id === id)!;

  beforeEach(() => {
    newSession();
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    s.join('p9', '늦둥이');   // 추론 중에 난입
  });

  it('난입자는 관전자로 앉는다', () => {
    expect(info('p9').spectator).toBe(true);
  });

  it('다음 라운드가 와도 조각을 받지 못한다', () => {
    // 예전에는 여기서 슬쩍 합류시켰다. 그러면 남들이 한 판을 다 도는 동안
    // 이 사람만 출제 없이 맞히기만 한다.
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
    s.next('p1');
    s.addStroke('p2', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    sent = [];
    s.drawDone('p2');
    expect(msgsTo('p9').filter((m) => m.t === 'slices').length).toBe(0);
    expect(info('p9').spectator).toBe(true);
  });

  it('판이 끝나 로비로 돌아오기 전에는 참여로 못 바꾼다', () => {
    s.setSpectator('p9', false);
    expect(info('p9').spectator).toBe(true);
  });

  it('한 판 더로 로비에 돌아오면 그때 참여로 바꾼다', () => {
    while (roomNow().phase !== 'final') {
      for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
      s.next('p1');
    }
    s.again('p1');
    expect(roomNow().phase).toBe('lobby');
    s.setSpectator('p9', false);
    expect(info('p9').spectator).toBe(false);
  });
});

describe('제출과 스킵은 서로를 지운다', () => {
  beforeEach(() => {
    newSession();
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
  });

  it('답을 낸 뒤 스킵을 누르면 낸 답이 사라진다 — 화면이 스킵을 잠그는 이유다', () => {
    const word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    s.answer('p2', word);
    s.skip('p2');
    clock.fire();
    const rows = msgsOfType('attemptResult').at(-1)!.answers;
    expect(rows.find((r) => r.playerId === 'p2')!.correct).toBe(false);
    expect(rows.find((r) => r.playerId === 'p2')!.text).toBe('');
  });

  it('답을 낸 사람은 서버 정족수에서 이미 마친 것으로 센다', () => {
    // 그래서 스킵을 잠가도 회차가 늦게 끝나지 않는다. p2는 스킵을 안 눌렀는데도
    // p3·p4가 누르는 순간 회차가 끝나야 한다 — 답을 낸 것이 곧 마친 것이다.
    const word = (msgsTo('p1').find((m) => m.t === 'word') as Extract<ServerMsg, { t: 'word' }>).word;
    expect(msgsOfType('room').at(-1)!.attempt).toBe(1);
    s.answer('p2', word);
    s.skip('p3');
    expect(msgsOfType('room').at(-1)!.attempt).toBe(1);   // 아직 p4가 남았다
    s.skip('p4');
    expect(msgsOfType('room').at(-1)!.attempt).toBe(2);   // 시간을 안 흘렸는데 넘어갔다
  });
});

describe('이야기 — 결과·최종 화면에서만', () => {
  const chats = () => msgsOfType('chat');
  const drawStar = (id: string) => s.addStroke(id, [[300, 200], [400, 300], [200, 400], [300, 200]]);
  /** 결과 화면까지 간다 */
  const toRoundEnd = () => {
    s.start('p1');
    drawStar('p1');
    s.drawDone('p1');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
  };

  beforeEach(() => { newSession(); });

  it('로비에서는 받지 않는다', () => {
    s.chat('p2', '안녕');
    expect(chats().length).toBe(0);
  });

  it('맞히는 중에는 받지 않는다 — 한 줄이면 점수가 무너진다', () => {
    // 그 자리에는 정답을 아는 사람이 셋 있다: 출제자, 관전자, 먼저 맞힌 사람.
    s.start('p1');
    drawStar('p1');
    s.drawDone('p1');
    s.chat('p1', '낙타야');
    expect(chats().length).toBe(0);
  });

  it('결과 화면에서는 받아서 전원에게 보낸다', () => {
    toRoundEnd();
    sent = [];
    s.chat('p2', '아 그게 그거였어?');
    const line = (chats().at(-1) as Extract<ServerMsg, { t: 'chat' }>).line;
    expect(line.text).toBe('아 그게 그거였어?');
    expect(line.name).toBe('p2');
    expect(line.color).not.toBe('');
    expect(new Set(sent.filter((e) => e.msg.t === 'chat').map((e) => e.to)).size).toBe(4);
  });

  it('한 사람이 몇 마디든 이어서 쓸 수 있다', () => {
    toRoundEnd();
    sent = [];
    s.chat('p2', '한마디');
    s.chat('p2', '두마디');
    s.chat('p2', '세마디');
    // 한 줄이 네 명에게 각각 가므로, 한 사람이 받은 것만 본다.
    const texts = msgsTo('p3').filter((m) => m.t === 'chat')
      .map((m) => (m as Extract<ServerMsg, { t: 'chat' }>).line.text);
    expect(texts).toEqual(['한마디', '두마디', '세마디']);
  });

  it('빈 줄과 공백만 있는 줄은 버린다', () => {
    toRoundEnd();
    sent = [];
    s.chat('p2', '   ');
    s.chat('p2', '');
    expect(chats().length).toBe(0);
  });

  it('100자를 넘으면 자른다', () => {
    toRoundEnd();
    sent = [];
    s.chat('p2', 'ㅋ'.repeat(300));
    expect((chats().at(-1) as Extract<ServerMsg, { t: 'chat' }>).line.text.length).toBe(100);
  });

  it('라운드가 넘어가도 지난 이야기가 남는다', () => {
    toRoundEnd();
    s.chat('p2', '1라운드 소감');
    s.next('p1');
    drawStar('p2');
    s.drawDone('p2');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
    sent = [];
    s.join('p2', 'p2');   // 되돌려 받는 것으로 로그를 확인한다
    const log = msgsTo('p2').find((m) => m.t === 'chatLog') as Extract<ServerMsg, { t: 'chatLog' }>;
    expect(log.lines.map((l) => l.text)).toEqual(['1라운드 소감']);
    expect(log.lines[0].round).toBe(0);
  });

  it('돌아온 사람은 지금까지의 이야기를 통째로 받는다', () => {
    toRoundEnd();
    s.chat('p2', '가');
    s.chat('p3', '나');
    s.disconnect('p2');
    sent = [];
    s.join('p2', 'p2');
    const log = msgsTo('p2').find((m) => m.t === 'chatLog') as Extract<ServerMsg, { t: 'chatLog' }>;
    expect(log.lines.map((l) => l.text)).toEqual(['가', '나']);
  });

  it('한 판 더를 하면 이야기도 비워진다', () => {
    while (msgsOfType('room').at(-1)!.phase !== 'final') {
      if (msgsOfType('room').at(-1)!.phase === 'lobby') toRoundEnd();
      else { s.next('p1'); drawStar(s.drawerId); s.drawDone(s.drawerId);
             for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire(); }
    }
    s.chat('p2', '재밌었다');
    s.again('p1');
    sent = [];
    s.join('p2', 'p2');
    expect(msgsTo('p2').some((m) => m.t === 'chatLog')).toBe(false);
  });

  it('최종 화면에서 쓴 말은 어느 라운드에도 안 붙는다', () => {
    while (msgsOfType('room').at(-1)!.phase !== 'final') {
      if (msgsOfType('room').at(-1)!.phase === 'lobby') toRoundEnd();
      else { s.next('p1'); drawStar(s.drawerId); s.drawDone(s.drawerId);
             for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire(); }
    }
    sent = [];
    s.chat('p2', '한 판 더 하자');
    expect((chats().at(-1) as Extract<ServerMsg, { t: 'chat' }>).line.round).toBe(-1);
  });
});

describe('방장이 관전을 켜면 방장을 넘긴다', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;
  beforeEach(() => { newSession(['p1', 'p2', 'p3', 'p4', 'p5']); });

  it('참여 중인 사람에게 넘어간다', () => {
    expect(roomNow().hostId).toBe('p1');
    s.setSpectator('p1', true);
    expect(roomNow().hostId).not.toBe('p1');
    const next = roomNow().players.find((p) => p.id === roomNow().hostId)!;
    expect(next.spectator).toBe(false);
  });

  it('관전자에게는 안 넘긴다', () => {
    // 구경하러 온 사람 뒤에 시작·다음 버튼이 잠기면 전원이 그 사람을 기다린다.
    s.setSpectator('p2', true);
    s.setSpectator('p1', true);
    expect(roomNow().hostId).not.toBe('p1');
    expect(roomNow().hostId).not.toBe('p2');
  });

  it('넘길 사람이 없으면 그대로 둔다 — 아무도 못 누르는 것보다 낫다', () => {
    for (const id of ['p2', 'p3', 'p4', 'p5']) s.setSpectator(id, true);
    s.setSpectator('p1', true);
    expect(roomNow().hostId).toBe('p1');
  });

  it('참여로 되돌려도 방장을 돌려받지 않는다', () => {
    s.setSpectator('p1', true);
    const taken = roomNow().hostId;
    s.setSpectator('p1', false);
    expect(roomNow().hostId).toBe(taken);
  });
});

describe('방장은 늘 참여 중인 사람에게 넘어간다', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;

  it('로비에서 방장이 나가면 관전자를 건너뛴다', () => {
    newSession(['p1', 'p2', 'p3', 'p4']);
    s.setSpectator('p2', true);
    s.disconnect('p1');
    expect(roomNow().hostId).toBe('p3');
  });

  it('게임 중에 방장이 끊겨도 관전자를 건너뛴다', () => {
    newSession(['p1', 'p2', 'p3', 'p4', 'p5']);
    s.setSpectator('p2', true);
    s.start('p1');
    s.disconnect('p1');
    expect(roomNow().hostId).toBe('p3');
  });

  it('참여자가 아무도 안 남으면 관전자라도 세운다', () => {
    // 아무도 못 누르는 방이 되는 것보다는 낫다.
    newSession(['p1', 'p2']);
    s.setSpectator('p2', true);
    s.disconnect('p1');
    expect(roomNow().hostId).toBe('p2');
  });
});

describe('제시어 바꾸기', () => {
  const wordTo = (id: string) =>
    (msgsTo(id).filter((m) => m.t === 'word').at(-1) as Extract<ServerMsg, { t: 'word' }>);

  beforeEach(() => { newSession(); s.start('p1'); });

  it('출제자가 바꾸면 다른 제시어가 온다', () => {
    const before = wordTo('p1');
    expect(before.rerollsLeft).toBe(TEST_RULES.wordRerolls);
    s.rerollWord('p1');
    const after = wordTo('p1');
    expect(after.word).not.toBe(before.word);
    expect(after.rerollsLeft).toBe(TEST_RULES.wordRerolls - 1);
  });

  it('주제는 그대로다 — 맞히는 사람들이 이미 받은 힌트가 거짓이 되면 안 된다', () => {
    const topic = msgsOfType('room').at(-1)!.topic;
    s.rerollWord('p1');
    expect(msgsOfType('room').at(-1)!.topic).toBe(topic);
  });

  it('그리던 것은 지운다 — 다른 단어를 보고 그린 선이다', () => {
    s.addStroke('p1', [[300, 200], [400, 300]]);
    expect(s.strokeCount).toBe(1);
    s.rerollWord('p1');
    expect(s.strokeCount).toBe(0);
  });

  it('정해진 횟수를 넘으면 안 바뀐다', () => {
    for (let i = 0; i < TEST_RULES.wordRerolls; i++) s.rerollWord('p1');
    const last = wordTo('p1');
    expect(last.rerollsLeft).toBe(0);
    s.rerollWord('p1');
    expect(wordTo('p1').word).toBe(last.word);
  });

  it('출제자가 아니면 못 바꾼다', () => {
    const before = wordTo('p1');
    s.rerollWord('p2');
    expect(wordTo('p1').word).toBe(before.word);
  });

  it('그리는 중이 아니면 못 바꾼다', () => {
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    const before = wordTo('p1');
    s.rerollWord('p1');
    expect(wordTo('p1').word).toBe(before.word);
  });

  it('라운드가 바뀌면 횟수가 다시 찬다', () => {
    s.rerollWord('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
    s.next('p1');
    expect(wordTo('p2').rerollsLeft).toBe(TEST_RULES.wordRerolls);
  });
});

describe('이름은 도중에 들어온 사람만 바꾼다', () => {
  const nameOf = (id: string) =>
    msgsOfType('room').at(-1)!.players.find((p) => p.id === id)!.name;
  const canRename = (id: string) =>
    msgsOfType('room').at(-1)!.players.find((p) => p.id === id)!.canRename;

  beforeEach(() => {
    newSession();
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    s.join('p9', '손님');
  });

  it('난입자는 바꿀 수 있다', () => {
    expect(canRename('p9')).toBe(true);
    s.join('p9', '늦둥이');
    expect(nameOf('p9')).toBe('늦둥이');
  });

  it('원래 있던 사람은 못 바꾼다 — 쌓인 기록이 누구 것인지 어긋난다', () => {
    expect(canRename('p2')).toBe(false);
    s.join('p2', '딴사람');
    expect(nameOf('p2')).toBe('p2');
  });

  it('로비에서는 누구나 바꾼다', () => {
    newSession();
    s.join('p2', '바꾼이름');
    expect(nameOf('p2')).toBe('바꾼이름');
  });

  it('새 판이 시작되면 아무도 늦게 온 사람이 아니다', () => {
    while (msgsOfType('room').at(-1)!.phase !== 'final') {
      for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
      s.next('p1');
      if (s.phase === 'drawing') {
        s.addStroke(s.drawerId, [[300, 200], [400, 300], [200, 400], [300, 200]]);
        s.drawDone(s.drawerId);
      }
    }
    s.again('p1');
    s.start('p1');
    expect(canRename('p9')).toBe(false);
  });
});

describe('관전자는 점수판 어디에도 안 나온다', () => {
  it('결과 화면 점수줄과 최종 등수에서 빠진다', () => {
    newSession(['p1', 'p2', 'p3', 'p4', 'p5']);
    s.setSpectator('p5', true);
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();

    const end = msgsOfType('roundEnd').at(-1)!;
    expect(end.scores.map((x) => x.playerId)).not.toContain('p5');
    expect(end.answers.map((x) => x.playerId)).not.toContain('p5');

    while (msgsOfType('room').at(-1)!.phase !== 'final') {
      s.next('p1');
      if (s.phase === 'drawing') {
        s.addStroke(s.drawerId, [[300, 200], [400, 300], [200, 400], [300, 200]]);
        s.drawDone(s.drawerId);
      }
      for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
    }
    const fin = msgsOfType('final').at(-1)!;
    expect(fin.ranking.map((r) => r.playerId)).not.toContain('p5');
  });
});

describe('그림을 모은다', () => {
  it('라운드가 끝나면 그림 한 장이 기록으로 넘어온다', () => {
    const got: unknown[] = [];
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs,
      onDrawing: (rec) => got.push(rec),
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();

    expect(got.length).toBe(1);
    const rec = got[0] as { word: string; topic: string; strokes: unknown[]; guessers: number };
    expect(rec.word.length).toBeGreaterThan(0);
    expect(rec.topic.length).toBeGreaterThan(0);
    expect(rec.strokes.length).toBe(1);
    expect(rec.guessers).toBe(3);
  });

  it('빈 캔버스는 남기지 않는다', () => {
    const got: unknown[] = [];
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs,
      onDrawing: (rec) => got.push(rec),
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);
    s.start('p1');
    s.drawDone('p1');   // 아무것도 안 그리고 끝냈다
    expect(got.length).toBe(0);
  });
});

describe('강퇴 — 방장 전권', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;
  const ids = () => roomNow().players.map((p) => p.id);

  beforeEach(() => { newSession(['p1', 'p2', 'p3', 'p4', 'p5']); });

  it('방장이 내보내면 명단에서 아예 사라진다', () => {
    // 이탈과 다르다. 이탈은 자리를 남겨두고 기다리지만 강퇴는 돌아올 자리를 없앤다.
    expect(s.kick('p1', 'p2')).toBe(true);
    expect(ids()).not.toContain('p2');
  });

  it('방장이 아니면 못 내보낸다', () => {
    expect(s.kick('p2', 'p3')).toBe(false);
    expect(ids()).toContain('p3');
  });

  it('자기 자신은 못 내보낸다', () => {
    expect(s.kick('p1', 'p1')).toBe(false);
    expect(ids()).toContain('p1');
  });

  it('게임 중에 내보내면 그 사람 몫이 전부 지워진다', () => {
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    s.kick('p1', 'p2');
    expect(ids()).not.toContain('p2');
    expect(roomNow().players.find((p) => p.id === 'p2')).toBeUndefined();
  });

  it('그리던 사람을 내보내면 그 라운드는 접는다', () => {
    // 반쯤 그린 그림을 조각내봐야 아무도 못 맞히고, 출제자 없는 라운드를 돌릴 수도 없다.
    // 방장(p1)이 출제자가 아닌 라운드를 만들어야 하므로 2라운드까지 간다.
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
    s.next('p1');
    expect(s.phase).toBe('drawing');
    expect(s.drawerId).toBe('p2');

    s.addStroke('p2', [[300, 200], [400, 300]]);
    s.kick('p1', 'p2');
    expect(s.phase).toBe('roundEnd');
  });

  it('내보내면 남은 사람만으로 회차가 끝날 수 있는지 다시 본다', () => {
    s.start('p1');
    s.addStroke('p1', [[300, 200], [400, 300], [200, 400], [300, 200]]);
    s.drawDone('p1');
    expect(roomNow().attempt).toBe(1);
    s.answer('p2', '몰라');
    s.answer('p3', '몰라');
    // p4와 p5가 남아 있어 회차가 안 끝난다
    expect(roomNow().attempt).toBe(1);
    s.answer('p4', '몰라');
    s.kick('p1', 'p5');           // 마지막 한 명을 내보내면 기다릴 사람이 없다
    expect(roomNow().attempt).toBe(2);
  });
});

describe('입장 잠그기', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;

  it('방장만 잠그고 푼다', () => {
    newSession();
    s.setLock('p2', true);
    expect(roomNow().locked).toBe(false);
    s.setLock('p1', true);
    expect(roomNow().locked).toBe(true);
    s.setLock('p1', false);
    expect(roomNow().locked).toBe(false);
  });
});

describe('제시어 기억은 방 단위다', () => {
  const roomNow = () => msgsOfType('room').at(-1)!;
  const drawStar = (id: string) => s.addStroke(id, [[300, 200], [400, 300], [200, 400], [300, 200]]);
  const wordFor = (drawer: string) =>
    (msgsTo(drawer).filter((m) => m.t === 'word').at(-1) as Extract<ServerMsg, { t: 'word' }>).word;

  /** 한 판을 끝까지 돌리고 그동안 나온 제시어를 모은다. */
  function playGame(): string[] {
    const got: string[] = [];
    s.start('p1');
    while (s.phase !== 'final') {
      const drawer = s.drawerId;
      got.push(wordFor(drawer));
      drawStar(drawer);
      s.drawDone(drawer);
      for (let i = 0; i < TEST_RULES.maxAttempts; i++) clock.fire();
      s.next('p1');
    }
    return got;
  }

  beforeEach(() => { newSession(); });

  it('한 판 더를 해도 방금 나온 제시어가 다시 안 나온다', () => {
    // 예전에는 again()에서 기억을 비웠다. 테스터들이 이어서 여러 판을 돌리자
    // 방금 나온 단어가 다음 판에 바로 다시 나왔다.
    const first = playGame();
    s.again('p1');
    const second = playGame();
    for (const w of second) expect(first).not.toContain(w);
  });

  it('다 쓰면 기억을 비우고 처음부터 다시 돈다', () => {
    // 단어가 딱 네 개뿐인 주제를 주고 두 판을 돌린다.
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs,
      topics: [{ topic: '작은주제', words: ['가', '나', '다', '라'] }],
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);

    const first = playGame();
    expect(new Set(first).size).toBe(4);   // 네 개를 다 썼다
    expect(s.usedWordCount).toBe(4);

    s.again('p1');
    const second = playGame();
    expect(new Set(second).size).toBe(4);  // 멈추지 않고 다시 네 개
    // 비우고 다시 돌았으므로 여덟이 아니라 넷만 기억하고 있다
    expect(s.usedWordCount).toBe(4);
  });

  it('주제를 고정해 다 써도 다른 주제의 기억은 남는다', () => {
    // 고정 주제 50개를 다 썼다고 나머지 아홉 주제의 기억까지 날리면,
    // 랜덤으로 돌렸을 때 이미 나온 단어가 무더기로 되돌아온다.
    sent = [];
    clock = new ManualScheduler();
    s = new Session((to, msg) => sent.push({ to, msg }), {
      scheduler: clock, rules: { ...TEST_RULES }, pick: () => 0, shuffle: (xs) => xs,
      topics: [
        { topic: '작은주제', words: ['가', '나', '다', '라'] },
        { topic: '다른주제', words: ['마', '바', '사', '아'] },
      ],
    });
    for (const n of ['p1', 'p2', 'p3', 'p4']) s.join(n, n);

    s.setTopic('p1', '작은주제');
    playGame();                       // 작은주제 넷을 다 쓴다
    s.again('p1');
    playGame();                       // 비우고 다시 넷
    // 작은주제를 비웠어도 다른주제의 기억은 건드리지 않았어야 한다.
    // 지금 기억하고 있는 넷은 전부 작은주제의 것이다.
    expect(s.usedWordCount).toBe(4);
    s.again('p1');
    s.setTopic('p1', '다른주제');
    const third = playGame();
    expect(new Set(third).size).toBe(4);
    for (const w of third) expect(['마', '바', '사', '아']).toContain(w);
  });

  it('한 판을 돌면 그만큼 기억이 쌓인다', () => {
    expect(s.usedWordCount).toBe(0);
    const got = playGame();
    expect(s.usedWordCount).toBe(got.length);
  });
});
