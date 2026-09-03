import { randomUUID } from 'node:crypto';
import type { Point, Stroke } from '../shared/drawing';
import { insideCircle } from '../shared/drawing';
import { eraseStrokes, ERASE_RADIUS, DOODLE_ERASE_RADIUS, MAX_ERASE_STEP } from '../shared/eraser';
import { slice, sliceCount, type Slice } from '../shared/slicer';
import { rotate } from '../shared/geometry';
import { CENTER } from '../shared/drawing';
import type { ChatLine, ClientMsg, Phase, PlayerInfo, RoundRecap, ServerMsg } from '../shared/protocol';
import { DEFAULT_COLOR, PALETTE, safeColor } from '../shared/palette';
import { loadRules, loadTopics, pickWord, type Rules, type Topic } from './content';
import { realScheduler, type Scheduler } from './scheduler';
import { judge } from './judge';
import { maskProfanity } from './profanity';
import type { AnswerRow } from '../shared/protocol';

interface Player {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  /**
   * 관전자. 조각을 받지 않고 출제 차례도 안 오며, 대신 출제자와 같은 것을 본다.
   *
   * 로비에서만 바꿀 수 있다. 그 제약 하나가 규칙 전부를 떠받친다 —
   * 시작 전에 정하게 되고, 도중에 들어온 사람은 판이 끝나기 전에는 못 바꾼다.
   */
  spectator: boolean;
  /**
   * 게임이 도는 중에 들어온 사람인가. 이 사람만 도중에 이름을 바꿀 수 있다.
   *
   * 새로 온 사람이 '손님'으로 남으면 결과 화면에서 누가 누군지 알 수 없고,
   * 원래 있던 사람이 도중에 이름을 바꾸면 그때까지의 기록이 헷갈린다.
   */
  lateJoin: boolean;
}

/** 한 라운드가 끝날 때 남기는 기록. 나중에 '지난 그림 보기' 모드의 재료가 된다. */
/**
 * 좌표 한 점이 제 모양인가.
 *
 * 바깥에서 온 값은 배열이기만 하고 안은 아무것이나 들어 있을 수 있다. [null] 같은 것을
 * 그대로 계산에 넣으면 null[0]을 읽다가 프로세스가 내려간다 — 이 게임에서는 그때
 * 돌던 판이 전부 날아간다.
 */
function wellFormed(p: unknown): p is Point {
  return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

export interface DrawingRecord {
  at: string;
  topic: string;
  word: string;
  sliceCount: number;
  strokes: Stroke[];
  /** 맞힌 사람 수 / 맞히려 한 사람 수. 그 그림이 얼마나 어려웠는지가 여기 남는다. */
  solved: number;
  guessers: number;
}

export interface SessionOpts {
  scheduler?: Scheduler;
  /**
   * 라운드가 끝날 때 그림을 넘긴다. 세션은 어디에 어떻게 쌓이는지 모른다 —
   * 파일을 여기서 열면 테스트가 돌 때마다 디스크에 쓴다.
   */
  onDrawing?: (rec: DrawingRecord) => void;
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
  private strokes: Stroke[] = [];

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
  private selectedTopics: string[] = [];

  /** 방 이름과 코드. 로비 목록과 방 안의 링크 만들기에 쓴다. */
  name = '';
  code = '';

  /**
   * 새 사람의 입장이 막혀 있는가.
   *
   * 이미 자리가 있는 사람의 재접속은 막지 않는다 — 잠금은 모르는 사람을 막자는 것이지
   * 끊긴 친구를 내쫓자는 것이 아니다. 그 판단은 자리 지도를 들고 있는 index.ts가 한다.
   */
  locked = false;

  /**
   * 방장이 줄인 정원. null이면 규칙의 상한(maxPlayers)을 그대로 쓴다.
   *
   * 값 대신 null을 두는 것은 필드 초기화 시점에 rules가 아직 없기 때문이기도 하고,
   * "손대지 않았다"와 "우연히 상한과 같은 값을 골랐다"를 구별하기 위해서다.
   */
  private capacityOverride: number | null = null;

  /** 지금 이 방의 정원. 방 목록과 입장 판정이 함께 본다. */
  get capacity(): number {
    return this.capacityOverride ?? this.rules.maxPlayers;
  }

  /** 만들어진 시각. 만든 사람이 도착하기 전에 빈 방으로 지워지는 것을 막는다. */
  readonly bornAt = Date.now();

  /**
   * 이 판에 그려진 그림들. 최종 화면에서 모아 보여준다.
   *
   * 판마다 비운다 — usedWords와 달리 이건 "이번 판에 우리가 그린 것"이라서,
   * 지난 판 그림이 섞이면 뜻이 흐려진다.
   */
  private recaps: RoundRecap[] = [];

  /**
   * 흑백판인가 컬러판인가. 방마다 정하고, 방을 만들면 흑백으로 시작한다.
   *
   * 흑백이 기본인 것은 지금까지 쌓인 점수 설계가 흑백 기준으로 맞춰진 값이기 때문이다.
   * 컬러는 골라서 켜는 쪽이 맞다.
   */
  protected colorMode: 'mono' | 'color' = 'mono';

  /**
   * 로비에서 준비를 누른 사람들.
   *
   * 방장은 여기 안 넣는다 — 방장에게는 준비 버튼 대신 시작 버튼이 있고, 시작을 누르는
   * 것이 곧 준비의 표시다. 세는 자리(readyCount)에서 방장을 늘 더한다.
   */
  protected readySet = new Set<string>();

  /**
   * 이 방에서 이미 나온 제시어.
   *
   * 판이 아니라 **방** 단위다. 예전에는 '한 판 더'를 누를 때마다 비웠는데, 테스터들이
   * 이어서 여러 판을 돌리자 방금 나온 단어가 다음 판에 바로 다시 나왔다.
   * 판 안에서 안 겹치는 것만으로는 부족했다.
   *
   * 고를 수 있는 단어를 다 쓰면 그때 비우고 처음부터 다시 돈다(nextWord 참조).
   */
  private usedWords = new Set<string>();


  /** 이번 라운드에 출제자가 제시어를 더 바꿀 수 있는 횟수. 라운드마다 다시 찬다. */
  private rerollsLeft = 0;

  /**
   * 결과·최종 화면에서 오간 이야기. 한 판 내내 이어지고 새 판에서 비워진다.
   *
   * 라운드마다 비우지 않는 이유: 비우면 결과 화면을 넘기는 순간 방금 나눈 말이 사라지고,
   * 최종 화면의 이야기칸이 매번 빈 채로 시작해서 아무도 첫 줄을 안 쓴다.
   * 이어두면 최종 화면이 그 판 전체의 반응 기록이 된다.
   */
  protected chatLog: ChatLine[] = [];

  /** 이야기 줄 상한. 넘치면 오래된 것부터 버린다 — 낙서판과 같은 이유다. */
  private static readonly CHAT_MAX = 200;
  /** 한 줄 길이 상한. 답이 40자니 그보다 넉넉하되 화면을 밀어낼 만큼은 아니게. */
  private static readonly CHAT_LEN = 100;

  private readonly scheduler: Scheduler;
  private readonly pick: (n: number) => number;
  private readonly shuffle: <T>(xs: T[]) => T[];
  readonly rules: Rules;
  private readonly topics: Topic[];
  private readonly onDrawing?: (rec: DrawingRecord) => void;

  constructor(
    private send: (playerId: string, msg: ServerMsg) => void,
    opts: SessionOpts = {},
  ) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.pick = opts.pick ?? defaultPick;
    this.shuffle = opts.shuffle ?? defaultShuffle;
    this.rules = opts.rules ?? loadRules();
    this.topics = opts.topics ?? loadTopics();
    this.onDrawing = opts.onDrawing;
  }

  /** 테스트에서 들여다보기 위한 것 */
  get usedWordCount(): number {
    return this.usedWords.size;
  }

  /** 테스트에서 들여다보기 위한 것 */
  get strokeCount(): number {
    return this.strokes.length;
  }

  /** 로비 목록에 쓰는 값들. */
  get totalRounds(): number { return this.order.length; }
  get roundNow(): number { return this.round; }
  get hostName(): string {
    return this.players.find((p) => p.id === this.hostId)?.name ?? '';
  }

  get drawerId(): string {
    return this.order[this.round] ?? '';
  }

  // ---------- 로비 ----------

  join(id: string, name: string): void {
    // 이름 없는 방에 첫 사람이 들어오면 그 사람 이름으로 한 번 정한다.
    //
    // 이름은 로비에서 방을 만들 때만 붙는다. 직링크로 들어가거나 서버가 다시 뜬 뒤
    // 재접속하면 방은 새로 생기고 이름은 빈 채로 남는다. 그러면 목록이 '지금 방장의
    // 이름'으로 이름을 지어내는데, 방장이 바뀔 때마다 방 이름이 따라 바뀐다.
    // 실제로 '초코비의 방'이 사람이 나가자 '피자의 방'이 됐다.
    if (!this.name && this.players.length === 0) this.name = `${name || '누군가'}의 방`;

    const existing = this.players.find((p) => p.id === id);
    if (existing) {
      existing.connected = true;
      // 이름을 새로 보냈으면 갱신한다. 버리면 이름칸에 뭘 치든 계속 '손님'이고,
      // 이 게임의 하이라이트인 결과 화면이 '손님 — 코끼리' 다섯 줄이 된다.
      //
      // 단 게임이 도는 중에는 도중에 들어온 사람만 바꿀 수 있다. 원래 있던 사람이
      // 중간에 이름을 갈면 그때까지 쌓인 답 기록과 이야기가 누구 것인지 어긋난다.
      if (name && (this.phase === 'lobby' || existing.lateJoin)) existing.name = name;
    } else {
      // 끊긴 사람은 정원에 세지 않는다. 유령까지 세면 세 명 있는 방이
      // 진짜 사람에게 "방이 가득 찼습니다"를 돌려준다.
      if (this.connectedCount >= this.capacity) {
        this.send(id, { t: 'error', msg: '방이 가득 찼습니다' });
        return;
      }
      // 게임이 도는 중에 들어왔으면 관전자로 앉힌다. 조각은 그림이 완성되던 순간에
      // 이미 나뉘었으므로 이번 라운드에 낄 자리가 없고, 다음 라운드에 슬쩍 끼워주면
      // 남들이 한 판을 다 도는 동안 이 사람만 출제 없이 맞히기만 하게 된다.
      // 로비로 돌아올 때까지 관전이고, 그때 본인이 끈다.
      const late = this.phase !== 'lobby';
      this.players.push({ id, name, connected: true, score: 0, spectator: late, lateJoin: late });
    }
    if (!this.hostId) this.hostId = id;

    this.send(id, { t: 'joined', youId: id });
    this.broadcastRoom();
    this.restore(id);
  }

  /** 돌아온 사람에게 그 라운드에 이미 준 것을 그대로 돌려준다. 다시 계산하면 남들과 어긋난다. */
  private restore(id: string): void {
    // 출제자와 관전자는 같은 것을 본다. 돌아왔을 때도 같은 것을 되찾아야 한다.
    if (this.phase === 'drawing' && this.knowsAnswer(id)) {
      this.send(id, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
      this.send(id, { t: 'canvas', strokes: this.strokes });
    }
    if (this.phase === 'drawing' && id !== this.drawerId) {
      this.send(id, { t: 'doodleBoard', strokes: this.doodle });
    }
    if (this.phase === 'guessing' && this.seen.has(id)) {
      this.sendSlices(id);
      // 마지막 회차라면 조립판까지 돌려준다. 조각만 돌려주면 돌아온 사람만
      // 낱장을 들고 있고, 남들이 보는 조립판을 못 봐서 같은 화면이 아니게 된다.
      if (this.attempt >= this.rules.maxAttempts && !this.solved.has(id)) this.sendAssembled(id);
    }
    if (this.phase === 'guessing' && this.knowsAnswer(id)) {
      // 제시어를 같이 보낸다. 추론 중에 들어온 관전자는 word를 받은 적이 없어서,
      // 현황판만 주면 남들이 뭘 맞히려는지 모르는 채로 구경하게 된다.
      this.send(id, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
      this.sendBoard();
    }
    if (this.phase === 'roundEnd' && this.lastRoundEnd) {
      this.send(id, this.lastRoundEnd);
    }
    if (this.phase === 'final' && this.lastFinal) {
      this.send(id, this.lastFinal);
    }
    // 이야기는 화면에 상관없이 돌려준다. 결과 화면에서 새로고침한 사람만
    // 남들이 나눈 말을 못 보는 일이 없어야 한다.
    if (this.chatLog.length > 0) {
      this.send(id, { t: 'chatLog', lines: this.chatLog });
    }
  }

  /**
   * 방장이 어느 주제에서 뽑을지 고른다. 로비에서만, 방장만.
   *
   * 비어 있으면 전체다. 하나만 고를 수 있던 때는 null이 전체를 뜻했는데, 여러 개를
   * 고르게 되면서 "아무것도 안 고름"과 "전체"가 같은 뜻이 됐다. 빈 배열이 그 둘이다.
   */
  setTopics(playerId: string, topics: string[]): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    if (!Array.isArray(topics)) return;
    // 목록에 없는 이름은 버린다. 남는 것이 없으면 전체가 된다.
    const known = new Set(this.topics.map((t) => t.topic));
    this.selectedTopics = [...new Set(topics)].filter((t) => known.has(t));
    this.broadcastRoom();
  }

  /**
   * 흑백판/컬러판을 고른다. 로비에서, 방장만.
   *
   * 컬러로 그리면 조각 하나만 봐도 "빨갛고 둥근 것"으로 좁혀져 너무 쉬워진다는 의견이
   * 있었다. 어느 한쪽이 옳다고 정하는 대신 방마다 고르게 했다.
   *
   * 판이 도는 중에는 못 바꾼다. 중간에 바뀌면 앞 라운드는 컬러로, 뒤 라운드는 흑백으로
   * 그려져 점수를 견줄 수 없게 된다.
   */
  setColorMode(playerId: string, mode: 'mono' | 'color'): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    if (mode !== 'mono' && mode !== 'color') return;
    if (this.colorMode === mode) return;
    this.colorMode = mode;
    this.broadcastRoom();
  }

  /**
   * 방장이 정원을 줄이거나 늘린다. 로비에서, 방장만.
   *
   * 지금 있는 사람 수 아래로는 못 내린다. 내릴 수 있게 하면 "정원 4명"이라고 적힌
   * 방에 여섯 명이 앉아 있게 되고, 그렇다고 남는 사람을 자동으로 내보내면 방장이
   * 누른 적 없는 강퇴가 일어난다 — 내보내는 것은 강퇴 버튼이 할 일이다.
   *
   * 위로는 규칙의 상한(maxPlayers)까지다. 상한은 조각 나누기와 라운드 수가 감당하는
   * 범위라 방장이 넘길 수 있는 값이 아니다.
   */
  setCapacity(playerId: string, max: number): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    if (!Number.isInteger(max)) return;

    const floor = Math.max(this.rules.minPlayers, this.connectedCount);
    const next = Math.min(this.rules.maxPlayers, Math.max(floor, max));
    if (next === this.capacity) return;
    this.capacityOverride = next;
    this.broadcastRoom();
  }

  /** 방장이 새 사람의 입장을 막거나 푼다. */
  setLock(playerId: string, on: boolean): void {
    if (playerId !== this.hostId) return;
    if (this.locked === on) return;
    this.locked = on;
    this.broadcastRoom();
  }

  /**
   * 방장이 내보낸다. 방장 전권이고, 자기 자신은 못 내보낸다.
   *
   * 이탈(disconnect)과 다르다. 이탈은 자리를 남겨두고 돌아오기를 기다리지만,
   * 강퇴는 명단에서 아예 지운다 — 돌아올 자리를 남겨두면 강퇴가 아니다.
   *
   * 그 사람이 다시 못 들어오게 막는 것은 여기서 못 한다. 자리와 브라우저를 잇는
   * 지도는 index.ts가 들고 있다. 여기서는 "내보냈다"만 알리고 나머지를 맡긴다.
   */
  kick(playerId: string, targetId: string): boolean {
    if (playerId !== this.hostId) return false;
    if (playerId === targetId) return false;
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx === -1) return false;

    const wasDrawer = targetId === this.drawerId;
    this.players.splice(idx, 1);
    this.order = this.order.filter((id) => id !== targetId);
    this.seen.delete(targetId);
    this.answers.delete(targetId);
    this.solved.delete(targetId);
    this.skippedThisAttempt.delete(targetId);
    this.answerLog.delete(targetId);
    this.readySet.delete(targetId);
    this.doodleColors.delete(targetId);
    this.doodle = this.doodle.filter((d) => d.by !== targetId);

    // 그리던 사람을 내보냈으면 그 라운드는 접는다. 반쯤 그린 그림을 조각내봐야
    // 아무도 못 맞히고, 출제자 없는 라운드를 계속 돌릴 수도 없다.
    if (wasDrawer && (this.phase === 'drawing' || this.phase === 'guessing')) {
      this.clearTimer();
      this.round = Math.max(0, this.round - 1);   // endRound 뒤의 advance가 다음 사람을 집게 한다
      this.endRound([]);
      return true;
    }

    this.broadcastRoom();
    // 남은 사람만으로 회차가 끝날 수 있는지 다시 본다. 기다릴 대상이 하나 줄었다.
    if (this.phase === 'guessing') this.maybeEndAttempt();
    return true;
  }

  /**
   * 관전으로 돌리거나 참여로 돌아온다. 로비에서만.
   *
   * 여기서 자동으로 꺼주는 길은 어디에도 없다. 그것이 규칙이다 —
   * 도중에 들어온 사람을 다음 라운드에 자동 합류시키면 예전으로 되돌아간다.
   */
  setSpectator(playerId: string, on: boolean): void {
    if (this.phase !== 'lobby') return;
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.spectator === on) return;
    p.spectator = on;
    if (on) this.handOverHostIfWatching();
    this.broadcastRoom();
  }

  /**
   * 방장이 관전을 켜면 참여 중인 사람에게 방장을 넘긴다.
   *
   * 시작·다음 버튼은 방장만 누른다. 구경하러 온 사람 뒤에 그 버튼이 잠기면,
   * 결과 화면마다 그 사람이 눌러주기를 전원이 기다린다 — 판을 안 하는 사람이
   * 판을 진행시켜야 하는 자리가 된다.
   *
   * 넘길 사람이 없으면(전원 관전) 그대로 둔다. 아무도 못 누르는 것보다 낫다.
   */
  private handOverHostIfWatching(): void {
    const host = this.players.find((p) => p.id === this.hostId);
    if (!host?.spectator) return;
    // 관전자끼리 주고받아봐야 달라지는 것이 없으므로 참여자가 있을 때만 넘긴다.
    const next = this.players.find((p) => p.connected && !p.spectator);
    if (next) this.hostId = next.id;
  }

  start(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    // 살아있는 사람만 센다. 유령을 세면 "4인 게임"이 실제로는 두 명이 돌게 되고,
    // 순번에 유령이 끼면 beginRound가 건너뛰어 라운드 번호가 껑충 뛴다.
    // 관전자도 같은 이유로 뺀다 — 순번에 넣으면 안 그리는 사람 차례에서 라운드가 빈다.
    const live = this.players.filter((p) => p.connected && !p.spectator);
    if (live.length < this.rules.minPlayers) {
      this.send(playerId, {
        t: 'error',
        msg: `${this.rules.minPlayers}명 이상이어야 시작할 수 있습니다 (관전자는 세지 않습니다)`,
      });
      return;
    }
    /*
     * 준비 여부는 여기서 막지 않는다 — 화면에서 시작 버튼을 잠그는 것으로 충분하다.
     *
     * 색 팔레트는 서버가 막았는데 이건 왜 다른가. 색은 서버가 쥔 그림 데이터를
     * 바꾸는 일이라 뚫리면 **남들이 보는 판**이 망가진다. 반면 시작은 원래 방장의
     * 권한이고, 뚫어봐야 자기 방을 자기가 일찍 시작하는 것뿐이다. 지킬 것이 없다.
     *
     * 서버에서 막으면 대가가 컸다. 준비 안 한 사람이 하나라도 있으면 start가 조용히
     * 실패하는데, 그러면 "판이 끝날 때까지" 도는 시험이 **실패가 아니라 무한 대기**가
     * 된다. 앞으로 사람을 넣는 시험을 쓸 때마다 밟을 지뢰를 심는 셈이다.
     */
    this.order = live.map((p) => p.id);
    this.round = 0;
    // 새 판이 시작되면 아무도 '늦게 온 사람'이 아니다. 이름은 로비에서 바꾼다.
    for (const p of this.players) p.lateJoin = false;
    // 이미 나온 제시어는 비우지 않는다. 방을 이어 쓰는 동안 계속 기억한다.
    this.chatLog = [];
    this.recaps = [];
    this.doodleColors.clear();
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
    this.rerollsLeft = this.rules.wordRerolls;
    this.strokes = [];
    this.slices = [];
    this.owner.clear();
    this.sliceId.clear();
    this.seen.clear();
    this.doodle = [];
    this.lastRoundEnd = null;
    // 시도 상태는 여기서도 반드시 지운다. endAttempt는 이어가는 길에서만 지우고
    // endRound로 빠지는 두 길에서는 안 지우기 때문에, 안 지우면 다음 라운드 내내
    // 지난 라운드의 ✎ 표시가 남고 room.attempt가 3으로 나간다.
    this.attempt = 1;
    this.answers.clear();
    this.wrongSubmits.clear();
    this.skippedThisAttempt.clear();
    this.solved.clear();
    this.answerLog.clear();
    this.drawerEarned = 0;
    this.phase = 'drawing';

    // 낙서 색을 미리 배정한다. 그릴 때 배정하면 남의 팔레트에는 그 사람이 첫 획을
    // 긋기 전까지 그 색이 비어 보이고, 그 틈에 같은 색을 골라버린다.
    // 맞히는 사람만이 아니라 전원에게 준다. 낙서에는 안 쓰지만 결과 화면의
    // 이야기에서 이름 색으로 쓰이므로, 출제자와 관전자만 색이 비면 안 된다.
    for (const p of this.players) this.ensureDoodleColor(p.id);

    // 화면 전환을 먼저 보낸다. 반대로 하면 아직 숨겨진 캔버스에 그려 폭 0으로 뭉갠다.
    this.setDeadline(this.rules.drawSeconds, () => this.endDrawing());

    /*
     * 한 획도 안 그으면 일찍 접는다.
     *
     * 폰을 내려놓고 가버리는 일이 실제로 생기는데, 그러면 나머지 사람들이 아무것도
     * 안 나오는 화면을 120초 내내 본다. 한 획이라도 그었으면 그리는 중이라고 보고
     * 끝까지 기다린다 — 느리게 그리는 사람을 쫓아내면 안 된다.
     */
    const idle = this.rules.idleDrawSeconds;
    if (idle > 0) {
      this.cancelIdle = this.scheduler.after(idle * 1000, () => {
        if (this.phase !== 'drawing' || this.strokes.length > 0) return;
        // 따로 알리지 않는다. 결과 화면에 빈 원판이 뜨는 것이 그 자체로 설명이 된다.
        this.endDrawing();
      });
    }

    this.broadcastRoom();
    this.send(this.drawerId, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
    // 관전자는 출제자와 같은 것을 본다. 빈 캔버스부터 같이 보게 지금 한 번 보낸다.
    for (const p of this.spectators()) {
      this.send(p.id, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
      this.send(p.id, { t: 'canvas', strokes: this.strokes });
    }
  }

  /**
   * 제시어를 다시 뽑는다. 그리는 중에, 출제자만, 남은 횟수 안에서.
   *
   * "뭘 그릴지 모르겠다"로 판이 멈추는 것을 막는 장치다. 두 가지를 일부러 안 한다:
   * 시간은 다시 안 준다(돌려서 시간을 벌 수 없어야 한다), 주제는 안 바꾼다
   * (맞히는 사람들이 이미 주제를 받았고, 바뀌면 그 힌트가 거짓이 된다).
   */
  rerollWord(playerId: string): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    if (this.rerollsLeft <= 0) return;

    this.rerollsLeft--;
    // 같은 주제 안에서만 다시 뽑는다.
    const before = this.selectedTopics;
    this.selectedTopics = [this.topic];
    const chosen = this.nextWord();
    this.selectedTopics = before;
    this.word = chosen.word;

    // 그리던 것은 지운다. 다른 단어를 보고 그린 선이라 남겨두면 정답과 어긋난다.
    this.strokes = [];
    this.send(playerId, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
    this.send(playerId, { t: 'canvas', strokes: this.strokes });
    for (const p of this.spectators()) {
      this.send(p.id, { t: 'word', word: this.word, rerollsLeft: this.rerollsLeft });
      this.send(p.id, { t: 'canvas', strokes: this.strokes });
    }
  }

  addStroke(playerId: string, points: Point[], color?: string): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    // 부르는 쪽이 걸러줬으리라 믿지 않는다. 지금은 index.ts가 검사하지만, 그 검사를
    // 안 거치는 길이 하나라도 생기면 여기서 예외가 나고 프로세스가 통째로 내려간다.
    //
    // 점의 생김새까지 본다. [null] 처럼 배열이긴 한데 안이 이상한 것을 그대로 넘기면
    // insideCircle이 null[0]을 읽다 터진다.
    if (!Array.isArray(points)) return;
    const clean = points.filter((p) => wellFormed(p) && insideCircle(p));
    if (clean.length < 2) return;
    // 색은 팔레트에 있는 것만 받는다. 아무 값이나 믿으면 배경과 같은 색으로 그어
    // "안 보이는 그림"을 만들 수 있고, 그러면 아무도 못 맞힌다.
    //
    // 흑백판이면 여기서 검정으로 눌러버린다. 화면에서 팔레트를 감추는 것만으로는
    // 안 된다 — 그건 안 보이게 한 것이지 못 하게 한 것이 아니다.
    const ink = this.colorMode === 'mono' ? DEFAULT_COLOR : safeColor(color);
    this.strokes.push({ points: clean, color: ink });
    this.pushCanvasToSpectators();
  }

  /**
   * 지우개가 지나간 자리의 잉크를 지운다.
   *
   * **픽셀 지우개가 아니다.** 예전에는 획 지우개였고 그 이유를 "그림이 폴리라인이라서"라고
   * 적어뒀었는데, 그 걱정이 막으려던 것은 픽셀 지우개였다. 지금 쓰는 부분 지우개는
   * 폴리라인을 폴리라인으로 자를 뿐이라 자료 구조가 그대로다 — 조각내기가 서 있는
   * 폴리라인 클리핑도 그대로 돈다. 픽셀로 바꾸는 것은 여전히 하면 안 된다.
   *
   * 경로를 통째로 받아 선분마다 캡슐로 지운다. 묶음(50ms)으로 오므로 점이 여럿이다.
   */
  eraseInk(playerId: string, path: Point[]): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    // 배열이기만 하고 안이 이상한 것([null] 등)이 들어올 수 있다. 걸러내지 않으면
    // 아래에서 null[0]을 읽다 프로세스가 내려간다.
    const clean = Array.isArray(path) ? path.filter(wellFormed) : [];
    if (clean.length === 0) return;
    path = clean;

    let strokes = this.strokes;
    let changed = false;

    for (let i = 0; i < Math.max(1, path.length - 1); i++) {
      const to = path[i + 1] ?? path[i];

      // 껑충 뛴 구간은 잇지 않고 도착한 자리만 콕 찍어 지운다. 포인터가 창 밖에
      // 나갔다 온 경우인데, 이어 지우면 지나지도 않은 자리가 쓸려나간다.
      // **클라이언트도 똑같이 한다**(canvas.ts eraseAt) — 여기만 다르면 두 화면이 어긋난다.
      const raw = path[i];
      const from = Math.hypot(to[0] - raw[0], to[1] - raw[1]) > MAX_ERASE_STEP ? to : raw;

      const after = eraseStrokes(strokes, from, to, ERASE_RADIUS);
      if (!after) continue;
      strokes = after;
      changed = true;
    }

    if (!changed) return;

    this.strokes = strokes;
    this.send(playerId, { t: 'canvas', strokes: this.strokes });
    this.pushCanvasToSpectators();
  }

  undo(playerId: string): void {
    if (this.phase !== 'drawing') return;
    if (playerId !== this.drawerId) return;
    this.strokes.pop();
    this.send(playerId, { t: 'canvas', strokes: this.strokes });
    this.pushCanvasToSpectators();
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
    this.skippedThisAttempt.clear();
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
/** 이번 회차를 넘기겠다고 누른 사람. 아직 못 맞힌 사람이 전부 누르면 회차가 끝난다 */
  protected skippedThisAttempt = new Set<string>();
  /**
   * 회차마다 누가 뭐라고 냈는가. 회차가 끝날 때만 쌓는다 —
   * 실시간으로 흘리면 통화 중인 출제자가 반응해버려 정답이 샌다.
   */
  protected answerLog = new Map<string, Array<{ attempt: number; text: string; skipped: boolean; correct: boolean }>>();

  /** 이미 맞혀서 점수가 확정된 사람 → 그 점수 */
  protected solved = new Map<string, number>();

  /**
   * 이번 라운드에 출제자가 벌어들인 점수. 조립판에서 누가 맞히는 순간 한 번만 오른다.
   * 몇 명이 맞혔든 값은 같다.
   */
  protected drawerEarned = 0;
  protected answers = new Map<string, string>();
  protected seen = new Map<string, Set<number>>();

  /**
   * 대기 화면 낙서판. 출제자가 그리는 동안만 살아 있고 라운드마다 지워진다.
   * 판정에 쓰이지 않으므로 검증은 좌표 범위와 개수 상한뿐이다.
   */
  protected doodle: Array<{ by: string; points: Point[]; color: string }> = [];

  /** 사람 → 그 사람이 쓰는 낙서 색. 겹쳐도 된다 — 지우기는 색이 아니라 사람으로 가른다. */
  protected doodleColors = new Map<string, string>();

  /**
   * 고를 수 있는 낙서 색. 그리는 팔레트와 같은 목록을 쓴다.
   *
   * 다만 **낙서판의 색은 "누가 그렸나"를 나른다.** 그림 팔레트와 달리 여기서는 색이
   * 뜻을 나르므로, 처음 배정만은 앞에서부터 서로 다르게 준다(ensureDoodleColor).
   * 고르는 것은 18색 전부 열려 있다.
   */
  static readonly DOODLE_PALETTE: readonly string[] = PALETTE;

  /**
   * 아직 색이 없는 사람에게 남는 색을 하나 준다.
   *
   * 처음에 서로 다른 색을 주는 것은 그래야 누가 뭘 그렸는지 한눈에 보이기 때문이지,
   * 겹치면 안 되기 때문이 아니다. 겹쳐도 안전하다 — clearDoodle을 보라.
   * 색이 다 나가면 첫 색부터 다시 쓴다.
   */
  protected ensureDoodleColor(playerId: string): string {
    const had = this.doodleColors.get(playerId);
    if (had) return had;
    const taken = new Set(this.doodleColors.values());
    const free = Session.DOODLE_PALETTE.find((c) => !taken.has(c)) ?? Session.DOODLE_PALETTE[0];
    this.doodleColors.set(playerId, free);
    return free;
  }

  /**
   * 색을 고른다. 남이 쓰는 색이어도 된다.
   *
   * 예전에는 남이 쓰는 색을 막았다. "같은 색을 쓰면 남이 지울 때 내 것도 지워진다"는
   * 제보 때문이었는데, 확인해 보니 지우기는 처음부터 색이 아니라 사람으로 가르고 있었다
   * (clearDoodle). 겹친 색을 보고 그렇게 보였을 뿐 실제로 지워진 적은 없다.
   * 없는 위험을 막느라 색 아홉 개를 선착순으로 잠가둔 셈이라 풀었다.
   */
  setDoodleColor(playerId: string, color: string): void {
    if (!Session.DOODLE_PALETTE.includes(color)) return;
    this.doodleColors.set(playerId, color);
    this.broadcastRoom();
  }

  /** 낙서 획 상한. 넘치면 오래된 것부터 버린다 — 판이 멈추는 것보다 낫다. */
  private static readonly DOODLE_MAX = 600;

  addDoodle(playerId: string, points: Point[], color: string): void {
    if (this.phase !== 'drawing') return;
    // 정답을 아는 사람은 낙서판에 못 그린다. 출제자는 자기 캔버스가 따로 있어서고,
    // 관전자는 여기에 그리는 것이 곧 정답을 알려주는 짓이기 때문이다.
    if (this.knowsAnswer(playerId)) return;
    if (!this.players.some((p) => p.id === playerId)) return;
    if (points.length < 2) return;
    // 색은 서버가 들고 있는 그 사람 색을 쓴다. 클라이언트가 보낸 값을 그대로 믿으면
    // 남의 색을 흉내 내 그릴 수 있고, 그러면 누구 선인지 구분이 안 된다.
    if (color) this.setDoodleColor(playerId, color);
    const safe = this.ensureDoodleColor(playerId);
    this.doodle.push({ by: playerId, points, color: safe });
    if (this.doodle.length > Session.DOODLE_MAX) this.doodle.shift();
    // 출제자만 빼고 전부에게 보낸다. 관전자는 그리지는 못하지만 보는 것은 안전하다 —
    // 이미 정답을 아는 사람이라 낙서에서 새어 나갈 것이 없다.
    for (const p of this.players) {
      if (p.id === this.drawerId) continue;
      this.send(p.id, { t: 'doodleStroke', by: playerId, points, color: safe });
    }
  }

  /**
   * 낙서 지우개가 지나간 자리를 지운다. 내가 그은 획만 — 남의 낙서는 못 건드린다.
   *
   * 판을 통째로 다시 보내는 것은 낭비 같지만, 획 번호는 사람마다 다르게 셀 수 없다.
   * 상한이 600획이라 그대로 보내도 부담이 없다.
   */
  eraseDoodleInk(playerId: string, path: Point[]): void {
    if (this.phase !== 'drawing') return;
    if (this.knowsAnswer(playerId)) return;
    if (path.length === 0) return;

    let strokes = this.doodle;
    let changed = false;

    for (let i = 0; i < Math.max(1, path.length - 1); i++) {
      const to = path[i + 1] ?? path[i];
      const raw = path[i];
      const from = Math.hypot(to[0] - raw[0], to[1] - raw[1]) > MAX_ERASE_STEP ? to : raw;

      const after = eraseStrokes(strokes, from, to, DOODLE_ERASE_RADIUS, (s) => s.by === playerId);
      if (!after) continue;
      strokes = after;
      changed = true;
    }

    if (!changed) return;

    // 지우개는 획을 쪼개므로 개수가 늘 수 있다. 상한을 넘으면 그릴 때와 같이
    // 오래된 것부터 버린다 — 판이 멈추는 것보다 낫다.
    while (strokes.length > Session.DOODLE_MAX) strokes.shift();

    this.doodle = strokes;
    for (const p of this.players) {
      if (p.id === this.drawerId) continue;
      this.send(p.id, { t: 'doodleBoard', strokes: this.doodle });
    }
  }

  clearDoodle(playerId: string): void {
    if (this.phase !== 'drawing') return;
    const before = this.doodle.length;
    this.doodle = this.doodle.filter((s) => s.by !== playerId);
    if (this.doodle.length === before) return;
    for (const p of this.players) {
      if (p.id === this.drawerId) continue;
      this.send(p.id, { t: 'doodleBoard', strokes: this.doodle });
    }
  }

  answer(playerId: string, text: string): void {
    if (this.phase !== 'guessing') return;
    if (!this.seen.has(playerId)) return; // 출제자와 관전자는 못 적는다
    if (this.solved.has(playerId)) return; // 이미 맞힌 사람은 더 낼 것이 없다
    // 스킵을 누른 사람은 이번 회차를 접은 것이다. 뒤늦게 도착한 답을 받아 채점하면
    // 스킵으로 점수를 지키려던 사람이 오답으로 점수를 잃는다.
    if (this.skippedThisAttempt.has(playerId)) return;
    this.answers.set(playerId, String(text).slice(0, 40));
    this.broadcastRoom();
    this.maybeEndAttempt();
  }

  /**
   * 결과·최종 화면에서 한마디 남긴다.
   *
   * 이 두 화면에서만 받는다. 회차 중에는 방 안에 정답을 아는 사람이 셋 있고
   * (출제자·관전자·먼저 맞힌 사람), 그중 하나가 한 줄 치면 나머지가 공짜로 점수를 가져간다.
   * 화면에서 감추는 것으로는 못 막는다 — 브라우저 콘솔로 그대로 보낼 수 있다.
   */
  chat(playerId: string, text: string): void {
    if (this.phase !== 'roundEnd' && this.phase !== 'final') return;
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return;
    // String(text)를 그냥 부르지 않는다. JSON으로는 못 오는 값이지만, 바깥에서 온 것을
    // 문자열로 바꾸는 일 자체가 남의 코드를 부르는 일이다(toString). 글자면 글자만 받는다.
    if (typeof text !== 'string') return;
    // 채팅은 막지 않고 가린다. 한 줄 흘려보내자고 판을 세울 이유가 없고,
    // 무슨 말을 했는지는 남되 그 글자만 안 보이면 된다.
    const clean = maskProfanity(text.trim().slice(0, Session.CHAT_LEN));
    if (clean.length === 0) return;

    const line: ChatLine = {
      id: randomUUID(),
      by: playerId,
      // 이름과 색을 지금 박아둔다. 나중에 명단에서 지워져도 줄은 그대로 읽혀야 한다.
      name: p.name,
      color: this.ensureDoodleColor(playerId),
      text: clean,
      // 최종 화면에서 나온 말은 어느 라운드에도 속하지 않는다.
      round: this.phase === 'final' ? -1 : this.round,
      word: this.phase === 'final' ? '' : this.word,
    };
    this.chatLog.push(line);
    if (this.chatLog.length > Session.CHAT_MAX) this.chatLog.shift();
    this.broadcast({ t: 'chat', line });
  }

  /**
   * 이번 회차를 넘기겠다고 누른다.
   *
   * 예전에는 이 자리가 "힌트받기"였다. 점수를 깎아 조각을 사는 개인 선택이었는데,
   * 조각은 이제 회차마다 자동으로 한 장씩 늘어난다. 그래서 이 버튼이 하는 일은
   * 하나로 줄었다 — 아직 못 맞힌 사람이 전부 누르면 남은 시간을 버리고 다음 회차로
   * 간다. 다음 회차로 가면 조각이 한 장 늘어나므로, 결과만 보면 힌트를 앞당겨 받는다.
   */
  skip(playerId: string): void {
    if (this.phase !== 'guessing') return;
    if (!this.seen.has(playerId)) return;           // 출제자·관전자
    if (this.solved.has(playerId)) return;          // 이미 맞혔다
    if (this.skippedThisAttempt.has(playerId)) return;

    this.skippedThisAttempt.add(playerId);
    // 스킵은 이번 회차를 접겠다는 뜻이다. 적어둔 답이 남아 있으면 그 답으로 채점돼
    // 점수를 잃는다 — 버튼을 누른 의도와 정반대다.
    this.answers.delete(playerId);
    this.broadcastRoom();
    this.maybeEndAttempt();
  }

  /**
   * 아직 못 맞힌 사람이 모두 답을 냈거나 스킵을 눌렀으면 남은 시간을 기다릴 이유가 없다.
   */
  private maybeEndAttempt(): void {
    if (this.phase !== 'guessing') return;
    // 조각을 받은 사람만 센다. 라운드 도중 들어온 관전자는 답도 스킵도 못 하므로,
    // 세어버리면 전원이 스킵을 눌러도 정족수가 영영 안 차고 20초를 그냥 기다린다.
    const pending = this.guessers().filter((g) => this.seen.has(g.id) && !this.solved.has(g.id));
    if (pending.length === 0) return this.endAttempt();
    if (pending.every((g) => this.answers.has(g.id) || this.skippedThisAttempt.has(g.id))) {
      this.endAttempt();
    }
  }

  /**
   * 회차가 하나 오를 때마다 아직 못 맞힌 사람에게 조각을 한 장씩 나눠준다.
   *
   * 사람마다 다른 조각을 받는다 — 같은 조각을 주면 전원이 같은 그림을 보게 되어
   * "내 조각만 보고 맞힌다"는 이 게임의 전제가 무너진다.
   */
  private grantSlices(): void {
    for (const [id, mine] of this.seen) {
      if (this.solved.has(id)) continue;
      if (mine.size >= this.rules.maxSlices) continue;
      const candidates = this.slices.map((x) => x.index).filter((i) => !mine.has(i));
      if (candidates.length === 0) continue;
      mine.add(candidates[this.pick(candidates.length)]);
    }
  }

  /**
   * 지금 이 사람이 맞혔을 때 받게 될 점수. 화면에 미리 보여준다.
   *
   * 회차가 오를 때마다 조각이 한 장씩 늘어나므로, 값도 회차로 깎는다 —
   * 조각을 더 보고 맞혔으면 그만큼 덜 받는 것이 이 게임의 유일한 저울이다.
   */
  scoreFor(playerId: string): number {
    if (this.attempt >= this.rules.maxAttempts) return this.rules.finalAttemptScore;
    const wrong = this.wrongSubmits.get(playerId) ?? 0;
    const raw = this.rules.startScore
      - (this.attempt - 1) * this.rules.attemptCost
      - wrong * this.rules.wrongSubmitCost;
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
      if (judge(text, this.word)) {
        this.solved.set(id, this.scoreFor(id));
        // 조립판에서 맞혔다면 출제자도 받는다. 여러 명이 맞혀도 한 번만 — 대입이라 저절로 그렇다.
        if (this.attempt >= this.rules.maxAttempts) this.drawerEarned = this.rules.drawerScore;
      } else {
        this.wrongSubmits.set(id, (this.wrongSubmits.get(id) ?? 0) + 1);
      }
    }

    // 이번 회차에 각자 뭘 했는지 남긴다. 출제자 현황판이 회차별로 되짚어 볼 자료다.
    for (const id of this.seen.keys()) {
      const text = this.answers.get(id) ?? '';
      const skipped = this.skippedThisAttempt.has(id);
      if (this.solved.has(id) && text.length === 0 && !skipped) continue; // 이미 맞힌 뒤에는 안 남긴다
      const log = this.answerLog.get(id) ?? [];
      log.push({ attempt: this.attempt, text, skipped, correct: text.length > 0 && judge(text, this.word) });
      this.answerLog.set(id, log);
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
    this.skippedThisAttempt.clear();
    // 회차가 올랐으니 조각을 한 장씩 나눠준다. 조각을 늘린 뒤에 방 상태를 보내야
    // 화면의 조각 수와 실제로 내려간 조각이 어긋나지 않는다.
    this.grantSlices();

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
    const delta = new Map<string, number>(this.solved);
    // 출제자 몫은 조립판에서만 붙는다. 0이면 아예 넣지 않는다 — 넣으면 결과 화면에
    // 출제자만 "+0"이라는 없는 줄이 하나 생긴다.
    if (this.drawerEarned > 0) delta.set(this.drawerId, this.drawerEarned);
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
      // 관전자는 뺀다. 점수가 없는 사람이 0점으로 줄에 끼면 꼴찌로 읽히고,
      // 결과 화면 답 목록도 이 줄로 그려지므로 '(무응답)'까지 따라붙는다.
      scores: this.players
        .filter((p) => !p.spectator)
        .map((p) => ({ playerId: p.id, delta: delta.get(p.id) ?? 0, total: p.score })),
      correct,
      answers,
    };
    this.lastRoundEnd = msg;
    this.broadcast(msg);

    // 빈 캔버스는 남길 것도, 모아 보여줄 것도 없다.
    if (this.strokes.length > 0) {
      // 이름을 지금 박아둔다. 판이 끝나고 누가 나가도 그림 밑의 이름은 남아야 한다.
      const nameOf = (id: string): string => this.players.find((p) => p.id === id)?.name ?? '?';
      this.recaps.push({
        round: this.round,
        topic: this.topic,
        word: this.word,
        drawing: this.strokes,
        sliceCount: this.slices.length,
        drawer: nameOf(this.drawerId),
        correct: correct.map(nameOf),
      });

      this.onDrawing?.({
        at: new Date().toISOString(),
        topic: this.topic,
        word: this.word,
        sliceCount: this.slices.length,
        strokes: this.strokes,
        solved: correct.length,
        guessers: this.seen.size,
      });
    }
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
    if (this.activeCount < this.rules.minPlayers - 1) {
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
   * 최종 화면에서 한 판 더. 방장만 누를 수 있다.
   *
   * 예전에는 누구나 눌렀다 — 이 문이 한 사람 뒤에 잠기면 그 사람이 자리를 뜬 순간
   * 방 코드가 통째로 죽는다는 이유였다. 그 걱정은 방장 승계가 막아준다:
   * 방장이 끊기면 hostId가 살아있는 사람에게 곧바로 넘어간다(disconnect 참조).
   * 남는 문제는 결과를 아직 보고 있는데 누가 새 판을 시작해버리는 쪽이라,
   * 다음 라운드로 넘기는 next()와 같은 문을 쓴다.
   */
  again(playerId: string): void {
    if (this.phase !== 'final') return;
    if (playerId !== this.hostId) return;
    if (!this.players.some((p) => p.id === playerId)) return;

    this.clearTimer();
    this.prune();
    this.order = [];
    this.round = 0;
    this.attempt = 1;
    this.answers.clear();
    // 준비는 판마다 새로 받는다. 판이 끝나면 자리를 뜨는 사람이 있어서, 지난 판의
    // 준비를 그대로 두면 없는 사람을 준비된 것으로 세고 시작해버린다.
    this.readySet.clear();
    // usedWords는 여기서도 비우지 않는다 — 한 판 더는 '새 방'이 아니라 '이어서 한 판'이다.
    this.chatLog = [];
    this.recaps = [];
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
        .filter((p) => !p.spectator)
        .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
      rounds: this.recaps,
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
      if (this.hostId === playerId) this.hostId = this.pickHost();
    } else {
      this.players[idx].connected = false;
      // 방장이 게임 도중(로비가 아닐 때) 끊기면 hostId를 그대로 두지 않는다.
      // next()가 방장만 통과시키는 유일한 문이라, hostId가 끊긴 사람을 계속
      // 가리키면 결과 화면에서 아무도 다음으로 못 넘겨 방이 영구히 멈춘다.
      // 살아있는 사람이 없으면 hostId를 비워둔다 — 방이 비었으니 상관없다.
      // 원래 방장이 돌아와도 이 자리를 돌려주지 않는다: join()은 hostId가
      // 비어 있을 때만 새로 채우므로, 넘어간 방장을 몰래 바꿔치기하지 않는다.
      if (this.hostId === playerId) {
        this.hostId = this.pickHost();
      }
    }
    this.broadcastRoom();
    // 방금 나간 사람이 이미 답을 냈거나 스킵을 눌렀다면, 그를 기다릴 이유가 없으니
    // 남은 사람들 기준으로 회차를 마무리할 수 있는지 본다.
    //
    // 반대로 아직 아무것도 안 한 채 끊겼다면 기다려준다. 회차는 20초뿐이고,
    // 잠깐 끊긴 사람의 기회를 그 자리에서 빼앗는 것이 몇 초 더 기다리는 것보다 나쁘다.
    // 실제로 연결이 불안정한 사람이 회차마다 기회를 잃는 일이 있었다.
    // 단, 맞히는 사람이 하나도 안 남았다면 기다릴 대상 자체가 없으니 바로 정리한다.
    const acted = this.answers.has(playerId) || this.skippedThisAttempt.has(playerId);
    if (acted || this.guessers().length === 0) {
      this.maybeEndAttempt();
    }
  }

  handle(playerId: string, msg: ClientMsg): void {
    /*
     * 세션은 스스로를 지킨다.
     *
     * 지금 유일한 부르는 쪽(index.ts)이 형태를 검사하고 넘겨주지만, **그 검사에
     * 기대지 않는다.** 방 상태가 메모리에만 있어서 여기서 예외 하나가 나면 프로세스가
     * 내려가고 돌던 판이 전부 날아간다. 값이 하나 이상한 것과 판이 끝나는 것은
     * 치러야 할 대가가 너무 다르다.
     */
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    switch (msg.t) {
      case 'again': return this.again(playerId);
      case 'join': return this.join(playerId, msg.name);
      case 'start': return this.start(playerId);
      case 'setTopics': return this.setTopics(playerId, msg.topics);
      case 'setCapacity': return this.setCapacity(playerId, msg.max);
      case 'setSpectator': return this.setSpectator(playerId, msg.on);
      case 'setLock': return this.setLock(playerId, msg.on);
      case 'setReady': return this.setReady(playerId, msg.on);
      case 'setColorMode': return this.setColorMode(playerId, msg.mode);
      case 'stroke': return this.addStroke(playerId, msg.points, msg.color);
      case 'undo': return this.undo(playerId);
      case 'erase': return this.eraseInk(playerId, msg.path);
      case 'drawDone': return this.drawDone(playerId);
      case 'answer': return this.answer(playerId, msg.text);
      case 'skip': return this.skip(playerId);
      case 'doodle': return this.addDoodle(playerId, msg.points, msg.color);
      case 'doodleClear': return this.clearDoodle(playerId);
      case 'doodleErase': return this.eraseDoodleInk(playerId, msg.path);
      case 'doodleColor': return this.setDoodleColor(playerId, msg.color);
      case 'chat': return this.chat(playerId, msg.text);
      case 'reroll': return this.rerollWord(playerId);
      case 'next': return this.next(playerId);
      default: return;
    }
  }

  // ---------- 보조 ----------

  /**
   * 준비를 세는 대상 — 붙어 있는 참여자.
   *
   * 관전자는 안 그리고 안 맞히니 뺀다. 끊긴 사람도 뺀다 — 폰을 껐다 켠 유령 하나
   * 때문에 시작이 영영 막히면 안 된다.
   */
  private readyPool(): Player[] {
    return this.players.filter((p) => p.connected && !p.spectator);
  }

  /** 준비한 사람 수. 방장은 늘 준비된 것으로 센다. */
  get readyCount(): number {
    return this.readyPool().filter((p) => p.id === this.hostId || this.readySet.has(p.id)).length;
  }

  get readyOf(): number {
    return this.readyPool().length;
  }

  /**
   * 준비를 켜고 끈다. 로비에서만, 방장이 아닌 사람만.
   *
   * 방장이 부르면 아무 일도 안 한다. 방장의 의사 표시는 시작 버튼이다.
   */
  setReady(playerId: string, on: boolean): void {
    if (this.phase !== 'lobby') return;
    if (playerId === this.hostId) return;
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.spectator) return;
    if (on) this.readySet.add(playerId); else this.readySet.delete(playerId);
    this.broadcastRoom();
  }

  /** 지금 이 방에 실제로 붙어 있는 사람 수. 정원·시작 인원 판정은 전부 이걸 쓴다. */
  get connectedCount(): number {
    return this.players.filter((p) => p.connected).length;
  }

  /**
   * 방장을 넘길 사람을 고른다.
   *
   * 참여 중인 사람이 먼저다 — 시작·다음 버튼이 구경하러 온 사람 뒤에 잠기면
   * 결과 화면마다 전원이 그 사람을 기다린다. 판을 안 하는 사람이 판을 진행시키는 자리가 된다.
   * 참여자가 하나도 없으면 관전자라도 세운다. 아무도 못 누르는 것보다 낫다.
   */
  private pickHost(): string {
    const live = this.players.filter((p) => p.connected);
    return (live.find((p) => !p.spectator) ?? live[0])?.id ?? '';
  }

  /** 끊긴 사람을 명단에서 지운다. 로비로 돌아갈 때와 한 판 더에서만 부른다. */
  private prune(): void {
    this.players = this.players.filter((p) => p.connected);
    if (!this.players.some((p) => p.id === this.hostId)) {
      this.hostId = this.pickHost();
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
    const pool = this.selectedTopics.length > 0
      ? this.topics.filter((t) => this.selectedTopics.includes(t.topic))
      : this.topics;
    const unused = () => pool
      .map((t) => ({ topic: t.topic, words: t.words.filter((w) => !this.usedWords.has(w)) }))
      .filter((t) => t.words.length > 0);

    let fresh = unused();
    if (fresh.length === 0) {
      // 고를 수 있는 단어를 다 썼다. 기억을 비우고 처음부터 다시 돈다.
      //
      // 비우는 것은 지금 후보군의 단어뿐이다. 주제를 고정해 두고 그 50개를 다 쓴 경우에
      // 나머지 아홉 주제의 기억까지 날리면, 나중에 랜덤으로 돌렸을 때 이미 나온 단어가
      // 무더기로 되돌아온다.
      for (const t of pool) for (const w of t.words) this.usedWords.delete(w);
      fresh = unused();
    }
    const chosen = pickWord(fresh, this.pick);
    this.usedWords.add(chosen.word);
    return chosen;
  }


  protected livePlayer(id: string): boolean {
    return this.players.some((p) => p.id === id && p.connected);
  }

  /**
   * 이번 라운드에 조각을 받고 답을 낼 사람들.
   *
   * 조각 수도 스킵 정족수도 전부 여기서 나온다 — 관전자를 여기서 한 번 빼면
   * 나머지가 저절로 따라온다.
   */
  protected guessers(): Player[] {
    return this.players.filter((p) => p.id !== this.drawerId && p.connected && !p.spectator);
  }

  /** 관전 중인 사람들. 출제자와 같은 것을 본다. */
  protected spectators(): Player[] {
    return this.players.filter((p) => p.connected && p.spectator);
  }

  /** 그 사람이 정답을 아는 쪽인가 — 출제자이거나 관전자. 보낼 것을 가르는 기준이다. */
  protected knowsAnswer(id: string): boolean {
    return id === this.drawerId || this.players.some((p) => p.id === id && p.spectator);
  }

  /** 실제로 게임을 도는 사람 수. 관전자는 빠진다. */
  get activeCount(): number {
    return this.players.filter((p) => p.connected && !p.spectator).length;
  }

  /**
   * 그리는 사람이 아무것도 안 하고 있는지 보는 타이머.
   *
   * 화면에 보이는 제한시간(setDeadline)과 따로 둔다. 그걸 같이 쓰면 남은 시간 표시가
   * 이 타이머에 맞춰 줄어들어서, 120초짜리 라운드가 30초처럼 보인다.
   */
  private cancelIdle: (() => void) | null = null;

  private clearIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
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
    this.clearIdle();
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
      // 회전을 되돌려 제자리에 끼운다. 색은 그대로 따라간다.
      return {
        index,
        strokes: this.slices[index].strokes.map((st) => ({
          points: rotate(st.points, CENTER, -spin),
          color: st.color,
        })),
      };
    });
    this.send(playerId, { t: 'assembled', sliceCount: count, pieces });
  }

  protected sendBoard(): void {
    if (this.phase !== 'guessing') return;
    const msg: ServerMsg = {
      t: 'board',
      sliceCount: this.slices.length,
      drawing: this.strokes,
      watching: [...this.seen.keys()].map((id) => ({
        playerId: id,
        slices: [...this.seen.get(id)!].sort((a, b) => a - b).map((i) => this.slices[i].strokes),
        solved: this.solved.has(id),
        history: this.answerLog.get(id) ?? [],
      })),
    };
    // 이미 답을 아는 사람 전부에게. 출제자, 관전자, 그리고 먼저 맞혀 할 일이 없어진 사람.
    this.send(this.drawerId, msg);
    for (const p of this.spectators()) this.send(p.id, msg);
    for (const id of this.solved.keys()) this.send(id, msg);
  }

  /**
   * 그려지는 원본을 관전자에게 실시간으로 흘린다.
   *
   * 획 하나마다 전체 캔버스를 다시 보내는 것은 낭비지만, 관전자가 없으면 한 번도
   * 안 보내고 있어도 한 판에 몇 명뿐이다. 획 단위 증분 프로토콜을 새로 만드는 값보다 싸다.
   */
  protected pushCanvasToSpectators(): void {
    for (const p of this.spectators()) {
      this.send(p.id, { t: 'canvas', strokes: this.strokes });
    }
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
      skipped: this.skippedThisAttempt.has(p.id),
      solved: this.solved.has(p.id),
      sliceCount: this.seen.get(p.id)?.size ?? 0,
      // 출제자는 조각을 맞히는 사람이 아니므로 scoreFor를 쓰면 아무 뜻 없는 숫자가 나간다.
      pendingScore: p.id === this.drawerId && this.phase !== 'lobby'
        ? this.drawerEarned
        : this.solved.get(p.id) ?? this.scoreFor(p.id),
      doodleColor: this.doodleColors.get(p.id) ?? '',
      spectator: p.spectator,
      // 서버가 실제로 이름을 받아주는 조건과 같아야 한다(join 참조).
      // 어긋나면 화면에는 칸이 떠 있는데 저장이 조용히 무시된다.
      canRename: this.phase === 'lobby' || p.lateJoin,
      // 방장은 늘 준비된 것으로 보인다 — 시작 버튼이 그 표시다.
      ready: p.id === this.hostId || this.readySet.has(p.id),
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
      now: Date.now(),
      minPlayers: this.rules.minPlayers,
      ready: this.readyCount,
      readyOf: this.readyOf,
      maxPlayers: this.capacity,
      /** 방장이 정원을 올릴 수 있는 한계. 스테퍼의 위쪽 끝이다. */
      capacityMax: this.rules.maxPlayers,
      topics: this.topics.map((t) => t.topic),
      selectedTopics: this.selectedTopics,
      roomName: this.name,
      roomCode: this.code,
      locked: this.locked,
      colorMode: this.colorMode,
    });
  }
}
