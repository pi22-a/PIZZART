import type { Point, Stroke } from './drawing';

export type Phase = 'lobby' | 'drawing' | 'guessing' | 'roundEnd' | 'final';

export interface PlayerInfo {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  isDrawer: boolean;
  /** 이번 시도에 답을 적어두었는가 (내용은 공개 전까지 안 나간다) */
  answered: boolean;
  /** 이번 회차를 넘기겠다고 눌렀는가 */
  skipped: boolean;
  /** 이미 맞혀서 점수가 확정됐는가 */
  solved: boolean;
  /** 지금 몇 조각을 들고 있는가 */
  sliceCount: number;
  /** 지금 맞히면 받을 점수. 이미 맞혔으면 확정된 점수 */
  pendingScore: number;
  /**
   * 이 사람이 쓰는 낙서 색. 라운드 시작에 서로 다른 색으로 배정되지만,
   * 직접 고르면 남과 겹쳐도 된다 — 지우기는 색이 아니라 사람 단위다.
   */
  doodleColor: string;
  /**
   * 관전자인가. 관전자는 출제자와 같은 것을 본다 — 제시어도, 그려지는 원본도.
   *
   * 그래서 이 값은 "정답을 아는 사람"이라는 뜻이기도 하다. 통화 중에 흘릴 수 있는
   * 사람이 누구인지 나머지가 알아야 하므로 전원에게 보낸다.
   */
  spectator: boolean;
  /**
   * 이름을 바꿀 수 있는가. 게임 도중에 들어온 사람만 참이다.
   *
   * 새로 온 사람이 계속 '손님'으로 남으면 결과 화면에서 누가 누군지 알 수 없다.
   * 반대로 원래 있던 사람이 도중에 이름을 바꾸면 그때까지의 기록이 헷갈린다.
   */
  canRename: boolean;
}

/** 로비 방 목록의 한 줄. */
export interface RoomInfo {
  code: string;
  name: string;
  count: number;
  max: number;
  phase: Phase;
  round: number;
  totalRounds: number;
  locked: boolean;
}

export type ClientMsg =
  /** cid는 브라우저가 sessionStorage에 들고 다니는 식별자다. 새로고침해도 같은 자리로 돌아온다. */
  | { t: 'join'; name: string; cid: string }
  | { t: 'start' }
  /** 로비에서 방장이 주제를 고정한다. null이면 라운드마다 무작위. */
  | { t: 'setTopics'; topics: string[] }
  /**
   * 관전으로 돌리거나 참여로 돌아온다. 로비에서만, 본인만.
   *
   * 로비에서만 되는 것이 규칙의 전부다 — 그래서 "시작 전에 정한다"가 저절로 지켜지고,
   * 도중에 들어온 사람은 판이 끝나 로비로 돌아오기 전에는 참여로 못 바꾼다.
   */
  | { t: 'setSpectator'; on: boolean }
  | { t: 'stroke'; points: Point[]; color: string }
  /**
   * 지우개가 지나간 자리. 그리는 중에, 출제자만.
   *
   * 획 번호가 아니라 **경로**로 보낸다. 부분 지우개라 획 하나가 여러 토막으로 쪼개지므로
   * "몇 번 획을 지워라"로는 표현이 안 된다. 그렇다고 지운 결과를 통째로 보내면 클라이언트가
   * 그림을 마음대로 갈아치울 수 있으니, **지나간 자리만 보내고 자르는 것은 서버가 한다.**
   *
   * 점 하나짜리 경로는 그 자리를 콕 찍어 지운다(캡슐의 양 끝이 같은 점).
   * 획과 같이 50ms마다 묶어 보내며, 묶음과 묶음 사이가 끊기지 않게 마지막 점을 겹쳐 보낸다.
   */
  | { t: 'erase'; path: Point[] }
  | { t: 'undo' }
  | { t: 'drawDone' }
  | { t: 'answer'; text: string }
  /** 이번 회차를 넘긴다. 아직 못 맞힌 사람이 전부 누르면 다음 회차로 간다. */
  | { t: 'skip' }
  /** 대기 화면 낙서 한 획. 게임 판정과 무관한 심심풀이라 검증만 하고 그대로 흘린다. */
  | { t: 'doodle'; points: Point[]; color: string }
  /** 내가 그린 낙서만 지운다. 남의 낙서는 건드리지 않는다. */
  | { t: 'doodleClear' }
  /** 낙서 지우개가 지나간 자리. 내가 그은 획만 지워진다 — 서버가 확인한다. */
  | { t: 'doodleErase'; path: Point[] }
  /** 낙서 색을 고른다. 남이 쓰는 색은 서버가 거절한다. */
  | { t: 'doodleColor'; color: string }
  /** 결과·최종 화면에서만. 다른 단계에서는 서버가 버린다. */
  | { t: 'chat'; text: string }
  /** 제시어를 다시 뽑는다. 그리는 중에, 출제자만, 남은 횟수 안에서. */
  | { t: 'reroll' }
  /** 로비에서 방을 만든다. 서버가 코드를 발급해 roomCreated로 돌려준다. */
  | { t: 'createRoom'; name: string }
  /** 방 목록을 다시 달라고 한다. 목록은 원래 저절로 오지만 손으로 확인하고 싶을 때가 있다. */
  | { t: 'rooms' }
  /** 방장이 내보낸다. 그 방에 한해 다시 못 들어온다. */
  | { t: 'kick'; playerId: string }
  /** 방장이 새 사람의 입장을 막거나 푼다. 이미 자리가 있는 사람의 재접속은 통과한다. */
  | { t: 'setLock'; on: boolean }
  | { t: 'next' }
  /** 최종 화면에서 한 판 더. 방장만이 아니라 누구나 누를 수 있다 — 한 사람 뒤에 방이 갇히면 안 된다. */
  | { t: 'again' };

/**
 * 결과·최종 화면에서 주고받는 한 줄.
 *
 * 이름과 색을 보낼 때 박아둔다. id만 두면 나간 사람의 줄이 이름 없는 줄이 된다 —
 * 로비로 돌아갈 때 명단에서 지우기(prune) 때문이다.
 */
export interface ChatLine {
  id: string;
  by: string;
  name: string;
  color: string;
  text: string;
  /** 어느 라운드에서 나온 말인가. 최종 화면에서 나온 것은 -1 */
  round: number;
  /** 그 라운드의 제시어. 구분선에 쓴다 */
  word: string;
}

/**
 * 한 판이 끝났을 때 되짚어 보는 라운드 하나.
 *
 * 그림을 다시 싣는다. 실제 데이터로 재보니 한 장 평균 16KB라 아홉 라운드를 합쳐도
 * 150KB 남짓이고, 판이 끝날 때 한 번 가는 것이라 감당할 만하다. 클라이언트가 라운드마다
 * 모아두는 방법도 있지만, 그러면 도중에 들어왔거나 새로고침한 사람만 텅 빈 화면을 본다.
 */
export interface RoundRecap {
  round: number;
  topic: string;
  word: string;
  drawing: Stroke[];
  sliceCount: number;
  /** 그린 사람의 이름 */
  drawer: string;
  /** 맞힌 사람들의 이름. id가 아니라 이름을 담는다 — 판이 끝난 뒤에 나간 사람도 이름은 남아야 한다. */
  correct: string[];
}

export interface AnswerRow {
  playerId: string;
  text: string;
  correct: boolean;
}

export type ServerMsg =
  | { t: 'joined'; youId: string }
  | {
      t: 'room';
      phase: Phase;
      players: PlayerInfo[];
      hostId: string;
      /** 지금 몇 번째 라운드인가 (0부터) */
      round: number;
      totalRounds: number;
      /** 전원에게 공개되는 주제. 로비에서는 빈 문자열 */
      topic: string;
      attempt: number;
      maxAttempts: number;
      /** 지금 단계가 끝나는 시각 (epoch ms). 타이머가 없으면 null */
      deadline: number | null;
      /**
       * 이 메시지를 보낸 서버 시각 (epoch ms).
       *
       * 남은 시간을 deadline − Date.now()로 재면 기기 시계가 어긋난 사람만
       * 혼자 시간이 빨리 가거나 늦게 간다. 서버 시각을 같이 보내 그 차이를 상쇄한다.
       */
      now: number;
      /** 게임을 시작하는 데 필요한 최소 인원 */
      minPlayers: number;
      /** 방 이름과 코드. 방 안에서 링크를 만들어 줄 때 쓴다. */
      roomName: string;
      roomCode: string;
      /** 새 사람의 입장이 막혀 있는가 */
      locked: boolean;
      /** 고를 수 있는 주제 목록 */
      topics: string[];
      /** 방장이 고정한 주제. null이면 라운드마다 무작위로 뽑는다 */
      /**
       * 방장이 고른 주제들. 비어 있으면 전체다.
       *
       * 하나만 고를 수 있던 때는 null이 전체를 뜻했는데, 여러 개를 고르게 되면서
       * "아무것도 안 고름"과 "전체"가 같은 뜻이 됐다. 빈 배열 하나로 둘 다 표현한다.
       */
      selectedTopics: string[];
    }
  /**
   * 제시어. 정답을 아는 쪽(출제자·관전자)에게만 간다.
   * rerollsLeft는 출제자가 제시어를 몇 번 더 바꿀 수 있는지다.
   */
  | { t: 'word'; word: string; rerollsLeft: number }
  /** 출제자가 새로고침했을 때 자기 그림을 되찾는다. 출제자에게만 간다. */
  | { t: 'canvas'; strokes: Stroke[] }
  /**
   * 내가 볼 수 있는 조각 전부 — 처음 받은 것 + 힌트로 받은 것. 전부 나만의 것이다.
   * 이미 회전되어 있고, id는 섹터 번호와 무관한 불투명 값이다.
   * 번호가 새면 "내 건 3시 방향"이 되고 게임이 그 자리에서 무너진다.
   *
   * count는 전체 조각 수다. 부채꼴을 몇 도로 그릴지에 필요하고,
   * 몇 조각으로 잘렸는지는 알아도 내 것이 어디였는지는 알 수 없으므로 새어도 무해하다.
   */
  | { t: 'slices'; count: number; slices: Array<{ id: string; strokes: Stroke[]; shared: boolean }> }
  /**
   * 마지막 회차의 조립판. 지금까지 본 조각을 회전을 풀어 제자리에 끼워 보여준다.
   * 이 게임의 핵심 장치인 회전을 마지막에 풀어주는 자비이자 마지막 기회다.
   * 여기서 맞히면 점수는 1점 고정이라, 방향을 알려줘도 판이 무너지지 않는다.
   */
  | { t: 'assembled'; sliceCount: number; pieces: Array<{ index: number; strokes: Stroke[] }> }
  /**
   * 이미 답을 아는 사람에게만 — 출제자와, 먼저 맞혀서 점수가 확정된 사람.
   * 지금 남들에게 어떤 조각이 나가 있는지 보여준다. 정답을 아는 사람들이라 원본을 실어도
   * 새는 것이 없고, 할 일이 없어진 그 시간이 남을 지켜보는 시간이 된다.
   */
  | {
      t: 'board';
      sliceCount: number;
      drawing: Stroke[];
      /**
       * 맞히는 사람마다 지금 무엇을 보고 있는가. 조각은 그 사람이 보는 그대로,
       * 이미 위를 향하게 돌아간 상태다 — 합쳐서 한 판으로 보여주면 "그림의 절반이
       * 나가 있다"는 사실만 남고, 누가 어떤 조각으로 헤매는지가 사라진다.
       */
      watching: Array<{
        playerId: string;
        slices: Stroke[][];
        solved: boolean;
        /**
         * 회차마다 뭐라고 냈는가. 회차가 끝날 때만 쌓인다 — 치는 즉시 보여주면
         * 통화 중인 출제자가 반응해버려 힌트가 샌다.
         */
        history: Array<{ attempt: number; text: string; skipped: boolean; correct: boolean }>;
      }>;
    }
  /** 시도 하나가 끝났다. 답이 동시에 공개된다. */
  | { t: 'attemptResult'; attempt: number; answers: AnswerRow[] }
  /** 라운드 종료. 여기서 처음으로 원본과 섹터 번호가 내려간다. */
  | {
      t: 'roundEnd';
      word: string;
      drawing: Stroke[];
      sliceCount: number;
      /** 섹터 번호 → 그 조각을 처음 받았던 사람. 아무도 못 받았으면 null */
      owners: Array<{ sliceIndex: number; playerId: string | null }>;
      scores: Array<{ playerId: string; delta: number; total: number }>;
      /** 아무도 못 맞혔으면 빈 배열 */
      correct: string[];
      /**
       * 마지막 시도에 다들 뭐라고 적었는가. 결과 화면의 알맹이다.
       *
       * attemptResult에도 같은 내용이 있지만 여기에 한 번 더 싣는다 —
       * 결과 화면에서 새로고침한 사람은 attemptResult를 못 받으므로,
       * 이 메시지 하나만으로 화면이 완성되어야 한다.
       */
      answers: AnswerRow[];
    }
  /**
   * 대기 화면 낙서판. 출제자가 그리는 동안 기다리는 사람들이 같이 갈기는 판이다.
   * 낙서는 제시어·조각과 아무 관련이 없어 전원에게 그대로 보내도 새는 것이 없다.
   */
  | { t: 'doodleStroke'; by: string; points: Point[]; color: string }
  /** 낙서판 전체 — 새로 들어왔거나 누가 자기 낙서를 지웠을 때 한 번에 맞춘다. */
  | { t: 'doodleBoard'; strokes: Array<{ by: string; points: Point[]; color: string }> }
  /** 한 줄이 새로 올라왔다 */
  | { t: 'chat'; line: ChatLine }
  /** 지금까지의 이야기 전부. 들어오거나 돌아온 사람에게 한 번에 보낸다. */
  | { t: 'chatLog'; lines: ChatLine[] }
  | {
      t: 'final';
      ranking: Array<{ playerId: string; name: string; score: number }>;
      /** 이 판에 그려진 그림 전부. 끝나고 모아 보는 화면의 재료다. */
      rounds: RoundRecap[];
    }
  /** 로비에 있는 사람에게. 방이 생기거나 사라지거나 인원이 바뀔 때마다 다시 온다. */
  | { t: 'roomList'; rooms: RoomInfo[] }
  /** 방을 만들었다. 클라이언트는 이 코드로 옮겨간다. */
  | { t: 'roomCreated'; room: string }
  /** 이 방에서 나가라는 뜻. 로비로 돌려보낸다. */
  | { t: 'kicked'; msg: string }
  | { t: 'error'; msg: string };
