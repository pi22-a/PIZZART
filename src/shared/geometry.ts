import type { Point } from './drawing';

/**
 * 폴리라인을 반평면으로 자른다.
 *
 * 남기는 쪽은 origin을 지나 dir 방향으로 뻗은 직선의 왼쪽,
 * 즉 `cross(dir, p - origin) >= 0` 인 쪽이다.
 * 직선을 넘나드는 선분은 교점에서 정확히 잘리고, 여러 번 넘나들면 여러 조각이 나온다.
 *
 * 부채꼴은 중심을 지나는 반평면 두 개의 교집합이다(섹터 각도가 180° 미만일 때).
 * 그래서 이 함수 하나를 두 번 걸면 조각이 나온다.
 */
export function clipHalfPlane(points: Point[], origin: Point, dir: Point): Point[][] {
  const side = (p: Point) => dir[0] * (p[1] - origin[1]) - dir[1] * (p[0] - origin[0]);

  const pieces: Point[][] = [];
  let cur: Point[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const sa = side(a);
    const sb = side(b);
    const inA = sa >= 0;
    const inB = sb >= 0;

    if (inA && inB) {
      if (cur.length === 0) cur.push(a);
      cur.push(b);
    } else if (inA) {
      // 나간다 — 교점까지만 남기고 끊는다
      if (cur.length === 0) cur.push(a);
      cur.push(lerp(a, b, sa / (sa - sb)));
      flush();
    } else if (inB) {
      // 들어온다 — 교점부터 새로 시작한다
      flush();
      cur.push(lerp(a, b, sa / (sa - sb)));
      cur.push(b);
    } else {
      flush();
    }
  }
  flush();
  return pieces;
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** center를 중심으로 angle(라디안)만큼 돌린다. */
export function rotate(points: Point[], center: Point, angle: number): Point[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return points.map(([x, y]) => {
    const dx = x - center[0];
    const dy = y - center[1];
    return [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c] as Point;
  });
}
