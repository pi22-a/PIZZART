import type { Drawing, Point } from './drawing';
import { CENTER } from './drawing';
import { clipHalfPlane, rotate } from './geometry';

export interface Slice {
  index: number;
  /**
   * 이미 회전되어 있다. 꼭짓점은 CENTER에 있고 부채꼴은 위로 뻗는다.
   * 어느 섹터에서 나왔는지는 좌표만 봐서는 알 수 없다 — 그게 이 게임의 핵심이다.
   */
  strokes: Point[][];
}

/** 항상 1인 1조각을 보장한다. 사람이 최솟값보다 많으면 조각을 그만큼 늘린다. */
export function sliceCount(guesserCount: number, min: number): number {
  return Math.max(min, guesserCount);
}

/**
 * 원형 그림을 부채꼴 count개로 자르고, 각 조각을 둥근 쪽이 위로 오게 돌린다.
 *
 * 섹터 i는 각도 [2πi/count, 2π(i+1)/count).
 * 부채꼴 = 중심을 지나는 반평면 두 개의 교집합이며, 섹터 각도가 180° 미만이어야 성립한다.
 * count는 항상 8 이상이므로(sliceCount 참조) 걱정할 일이 없다.
 *
 * 경계에 정확히 놓인 잉크는 양쪽 조각에 다 들어간다. 머리카락 한 올 너비의
 * 중복이라 눈에 띄지 않고, 빠뜨리는 것보다 낫다.
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

    const strokes: Point[][] = [];
    for (const stroke of drawing) {
      for (const afterStart of clipHalfPlane(stroke, CENTER, d0)) {
        for (const inSector of clipHalfPlane(afterStart, CENTER, d1)) {
          strokes.push(rotate(inSector, CENTER, spin));
        }
      }
    }
    out.push({ index: i, strokes });
  }
  return out;
}
