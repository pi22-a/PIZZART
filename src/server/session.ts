import { randomUUID } from 'node:crypto';
import type { Point } from '../shared/drawing';
import { insideCircle } from '../shared/drawing';
import { slice, sliceCount, type Slice } from '../shared/slicer';
import type { ClientMsg, Phase, PlayerInfo, ServerMsg } from '../shared/protocol';
import { loadRules, loadTopics, pickWord, type Rules, type Topic } from './content';
import { realScheduler, type Scheduler } from './scheduler';
import { judge } from './judge';
import { planHint } from './hint';
import { guesserPoints, drawerPoints } from './scorer';
import type { AnswerRow } from '../shared/protocol';

interface Player {
  id: string;
  name: string;
  connected: boolean;
  score: number;
}

export interface SessionOpts {
  scheduler?: Scheduler;
  /** 0 <= 결과 < n 인 정수. 테스트에서 고정한다. */
  pick?: (n: number) => number;
  shuffle?: <T>(xs: T[]) => T[];
  rules?: Rules;
  topics?: Topic[];
}

const defaultPick = (n: number) => Math.floor(Math.random() * n);
function defaultShuffle<T>(xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Session {
  phase: Phase = 'lobby';

  private players: Player[] = [];
  private hostId = '';

  /** 출제 순번. 게임 시작 시점에 고정된다 — 도중에 다시 계산하면 언제 끝날지 알 수 없어진다. */
  private order: string[] = [];
  private round = 0;

  private topic = '';
  private word = '';
  private strokes: Point[][] = [];

  private slices: Slice[] = [];
  /** 섹터 번호 → 처음 받은 사람 */
  private owner = new Map<number, string>();
  /** 조각 불투명 id → 섹터 번호. 클라이언트는 섹터 번호를 절대 모른다. */
  private sliceId = new Map<number, string>();

  private cancelTimer: (() => void) | null = null;
  private deadline: number | null = null;

  private readonly scheduler: Scheduler;
  private readonly pick: (n: number) => number;
  private readonly shuffle: <T>(xs: T[]) => T[];
  readonly rules: Rules;
  private readonly topics: Topic[];

  constructor(
    private send: (playerId: string, msg: ServerMsg) => void,
    opts: SessionOpts = {},
  ) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.pick = opts.pick ?? defaultPick;
    this.shuffle = opts.shuffle ?? defaultShuffle;
    this.rules = opts.rules ?? loadRules();
    this.topics = opts.topics ?? loadTopics();
  }

  /** 테스트에서 들여다보기 위한 것 */
  get strokeCount(): number {
    return this.strokes.length;
  }

  get drawerId(): string {
    return this.order[this.round] ?? '';
  }

  // ---------- 로비 ----------

  join(id: string, name: string): void {
    const existing = this.players.find((p) => p.id === id);
    if (existing) {
      existing.connected = true;
    } else {
      if (this.players.length >= this.rules.maxPlayers) {
        this.send(id, { t: 'error', msg: '방이 가득 찼습니다' });
        return;
      }
      this.players.push({ id, name, connected: true, score: 0 });
    }
    if (!this.hostId) this.hostId = id;

    this.send(id, { t: 'joined', youId: id });
    this.broadcastRoom();
    this.restore(id);
  }

  /** 돌아온 사람에게 그 라운드에 이미 준 것을 그대로 돌려준다. 다시 계산하면 남들과 어긋난다. */
  private restore(id: string): void {
    if (this.phase === 'drawing' && id === this.drawerId) {
      this.send(id, { t: 'word', word: this.word });
      this.send(id, { t: 'canvas', strokes: this.strokes });
    }
    if (this.phase === 'guessing' && this.seen.has(id)) {
      this.sendSlices(id);
    }
  }

  start(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    if (this.players.length < this.rules.minPlayers) {
      this.send(playerId, { t: 'error', msg: `${this.rules.minPlayers}명 이상이어야 시작할 수 있습니다` });
      return;
    }
    this.order = this.players.map((p) => p.id);
    this.round = 0;
    for (const p of this.players) p.score = 0;
    this.beginRound();
  }

  // ---------- 라운드 ----------

  private beginRound(): void {
    // 출제 차례인 사람이 사라졌으면 건너뛴다
    while (this.round < this.order.length && !this.livePlayer(this.order[this.round])) {
      this.round++;
    }
    if (this.round >= this.order.length) return this.finishGame();

    const chosen = pickWord(this.topics, this.pick);
    this.topic = chosen.topic;
    this.word = chosen.word;
    this.strokes = [];
    this.slices = [];
    this.owner.clear();
    this.sliceId.clear();
    this.seen.clear();
    this.phase = 'drawing';

    // 화면 전환을 먼저 보낸다. 반대로 하면 아직 숨겨진 캔버스에 그려 폭 0으로 뭉갠다.
    this.setDeadline(this.rules.drawSeconds, () => this.endDrawing());
    this.broadcastRoom();
    this.send(this.drawerId, { t: 'word', word: this.word });
  }

  addStroke(playerId: string, points: Point[]): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    const clean = points.filter(insideCircle);
    if (clean.length < 2) return;
    this.strokes.push(clean);
  }

  undo(playerId: string): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    this.strokes.pop();
    this.send(playerId, { t: 'canvas', strokes: this.strokes });
  }

  drawDone(playerId: string): void {
    if (playerId !== this.drawerId) return;
    this.endDrawing();
  }

  endDrawing(): void {
    if (this.phase !== 'drawing') return;
    this.clearTimer();

    if (this.strokes.length === 0) {
      // 아무것도 없으면 나눌 것도 없다. 라운드를 접고 다음으로 간다.
      return this.endRound([]);
    }

    const guessers = this.guessers();
    const count = sliceCount(guessers.length, this.rules.sliceCountMin);
    this.slices = slice(this.strokes, count);
    for (const s of this.slices) this.sliceId.set(s.index, randomUUID());

    const order = this.shuffle(this.slices.map((s) => s.index));
    guessers.forEach((g, i) => {
      this.owner.set(order[i], g.id);
      this.seen.set(g.id, new Set([order[i]]));
    });

    this.attempt = 1;
    this.answers.clear();
    this.skips.clear();
    this.publicSlices = [];
    this.phase = 'guessing';

    this.setDeadline(this.rules.guessSeconds, () => this.endAttempt());
    this.broadcastRoom();
    for (const g of guessers) this.sendSlices(g.id);
  }

  protected attempt = 1;
  protected answers = new Map<string, string>();
  protected skips = new Set<string>();
  protected publicSlices: number[] = [];
  protected seen = new Map<string, Set<number>>();

  answer(playerId: string, text: string): void {
    if (this.phase !== 'guessing') return;
    if (!this.seen.has(playerId)) return; // 출제자와 관전자는 못 적는다
    this.answers.set(playerId, String(text).slice(0, 40));
    this.broadcastRoom();
  }

  skip(playerId: string): void {
    if (this.phase !== 'guessing') return;
    if (!this.seen.has(playerId)) return; // 답을 아는 출제자는 속도를 정할 수 없다
    this.skips.add(playerId);
    this.broadcastRoom();

    const live = this.guessers();
    if (live.length > 0 && live.every((g) => this.skips.has(g.id))) this.endAttempt();
  }

  endAttempt(): void {
    if (this.phase !== 'guessing') return;
    this.clearTimer();

    const rows: AnswerRow[] = [...this.seen.keys()].map((id) => {
      const text = this.answers.get(id) ?? '';
      return { playerId: id, text, correct: judge(text, this.word) };
    });
    this.broadcast({ t: 'attemptResult', attempt: this.attempt, answers: rows });

    const correct = rows.filter((r) => r.correct).map((r) => r.playerId);
    if (correct.length > 0) return this.endRound(correct);
    if (this.attempt >= this.rules.maxAttempts) return this.endRound([]);

    this.applyHint();
    this.attempt++;
    this.answers.clear();
    this.skips.clear();

    this.setDeadline(this.rules.guessSeconds, () => this.endAttempt());
    this.broadcastRoom();
    for (const id of this.seen.keys()) this.sendSlices(id);
  }

  /** 시도에 실패할 때마다 조각을 하나 더 푼다. 자세한 규칙은 hint.ts에 있다. */
  private applyHint(): void {
    const all = this.slices.map((s) => s.index);
    const taken = new Set<number>();
    for (const seen of this.seen.values()) for (const i of seen) taken.add(i);
    const hidden = all.filter((i) => !taken.has(i));

    const plan = planHint(hidden, this.seen, all, this.pick);

    if (plan.publicSlice !== null) {
      this.publicSlices.push(plan.publicSlice);
      for (const seen of this.seen.values()) seen.add(plan.publicSlice);
      return;
    }
    for (const { playerId, sliceIndex } of plan.perPlayer) {
      this.seen.get(playerId)?.add(sliceIndex);
    }
  }

  protected endRound(correct: string[]): void {
    this.clearTimer();
    this.phase = 'roundEnd';

    const delta = new Map<string, number>();
    for (const id of correct) delta.set(id, guesserPoints(this.attempt, this.rules.attemptPoints));
    if (this.drawerId) {
      delta.set(this.drawerId, drawerPoints(correct.length, this.rules.drawerPointPerCorrect));
    }
    for (const p of this.players) p.score += delta.get(p.id) ?? 0;

    // 화면 전환을 먼저 보낸다
    this.broadcastRoom();
    this.broadcast({
      t: 'roundEnd',
      word: this.word,
      drawing: this.strokes,
      sliceCount: this.slices.length,
      owners: this.slices.map((s) => ({ sliceIndex: s.index, playerId: this.owner.get(s.index) ?? null })),
      scores: this.players.map((p) => ({ playerId: p.id, delta: delta.get(p.id) ?? 0, total: p.score })),
      correct,
    });
  }

  next(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'roundEnd') return;
    this.round++;
    if (this.round >= this.order.length) return this.finishGame();
    this.beginRound();
  }

  protected finishGame(): void {
    this.clearTimer();
    this.phase = 'final';
    this.broadcastRoom();
    this.broadcast({
      t: 'final',
      ranking: this.players
        .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
    });
  }

  // ---------- 이탈 ----------

  disconnect(playerId: string): void {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;

    if (this.phase === 'lobby') {
      // 로비에서는 자리를 그냥 비운다. 표시만 해두면 링크를 열었다 닫을 때마다
      // 유령이 쌓여 방이 영구히 죽는다.
      this.players.splice(idx, 1);
      if (this.hostId === playerId) this.hostId = this.players[0]?.id ?? '';
    } else {
      this.players[idx].connected = false;
    }
    this.broadcastRoom();
  }

  handle(playerId: string, msg: ClientMsg): void {
    switch (msg.t) {
      case 'join': return this.join(playerId, msg.name);
      case 'start': return this.start(playerId);
      case 'stroke': return this.addStroke(playerId, msg.points);
      case 'undo': return this.undo(playerId);
      case 'drawDone': return this.drawDone(playerId);
      case 'answer': return this.answer(playerId, msg.text);
      case 'skip': return this.skip(playerId);
      case 'next': return this.next(playerId);
      default: return;
    }
  }

  // ---------- 보조 ----------

  protected livePlayer(id: string): boolean {
    return this.players.some((p) => p.id === id && p.connected);
  }

  protected guessers(): Player[] {
    return this.players.filter((p) => p.id !== this.drawerId && p.connected);
  }

  protected setDeadline(seconds: number, fn: () => void): void {
    this.clearTimer();
    this.deadline = Date.now() + seconds * 1000;
    this.cancelTimer = this.scheduler.after(seconds * 1000, fn);
  }

  protected clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.deadline = null;
  }

  /** 그 사람이 볼 수 있는 조각 전부를 보낸다. 섹터 번호는 절대 실리지 않는다. */
  protected sendSlices(playerId: string): void {
    const mine = this.seen.get(playerId);
    if (!mine) return;
    const list = [...mine].map((index) => ({
      id: this.sliceId.get(index)!,
      strokes: this.slices[index].strokes,
      shared: this.publicSlices.includes(index),
    }));
    this.send(playerId, { t: 'slices', count: this.slices.length, slices: list });
  }

  protected broadcast(msg: ServerMsg): void {
    for (const p of this.players) this.send(p.id, msg);
  }

  protected broadcastRoom(): void {
    const players: PlayerInfo[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      isDrawer: p.id === this.drawerId && this.phase !== 'lobby',
      answered: this.answers.has(p.id),
      skipped: this.skips.has(p.id),
    }));
    this.broadcast({
      t: 'room',
      phase: this.phase,
      players,
      hostId: this.hostId,
      round: this.round,
      totalRounds: this.order.length,
      topic: this.phase === 'lobby' ? '' : this.topic,
      attempt: this.attempt,
      maxAttempts: this.rules.maxAttempts,
      deadline: this.deadline,
    });
  }
}
