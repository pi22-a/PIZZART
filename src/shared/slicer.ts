import type { Drawing, Point, Stroke } from './drawing';
import { CENTER } from './drawing';
import { clipHalfPlane, rotate } from './geometry';

export interface Slice {
  index: number;
  /**
   * 이미 회전되어 있다. 꼭짓점은 CENTER에 있고 부채꼴은 위로 뻗는다.
   * 어느 섹터에서 나왔는지는 좌표만 봐서는 알 수 없다 — 그게 이 게임의 핵심이다.
   */
  strokes: Stroke[];
}

/**
 * 항상 1인 1조각을 보장한다. 사람이 최솟값보다 많으면 조각을 그만큼 늘린다.
 * 3 미만으로는 절대 내려가지 않는다 — slice()의 반평면 두 개 교집합 방식은
 * 섹터 각도가 180° 미만이어야 성립하는데, count가 3 미만이면 그 조건이 깨진다.
 */
export function sliceCount(guesserCount: number, min: number): number {
  return Math.max(3, min, guesserCount);
}

/**
 * 원형 그림을 부채꼴 count개로 자르고, 각 조각을 둥근 쪽이 위로 오게 돌린다.
 *
 * 섹터 i는 각도 [2πi/count, 2π(i+1)/count).
 * 부채꼴 = 중심을 지나는 반평면 두 개의 교집합이며, 섹터 각도가 180° 미만이어야,
 * 즉 count >= 3이어야 성립한다. 최소 인원이 3명이면 맞히는 사람은 2명까지 내려가지만,
 * sliceCount가 3 미만으로 내려가지 않게 바닥을 깔아두므로(sliceCount 참조) 이 함수에
 * 넘어오는 count는 사람이 아무리 적어도, min이 아무리 낮게 설정돼도 항상 3 이상이다.
 *
 * 경계에 정확히 놓인 잉크는 인접한 두 조각 중 적어도 하나에 들어가고, 절대
 * 사라지지 않는다. Math.cos/Math.sin의 부동소수점 오차로 정확히 어느 조각에
 * 들어갈지는 예측 불가능하지만, 항상 한쪽 이상에는 남는다.
 */
export function slice(drawing: Drawing, count: number): Slice[] {
  const step = (Math.PI * 2) / count;
  const out: Slice[] = [];

  for (let i = 0; i < count; i++) {
    const a0 = i * step;
    const a1 = (i + 1) * step;

    // 시작 경계는 왼쪽을 남기고, 끝 경계는 오른쪽을 남긴다.
    // 끝 경계는 방향을 뒤집어 같은 함수를 그대로 쓴다.
    const d0: Point = [Math.cos(a0), Math.sin(a0)];
    const d1: Point = [-Math.cos(a1), -Math.sin(a1)];

    // 이등분선이 화면 위쪽(-90°)을 향하도록 돌린다
    const spin = -Math.PI / 2 - (a0 + a1) / 2;

    // 색은 토막마다 따라간다. 획 하나가 여러 토막으로 쪼개져도 원래 색을 잃지 않는다.
    const strokes: Stroke[] = [];
    for (const stroke of drawing) {
      for (const afterStart of clipHalfPlane(stroke.points, CENTER, d0)) {
        for (const inSector of clipHalfPlane(afterStart, CENTER, d1)) {
          strokes.push({ points: rotate(inSector, CENTER, spin), color: stroke.color });
        }
      }
    }
    out.push({ index: i, strokes });
  }
  return out;
}
