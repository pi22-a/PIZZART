export type Point = [number, number];

/** 정규화 좌표계는 0~1000 정사각형이다. 화면 크기가 달라도 같은 그림이 되고 용량도 준다. */
export const CANVAS = 1000;
export const CENTER: Point = [500, 500];
export const RADIUS = 500;

/** 그림은 폴리라인의 모음이다. 마우스에서 나오므로 곡선 타입은 필요 없다. */
export type Drawing = Point[][];

/**
 * 대기 화면 낙서판의 좌표계. 출제자가 그리는 원형 캔버스와 완전히 별개다.
 *
 * 여럿이 동시에 갈겨도 자리가 남아야 해서 가로로 넓게 잡았다.
 * 이 좌표는 게임 판정에 쓰이지 않는다 — 낙서는 점수와 아무 관련이 없다.
 */
export const DOODLE_W = 2400;
export const DOODLE_H = 1200;

export function insideDoodle(p: Point): boolean {
  return p[0] >= 0 && p[0] <= DOODLE_W && p[1] >= 0 && p[1] <= DOODLE_H;
}

export function insideCircle(p: Point): boolean {
  const dx = p[0] - CENTER[0];
  const dy = p[1] - CENTER[1];
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}
