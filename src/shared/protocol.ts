import type { Point } from './drawing';

export type Phase = 'lobby' | 'drawing' | 'guessing' | 'roundEnd' | 'final';

export interface PlayerInfo {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  isDrawer: boolean;
  /** 이번 시도에 답을 적어두었는가 (내용은 공개 전까지 안 나간다) */
  answered: boolean;
  /** 이번 회차에 힌트를 받았는가 */
  skipped: boolean;
  /** 이미 맞혀서 점수가 확정됐는가 */
  solved: boolean;
  /** 지금 몇 조각을 들고 있는가 */
  sliceCount: number;
  /** 지금 맞히면 받을 점수. 이미 맞혔으면 확정된 점수 */
  pendingScore: number;
}

export type ClientMsg =
  /** cid는 브라우저가 sessionStorage에 들고 다니는 식별자다. 새로고침해도 같은 자리로 돌아온다. */
  | { t: 'join'; name: string; cid: string }
  | { t: 'start' }
  | { t: 'stroke'; points: Point[] }
  | { t: 'undo' }
  | { t: 'drawDone' }
  | { t: 'answer'; text: string }
  | { t: 'skip' }
  | { t: 'next' }
  /** 최종 화면에서 한 판 더. 방장만이 아니라 누구나 누를 수 있다 — 한 사람 뒤에 방이 갇히면 안 된다. */
  | { t: 'again' };

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
      /** 게임을 시작하는 데 필요한 최소 인원 */
      minPlayers: number;
    }
  /** 제시어. 출제자에게만 간다. */
  | { t: 'word'; word: string }
  /** 출제자가 새로고침했을 때 자기 그림을 되찾는다. 출제자에게만 간다. */
  | { t: 'canvas'; strokes: Point[][] }
  /**
   * 내가 볼 수 있는 조각 전부 — 처음 받은 것 + 힌트로 받은 것. 전부 나만의 것이다.
   * 이미 회전되어 있고, id는 섹터 번호와 무관한 불투명 값이다.
   * 번호가 새면 "내 건 3시 방향"이 되고 게임이 그 자리에서 무너진다.
   *
   * count는 전체 조각 수다. 부채꼴을 몇 도로 그릴지에 필요하고,
   * 몇 조각으로 잘렸는지는 알아도 내 것이 어디였는지는 알 수 없으므로 새어도 무해하다.
   */
  | { t: 'slices'; count: number; slices: Array<{ id: string; strokes: Point[][]; shared: boolean }> }
  /**
   * 마지막 회차의 조립판. 지금까지 본 조각을 회전을 풀어 제자리에 끼워 보여준다.
   * 이 게임의 핵심 장치인 회전을 마지막에 풀어주는 자비이자 마지막 기회다.
   * 여기서 맞히면 점수는 1점 고정이라, 방향을 알려줘도 판이 무너지지 않는다.
   */
  | { t: 'assembled'; sliceCount: number; pieces: Array<{ index: number; strokes: Point[][] }> }
  /**
   * 이미 답을 아는 사람에게만 — 출제자와, 먼저 맞혀서 점수가 확정된 사람.
   * 지금 남들에게 어떤 조각이 나가 있는지 보여준다. 정답을 아는 사람들이라 원본을 실어도
   * 새는 것이 없고, 할 일이 없어진 그 시간이 남을 지켜보는 시간이 된다.
   */
  | { t: 'board'; sliceCount: number; drawing: Point[][]; visible: number[] }
  /** 시도 하나가 끝났다. 답이 동시에 공개된다. */
  | { t: 'attemptResult'; attempt: number; answers: AnswerRow[] }
  /** 라운드 종료. 여기서 처음으로 원본과 섹터 번호가 내려간다. */
  | {
      t: 'roundEnd';
      word: string;
      drawing: Point[][];
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
  | { t: 'final'; ranking: Array<{ playerId: string; name: string; score: number }> }
  | { t: 'error'; msg: string };
