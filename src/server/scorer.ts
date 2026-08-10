/** 시도 회차가 늦을수록 낮다. 표를 벗어나면 0점 — 판을 멈추지 않는다. */
export function guesserPoints(attempt: number, table: number[]): number {
  return table[attempt - 1] ?? 0;
}

/**
 * 출제자는 맞힌 사람 1명당 점수를 받는다. 알아볼 수 있게 그릴 이유가 생긴다.
 *
 * Dixit식(전원이 맞혀도 0점)도 검토했으나 채택하지 않았다. 정확 일치라
 * 이미 충분히 어려워서 출제자가 대부분 0점이 된다.
 */
export function drawerPoints(correctCount: number, perCorrect: number): number {
  return correctCount * perCorrect;
}
