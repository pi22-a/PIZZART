import { randomUUID } from 'node:crypto';
import type { Point } from '../shared/drawing';
import { insideCircle } from '../shared/drawing';
import { slice, sliceCount, type Slice } from '../shared/slicer';
import { rotate } from '../shared/geometry';
import { CENTER } from '../shared/drawing';
import type { ClientMsg, Phase, PlayerInfo, ServerMsg } from '../shared/protocol';
import { loadRules, loadTopics, pickWord, type Rules, type Topic } from './content';
import { realScheduler, type Scheduler } from './scheduler';
import { judge } from './judge';
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

  /** 마지막으로 보낸 결과·최종 메시지. 돌아온 사람에게 그대로 돌려준다. */
  private lastRoundEnd: ServerMsg | null = null;
  private lastFinal: ServerMsg | null = null;

  /** 방장이 고른 주제. null이면 라운드마다 무작위. */
  private selectedTopic: string | null = null;

  /** 이번 게임에 이미 나온 제시어. 같은 판에서 두 번 나오면 정답을 흘리는 셈이다. */
  private usedWords = new Set<string>();

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
      // 이름을 새로 보냈으면 갱신한다. 버리면 이름칸에 뭘 치든 계속 '손님'이고,
      // 이 게임의 하이라이트인 결과 화면이 '손님 — 코끼리' 다섯 줄이 된다.
      if (name) existing.name = name;
    } else {
      // 끊긴 사람은 정원에 세지 않는다. 유령까지 세면 세 명 있는 방이
      // 진짜 사람에게 "방이 가득 찼습니다"를 돌려준다.
      if (this.connectedCount >= this.rules.maxPlayers) {
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
      // 마지막 회차라면 조립판까지 돌려준다. 조각만 돌려주면 돌아온 사람만
      // 낱장을 들고 있고, 남들이 보는 조립판을 못 봐서 같은 화면이 아니게 된다.
      if (this.attempt >= this.rules.maxAttempts && !this.solved.has(id)) this.sendAssembled(id);
    }
    if (this.phase === 'guessing' && id === this.drawerId) {
      this.sendBoard();
    }
    if (this.phase === 'roundEnd' && this.lastRoundEnd) {
      this.send(id, this.lastRoundEnd);
    }
    if (this.phase === 'final' && this.lastFinal) {
      this.send(id, this.lastFinal);
    }
  }

  /**
   * 방장이 주제를 고정한다. 로비에서만, 방장만.
   * null이면 예전처럼 라운드마다 무작위로 뽑는다.
   */
  setTopic(playerId: string, topic: string | null): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    if (topic !== null && !this.topics.some((t) => t.topic === topic)) return;
    this.selectedTopic = topic;
    this.broadcastRoom();
  }

  start(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    // 살아있는 사람만 센다. 유령을 세면 "4인 게임"이 실제로는 두 명이 돌게 되고,
    // 순번에 유령이 끼면 beginRound가 건너뛰어 라운드 번호가 껑충 뛴다.
    const live = this.players.filter((p) => p.connected);
    if (live.length < this.rules.minPlayers) {
      this.send(playerId, { t: 'error', msg: `${this.rules.minPlayers}명 이상이어야 시작할 수 있습니다` });
      return;
    }
    this.order = live.map((p) => p.id);
    this.round = 0;
    this.usedWords.clear();
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

    const chosen = this.nextWord();
    this.topic = chosen.topic;
    this.word = chosen.word;
    this.strokes = [];
    this.slices = [];
    this.owner.clear();
    this.sliceId.clear();
    this.seen.clear();
    this.lastRoundEnd = null;
    // 시도 상태는 여기서도 반드시 지운다. endAttempt는 이어가는 길에서만 지우고
    // endRound로 빠지는 두 길에서는 안 지우기 때문에, 안 지우면 다음 라운드 내내
    // 지난 라운드의 ✎ 표시가 남고 room.attempt가 3으로 나간다.
    this.attempt = 1;
    this.answers.clear();
    this.wrongSubmits.clear();
    this.hintsTaken.clear();
    this.hintedThisAttempt.clear();
    this.solved.clear();
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
    if (this.phase !== 'drawing') return;
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
    if (guessers.length === 0) {
      // 맞힐 사람이 아무도 안 남았다. 조각을 나눠봐야 seen이 비어 skip()이 영영
      // 못 터지고, 출제자 혼자 4분 30초짜리 대기 화면을 본다.
      return this.endRound([]);
    }

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
    this.wrongSubmits.clear();
    this.hintsTaken.clear();
    this.hintedThisAttempt.clear();
    this.solved.clear();
    this.phase = 'guessing';

    this.setDeadline(this.rules.guessSeconds, () => this.endAttempt());
    this.broadcastRoom();
    for (const g of guessers) this.sendSlices(g.id);
    this.sendBoard();
  }

  protected attempt = 1;
  /** 틀린 제출 횟수. 맞힌 제출은 세지 않는다. */
  protected wrongSubmits = new Map<string, number>();
  /** 받은 힌트 횟수 */
  protected hintsTaken = new Map<string, number>();
  /** 이번 회차에 이미 힌트를 받았는가 — 회차당 한 번이다 */
  protected hintedThisAttempt = new Set<string>();
  /** 이미 맞혀서 점수가 확정된 사람 → 그 점수 */
  protected solved = new Map<string, number>();
  protected answers = new Map<string, string>();
  protected seen = new Map<string, Set<number>>();

  answer(playerId: string, text: string): void {
    if (this.phase !== 'guessing') return;
    if (!this.seen.has(playerId)) return; // 출제자와 관전자는 못 적는다
    if (this.solved.has(playerId)) return; // 이미 맞힌 사람은 더 낼 것이 없다
    this.answers.set(playerId, String(text).slice(0, 40));
    this.broadcastRoom();
    this.maybeEndAttempt();
  }

  /**
   * 힌트를 하나 받는다. 즉시 조각이 하나 늘고 점수가 깎인다.
   *
   * 예전에는 맞히는 사람 과반이 눌러야 전원에게 같은 조각이 공개됐다. 경쟁 게임으로
   * 방향을 잡으면서 개인 선택으로 바꿨다 — 남의 판단을 기다릴 이유가 없고,
   * "점수를 깎아서라도 조각을 더 볼 것인가"가 이 게임의 전략 그 자체가 된다.
   */
  hint(playerId: string): void {
    if (this.phase !== 'guessing') return;
    const mine = this.seen.get(playerId);
    if (!mine) return;                              // 출제자·관전자
    if (this.solved.has(playerId)) return;          // 이미 맞혔다
    if (this.hintedThisAttempt.has(playerId)) return; // 회차당 한 번
    if (mine.size >= this.rules.maxSlices) return;  // 상한
    if (this.attempt >= this.rules.maxAttempts) return; // 조립판에서는 못 받는다

    const all = this.slices.map((x) => x.index);
    const candidates = all.filter((i) => !mine.has(i));
    if (candidates.length === 0) return;

    mine.add(candidates[this.pick(candidates.length)]);
    this.hintedThisAttempt.add(playerId);
    this.hintsTaken.set(playerId, (this.hintsTaken.get(playerId) ?? 0) + 1);

    this.sendSlices(playerId);
    this.sendBoard();
    this.broadcastRoom();
  }

  /** 아직 못 맞힌 사람이 모두 답을 냈으면 30초를 기다릴 이유가 없다. */
  private maybeEndAttempt(): void {
    if (this.phase !== 'guessing') return;
    const pending = this.guessers().filter((g) => !this.solved.has(g.id));
    if (pending.length === 0) return this.endAttempt();
    if (pending.every((g) => this.answers.has(g.id))) this.endAttempt();
  }

  /** 지금 이 사람이 맞혔을 때 받게 될 점수. 화면에 미리 보여준다. */
  scoreFor(playerId: string): number {
    if (this.attempt >= this.rules.maxAttempts) return this.rules.finalAttemptScore;
    const wrong = this.wrongSubmits.get(playerId) ?? 0;
    const hints = this.hintsTaken.get(playerId) ?? 0;
    const raw = this.rules.startScore - wrong * this.rules.wrongSubmitCost - hints * this.rules.hintCost;
    return Math.max(0, raw);
  }

  /** 지금 회차의 답안 줄. 아직 못 맞힌 사람만 채점 대상이다. */
  private answerRows(): AnswerRow[] {
    return [...this.seen.keys()].map((id) => {
      if (this.solved.has(id)) return { playerId: id, text: '(맞힘)', correct: true };
      const text = this.answers.get(id) ?? '';
      return { playerId: id, text, correct: text.length > 0 && judge(text, this.word) };
    });
  }

  endAttempt(): void {
    if (this.phase !== 'guessing') return;
    this.clearTimer();

    // 이번 회차에 새로 맞힌 사람의 점수를 확정하고, 틀린 제출을 센다
    for (const id of this.seen.keys()) {
      if (this.solved.has(id)) continue;
      const text = this.answers.get(id) ?? '';
      if (text.length === 0) continue;
      if (judge(text, this.word)) this.solved.set(id, this.scoreFor(id));
      else this.wrongSubmits.set(id, (this.wrongSubmits.get(id) ?? 0) + 1);
    }

    const rows = this.answerRows();
    this.broadcast({ t: 'attemptResult', attempt: this.attempt, answers: rows });

    // 살아있는 사람 기준으로 본다. 전부 나가버렸으면 더 돌릴 이유가 없다.
    if (this.guessers().length === 0) return this.endRound([...this.solved.keys()], rows);
    const pending = [...this.seen.keys()].filter((id) => !this.solved.has(id));
    if (pending.length === 0) return this.endRound([...this.solved.keys()], rows);
    if (this.attempt >= this.rules.maxAttempts) return this.endRound([...this.solved.keys()], rows);

    this.attempt++;
    this.answers.clear();
    this.hintedThisAttempt.clear();

    this.setDeadline(this.rules.guessSeconds, () => this.endAttempt());
    this.broadcastRoom();
    const assembling = this.attempt >= this.rules.maxAttempts;
    for (const id of this.seen.keys()) {
      this.sendSlices(id);
      if (assembling && !this.solved.has(id)) this.sendAssembled(id);
    }
    this.sendBoard();
  }

  protected endRound(correct: string[], answers: AnswerRow[] = []): void {
    this.clearTimer();
    this.phase = 'roundEnd';

    // 점수는 맞힌 그 순간 이미 확정돼 solved에 들어 있다. 여기서 다시 계산하지 않는다 —
    // 지금 계산하면 그 뒤에 남이 쓴 힌트나 오답이 내 점수에 섞인다.
    // 출제자는 점수를 받지 않는다.
    const delta = new Map<string, number>(this.solved);
    for (const p of this.players) p.score += delta.get(p.id) ?? 0;

    // 결과 화면에도 마감 시각을 준다. 이 화면만 시간이 없으면 나가는 문이 next() 하나뿐인데,
    // 방장이 폰을 잠그거나 탭을 뒤로 넘긴 순간 나머지 전원이 비활성 버튼 앞에 영영 갇힌다.
    this.setDeadline(this.rules.roundEndSeconds, () => this.advance());

    // 화면 전환을 먼저 보낸다
    this.broadcastRoom();
    const msg: ServerMsg = {
      t: 'roundEnd',
      word: this.word,
      drawing: this.strokes,
      sliceCount: this.slices.length,
      owners: this.slices.map((s) => ({ sliceIndex: s.index, playerId: this.owner.get(s.index) ?? null })),
      scores: this.players.map((p) => ({ playerId: p.id, delta: delta.get(p.id) ?? 0, total: p.score })),
      correct,
      answers,
    };
    this.lastRoundEnd = msg;
    this.broadcast(msg);
  }

  next(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'roundEnd') return;
    this.advance();
  }

  /**
   * 다음 라운드로 넘긴다. next()와 결과 화면 타이머가 함께 쓴다.
   *
   * 방장 확인은 next() 쪽에만 있다 — 타이머가 터지는 상황이 바로
   * 방장이 없는 상황이라, 여기서 방장을 따지면 있으나 마나다.
   */
  private advance(): void {
    if (this.phase !== 'roundEnd') return;

    // 사람이 빠져 최소 인원을 밑돌면 로비로 돌아가 기다린다. 점수는 그대로 둔다.
    // 시작하려면 minPlayers명이 필요하지만, 진행 중에는 한 명 빠지는 것까지는 버틴다 —
    // 그 정도로 로비로 튕기면 흔한 이탈 한 번에도 판이 깨진다.
    if (this.connectedCount < this.rules.minPlayers - 1) {
      this.clearTimer();
      // 유령을 데리고 로비로 돌아가지 않는다. 저 소켓들은 이미 닫혔으니 다시는
      // 아무 일도 안 일어나고, 머릿수만 부풀려 시작·정원 판정을 전부 어긋나게 한다.
      this.prune();
      this.order = [];
      this.round = 0;
      this.phase = 'lobby';
      this.broadcastRoom();
      return;
    }

    this.round++;
    if (this.round >= this.order.length) return this.finishGame();
    this.beginRound();
  }

  /**
   * 최종 화면에서 한 판 더. 방장만이 아니라 누구나 누를 수 있다 —
   * 이 문이 한 사람 뒤에 잠기면, 그 사람이 자리를 뜬 순간 방 코드가 통째로 죽는다.
   */
  again(playerId: string): void {
    if (this.phase !== 'final') return;
    if (!this.players.some((p) => p.id === playerId)) return;

    this.clearTimer();
    this.prune();
    this.order = [];
    this.round = 0;
    this.attempt = 1;
    this.answers.clear();
    this.usedWords.clear();
    this.lastFinal = null;
    this.lastRoundEnd = null;
    for (const p of this.players) p.score = 0;
    this.phase = 'lobby';
    this.broadcastRoom();
  }

  protected finishGame(): void {
    this.clearTimer();
    this.phase = 'final';
    this.broadcastRoom();
    const msg: ServerMsg = {
      t: 'final',
      ranking: this.players
        .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
    };
    this.lastFinal = msg;
    this.broadcast(msg);
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
      // 방장이 게임 도중(로비가 아닐 때) 끊기면 hostId를 그대로 두지 않는다.
      // next()가 방장만 통과시키는 유일한 문이라, hostId가 끊긴 사람을 계속
      // 가리키면 결과 화면에서 아무도 다음으로 못 넘겨 방이 영구히 멈춘다.
      // 살아있는 사람이 없으면 hostId를 비워둔다 — 방이 비었으니 상관없다.
      // 원래 방장이 돌아와도 이 자리를 돌려주지 않는다: join()은 hostId가
      // 비어 있을 때만 새로 채우므로, 넘어간 방장을 몰래 바꿔치기하지 않는다.
      if (this.hostId === playerId) {
        this.hostId = this.players.find((p) => p.connected)?.id ?? '';
      }
    }
    this.broadcastRoom();
    // 누가 사라진 이 순간, 남은 사람이 전부 답을 내둔 상태일 수 있다.
    // 방금 나간 사람을 기다리며 타이머를 다 태우면 안 된다.
    this.maybeEndAttempt();
  }

  handle(playerId: string, msg: ClientMsg): void {
    switch (msg.t) {
      case 'again': return this.again(playerId);
      case 'join': return this.join(playerId, msg.name);
      case 'start': return this.start(playerId);
      case 'setTopic': return this.setTopic(playerId, msg.topic);
      case 'stroke': return this.addStroke(playerId, msg.points);
      case 'undo': return this.undo(playerId);
      case 'drawDone': return this.drawDone(playerId);
      case 'answer': return this.answer(playerId, msg.text);
      case 'skip': return this.hint(playerId);
      case 'next': return this.next(playerId);
      default: return;
    }
  }

  // ---------- 보조 ----------

  /** 지금 이 방에 실제로 붙어 있는 사람 수. 정원·시작 인원 판정은 전부 이걸 쓴다. */
  get connectedCount(): number {
    return this.players.filter((p) => p.connected).length;
  }

  /** 끊긴 사람을 명단에서 지운다. 로비로 돌아갈 때와 한 판 더에서만 부른다. */
  private prune(): void {
    this.players = this.players.filter((p) => p.connected);
    if (!this.players.some((p) => p.id === this.hostId)) {
      this.hostId = this.players[0]?.id ?? '';
    }
  }

  /**
   * 이번 게임에 아직 안 나온 제시어를 고른다.
   *
   * 9라운드를 90단어짜리 풀에서 돌리면 중복이 꽤 자주 난다. 중복은 앞 라운드
   * 결과 화면을 본 전원에게 정답을 그냥 알려주는 것과 같다.
   * 풀이 바닥나면 중복을 허용한다 — 멈추는 것보다 낫다.
   */
  private nextWord(): { topic: string; word: string } {
    // 방장이 주제를 골랐으면 그 안에서만 뽑는다. 안 골랐으면 전부가 후보다.
    const pool = this.selectedTopic
      ? this.topics.filter((t) => t.topic === this.selectedTopic)
      : this.topics;
    const fresh = pool
      .map((t) => ({ topic: t.topic, words: t.words.filter((w) => !this.usedWords.has(w)) }))
      .filter((t) => t.words.length > 0);
    // 고른 주제의 단어가 바닥나도 주제를 바꾸지 않는다 — 중복을 허용하는 편이 덜 놀랍다.
    const chosen = pickWord(fresh.length > 0 ? fresh : pool, this.pick);
    this.usedWords.add(chosen.word);
    return chosen;
  }

  protected livePlayer(id: string): boolean {
    return this.players.some((p) => p.id === id && p.connected);
  }

  protected guessers(): Player[] {
    return this.players.filter((p) => p.id !== this.drawerId && p.connected);
  }

  protected setDeadline(seconds: number, fn: () => void): void {
    this.clearTimer();
    // 0 이하는 "자동으로 넘어가지 않는다"는 뜻이다. 결과 화면이 그렇다 —
    // 방장이 직접 눌러야 다음 라운드로 간다.
    if (seconds <= 0) return;
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
      shared: false,
    }));
    this.send(playerId, { t: 'slices', count: this.slices.length, slices: list });
  }

  /**
   * 출제자에게 지금 밖에 나가 있는 조각이 무엇인지 보여준다.
   * 정답과 그림을 이미 아는 사람이라 원본을 실어도 새지 않는다.
   */
  /**
   * 마지막 회차에 내가 본 조각들을 회전을 풀어 제자리로 되돌려 보낸다.
   * 서버가 들고 있는 조각은 전부 위를 향하게 돌아가 있으므로, 돌린 만큼 되돌린다.
   */
  protected sendAssembled(playerId: string): void {
    const mine = this.seen.get(playerId);
    if (!mine) return;
    const count = this.slices.length;
    const step = (Math.PI * 2) / count;
    const pieces = [...mine].sort((a, b) => a - b).map((index) => {
      const spin = -Math.PI / 2 - (index + 0.5) * step;
      return { index, strokes: this.slices[index].strokes.map((st) => rotate(st, CENTER, -spin)) };
    });
    this.send(playerId, { t: 'assembled', sliceCount: count, pieces });
  }

  protected sendBoard(): void {
    if (this.phase !== 'guessing') return;
    const out = new Set<number>();
    for (const seen of this.seen.values()) for (const i of seen) out.add(i);
    const msg: ServerMsg = {
      t: 'board',
      sliceCount: this.slices.length,
      drawing: this.strokes,
      visible: [...out].sort((a, b) => a - b),
    };
    // 출제자와, 먼저 맞혀 할 일이 없어진 사람에게. 둘 다 이미 답을 안다.
    this.send(this.drawerId, msg);
    for (const id of this.solved.keys()) this.send(id, msg);
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
      skipped: this.hintedThisAttempt.has(p.id),
      solved: this.solved.has(p.id),
      sliceCount: this.seen.get(p.id)?.size ?? 0,
      pendingScore: this.solved.get(p.id) ?? this.scoreFor(p.id),
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
      minPlayers: this.rules.minPlayers,
      topics: this.topics.map((t) => t.topic),
      selectedTopic: this.selectedTopic,
    });
  }
}
