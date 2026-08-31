import type { Point } from './drawing';

/**
 * 지우개 반지름. 획 굵기 8의 두 배쯤이라 손이 조금 떨려도 물린다.
 *
 * 예전에는 이 값이 "어느 획을 물었나"를 고르는 판정 거리였다(획 지우개). 지금은
 * 실제로 지워지는 크기다 — 이름은 같아도 뜻이 다르다.
 */
export const ERASE_RADIUS = 18;

/** 낙서판 지우개. 선이 굵어서(10) 게임 캔버스보다 넉넉하게 잡는다. */
export const DOODLE_ERASE_RADIUS = 26;

/**
 * 지우개가 한 번에 훑을 수 있는 최대 거리.
 *
 * 포인터가 창 밖으로 나갔다 돌아오거나 프레임이 크게 밀리면 좌표가 껑충 뛰는데,
 * 그 둘을 이어 지우면 지나지도 않은 자리가 통째로 쓸려나간다.
 */
export const MAX_ERASE_STEP = 200;

/** 점에서 선분까지의 거리. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  // 길이 0인 선분(같은 점 두 개)은 점까지의 거리로 친다
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const dx = p[0] - (a[0] + vx * t);
  const dy = p[1] - (a[1] + vy * t);
  return Math.hypot(dx, dy);
}

/**
 * 캡슐(선분 ab를 반지름 radius로 부풀린 영역) **바깥**만 남긴다.
 *
 * `geometry.ts`의 `clipHalfPlane`과 같은 모양의 함수다. 다르게 푸는 부분은 경계를
 * 넘는 자리를 찾는 방법뿐이다 — 반평면은 경계가 직선 하나라 t가 바로 나오지만,
 * 캡슐은 경계가 원호 둘과 직선 둘이라 넷을 다 풀어 후보를 모은다. 그 뒤 구간마다
 * 가운뎃점이 안인지 밖인지를 직접 재서 정한다. 경계 조각을 하나씩 따로 다루는 것보다
 * 짧고, 접하는 경우처럼 애매한 자리에서 안 깨진다.
 *
 * **원이 아니라 캡슐인 이유:** 포인터 이벤트가 오는 자리마다 원으로만 지우면 빨리
 * 문질렀을 때 샘플 사이가 안 지워져 얼룩이 남는다. 지나온 자리를 선분으로 이어야 한다.
 */
export function clipOutsideCapsule(points: Point[], a: Point, b: Point, radius: number): Point[][] {
  const pieces: Point[][] = [];
  let cur: Point[] = [];

  const flush = () => {
    // clipHalfPlane과 같은 규칙 — 서로 다른 좌표가 하나라도 있어야 실제 조각으로 친다
    const hasDistinctPoint = cur.some((p) => p[0] !== cur[0][0] || p[1] !== cur[0][1]);
    if (cur.length >= 2 && hasDistinctPoint) pieces.push(cur);
    cur = [];
  };

  const push = (q0: Point, q1: Point) => {
    const last = cur[cur.length - 1];
    if (cur.length === 0) cur.push(q0);
    else if (last[0] !== q0[0] || last[1] !== q0[1]) { flush(); cur.push(q0); }
    cur.push(q1);
  };

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];

    // 지우개 근처에도 안 가는 선분은 통째로 남긴다. 대부분의 획이 여기서 빠져나간다 —
    // 지우개는 포인터가 움직일 때마다 도는데 그때마다 그림 전체의 교차를 푸는 것은 낭비다.
    if (farFromCapsule(p0, p1, a, b, radius)) {
      push(p0, p1);
      continue;
    }

    const ts = [0, 1, ...crossings(p0, p1, a, b, radius)].sort((x, y) => x - y);

    // 이 선분에서 지우개 바깥으로 남는 구간들. 맞닿은 것은 합쳐서 내보낸다.
    const keep: Array<[number, number]> = [];

    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1];
      const t1 = ts[k];
      if (t1 - t0 <= 1e-12) continue;

      if (distToSegment(lerp(p0, p1, (t0 + t1) / 2), a, b) <= radius) continue; // 지우개 안

      // 앞 구간과 맞닿아 있으면 이어 붙인다. 안 그러면 지우개 옆면의 무한 직선이
      // 멀리 있는 획을 스칠 때마다 그 자리에 점이 하나씩 는다.
      const prev = keep[keep.length - 1];
      if (prev && prev[1] === t0) prev[1] = t1;
      else keep.push([t0, t1]);
    }

    if (keep.length === 0) { flush(); continue; }

    for (const [t0, t1] of keep) push(at(p0, p1, t0), at(p0, p1, t1));

    // 선분 끝이 지워졌으면 다음 선분과 이어지지 않는다
    if (keep[keep.length - 1][1] < 1) flush();
  }

  flush();
  return pieces;
}

/**
 * 그림에 지우개를 한 번 문지른다. 지나간 자리의 잉크가 사라지고, 획은 남은 토막으로 쪼개진다.
 *
 * 아무것도 안 지워졌으면 **null**을 준다 — 부르는 쪽이 헛일(다시 그리기, 다시 자르기,
 * 판 다시 보내기)을 건너뛰는 데 쓴다. 포인터가 움직이는 대부분의 순간은 아무것도 안 문다.
 *
 * `erasable`을 주면 그 검사를 통과한 획만 지운다. 낙서판이 "내가 그은 것만"에 쓴다.
 */
export function eraseStrokes<T extends { points: Point[] }>(
  strokes: readonly T[],
  from: Point,
  to: Point,
  radius: number,
  erasable?: (s: T) => boolean,
): T[] | null {
  const out: T[] = [];
  let changed = false;

  for (const s of strokes) {
    if (erasable && !erasable(s)) { out.push(s); continue; }

    const kept = clipOutsideCapsule(s.points, from, to, radius);

    // 손도 안 댄 획이면 원본을 그대로 넘긴다. 토막 개수만 보면 안 된다 — 획 끝만 조금
    // 깎인 경우도 토막 하나에 점 개수가 그대로라, 좌표까지 대봐야 알 수 있다.
    if (kept.length === 1 && samePoints(kept[0], s.points)) { out.push(s); continue; }

    changed = true;
    // 색은 토막마다 따라간다. 낙서판의 by 같은 다른 값도 같이 실려 간다.
    for (const piece of kept) out.push({ ...s, points: piece });
  }

  return changed ? out : null;
}

/**
 * 선분이 캡슐 근처에도 없는가. 두 선분의 감싸는 상자만 대보는 헐거운 검사다 —
 * 놓치는 쪽(가깝다고 잘못 보는 쪽)으로만 틀리므로 결과는 안 바뀌고 속도만 얻는다.
 */
function farFromCapsule(p0: Point, p1: Point, a: Point, b: Point, radius: number): boolean {
  return (
    Math.max(p0[0], p1[0]) < Math.min(a[0], b[0]) - radius ||
    Math.min(p0[0], p1[0]) > Math.max(a[0], b[0]) + radius ||
    Math.max(p0[1], p1[1]) < Math.min(a[1], b[1]) - radius ||
    Math.min(p0[1], p1[1]) > Math.max(a[1], b[1]) + radius
  );
}

/**
 * 선분 p0→p1이 캡슐 경계를 지나는 t를 전부 모은다. 경계는 양 끝 원 둘과 옆면 직선 둘이다.
 * 진짜 경계인지는 부르는 쪽에서 가운뎃점으로 다시 재므로 넉넉하게 담아도 된다.
 */
function crossings(p0: Point, p1: Point, a: Point, b: Point, radius: number): number[] {
  const ts: number[] = [];
  circleCrossings(p0, p1, a, radius, ts);

  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abLen2 = abx * abx + aby * aby;

  // 길이 0이면 캡슐이 아니라 원 하나다. 옆면도 반대쪽 원도 없다.
  if (abLen2 <= 1e-18) return ts;

  circleCrossings(p0, p1, b, radius, ts);

  const abLen = Math.sqrt(abLen2);
  const nx = -aby / abLen;
  const ny = abx / abLen;

  lineCrossing(p0, p1, [a[0] + nx * radius, a[1] + ny * radius], abx, aby, ts);
  lineCrossing(p0, p1, [a[0] - nx * radius, a[1] - ny * radius], abx, aby, ts);
  return ts;
}

function circleCrossings(p0: Point, p1: Point, c: Point, radius: number, ts: number[]): void {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const A = dx * dx + dy * dy;
  if (A <= 1e-18) return;

  const fx = p0[0] - c[0];
  const fy = p0[1] - c[1];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radius * radius;

  const disc = B * B - 4 * A * C;
  if (disc < 0) return;

  const root = Math.sqrt(disc);
  addIfInside(ts, (-B - root) / (2 * A));
  addIfInside(ts, (-B + root) / (2 * A));
}

/** 선분 p0→p1 과 (q를 지나 방향 (ux,uy)로 뻗은) 무한 직선이 만나는 t. */
function lineCrossing(p0: Point, p1: Point, q: Point, ux: number, uy: number, ts: number[]): void {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];

  const denom = ux * dy - uy * dx;
  if (Math.abs(denom) <= 1e-18) return; // 나란하다

  addIfInside(ts, (uy * (p0[0] - q[0]) - ux * (p0[1] - q[1])) / denom);
}

function addIfInside(ts: number[], t: number): void {
  if (t > 0 && t < 1) ts.push(t);
}

/**
 * t가 0이나 1이면 lerp를 태우지 않고 원래 점을 그대로 쓴다.
 * lerp(p0, p1, 1)은 p1과 정확히 같지 않아서(0.1 + 0.2 !== 0.3), 태우면 안 지워진 획도
 * 문지를 때마다 좌표가 조금씩 떠내려간다.
 */
function at(p0: Point, p1: Point, t: number): Point {
  if (t <= 0) return p0;
  if (t >= 1) return p1;
  return lerp(p0, p1, t);
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function samePoints(x: Point[], y: Point[]): boolean {
  return x.length === y.length && x.every((p, i) => p[0] === y[i][0] && p[1] === y[i][1]);
}
