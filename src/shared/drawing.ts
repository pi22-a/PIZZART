export type Point = [number, number];

/** 정규화 좌표계는 0~1000 정사각형이다. 화면 크기가 달라도 같은 그림이 되고 용량도 준다. */
export const CANVAS = 1000;
export const CENTER: Point = [500, 500];
export const RADIUS = 500;

/** 그림은 폴리라인의 모음이다. 마우스에서 나오므로 곡선 타입은 필요 없다. */
export type Drawing = Point[][];

export function insideCircle(p: Point): boolean {
  const dx = p[0] - CENTER[0];
  const dy = p[1] - CENTER[1];
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}
