import { describe, it, expect } from 'vitest';
import { slice, sliceCount } from '../src/shared/slicer';
import { CENTER } from '../src/shared/drawing';
import type { Point } from '../src/shared/drawing';

/** 중심에서 각도 a 방향으로 길이 200 뻗은 선. y는 아래로 자란다. */
function ray(a: number): Point[] {
  return [
    [CENTER[0] + Math.cos(a) * 20, CENTER[1] + Math.sin(a) * 20],
    [CENTER[0] + Math.cos(a) * 200, CENTER[1] + Math.sin(a) * 200],
  ];
}

const DEG = Math.PI / 180;

describe('sliceCount', () => {
  it('맞히는 사람이 적으면 최솟값을 쓴다', () => {
    expect(sliceCount(3, 8)).toBe(8);
  });

  it('맞히는 사람이 최솟값보다 많으면 인원에 맞춘다 — 1인 1조각을 보장한다', () => {
    expect(sliceCount(11, 8)).toBe(11);
  });
});

describe('slice', () => {
  it('요청한 개수만큼 조각이 나온다', () => {
    expect(slice([ray(45 * DEG)], 8).length).toBe(8);
  });

  it('한 섹터 안에만 있는 선은 그 조각에만 들어간다', () => {
    // 4등분이면 섹터 0은 [0°, 90°). 45°는 그 한가운데다.
    const out = slice([ray(45 * DEG)], 4);
    expect(out[0].strokes.length).toBe(1);
    expect(out[1].strokes.length).toBe(0);
    expect(out[2].strokes.length).toBe(0);
    expect(out[3].strokes.length).toBe(0);
  });

  it('여러 섹터를 가로지르는 선은 나뉜다', () => {
    // 왼쪽 끝에서 오른쪽 끝까지 지름을 가로지르는 선
    const across: Point[] = [[100, 500], [900, 500]];
    const out = slice([across], 4);
    const withInk = out.filter((s) => s.strokes.length > 0);
    expect(withInk.length).toBeGreaterThanOrEqual(2);
  });

  it('모든 조각이 위를 향하게 회전되어 있다', () => {
    // 어느 섹터에 그렸든, 조각 안의 잉크는 중심보다 위(y < 500)에 있어야 한다
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) * 45 * DEG;
      const out = slice([ray(a)], 8);
      const mine = out[i].strokes;
      expect(mine.length).toBe(1);
      for (const p of mine[0]) {
        expect(p[1]).toBeLessThan(CENTER[1]);
      }
    }
  });

  it('회전해도 중심으로부터의 거리는 보존된다', () => {
    const out = slice([ray(200 * DEG)], 8);
    const mine = out.find((s) => s.strokes.length > 0)!.strokes[0];
    const far = mine[mine.length - 1];
    const d = Math.hypot(far[0] - CENTER[0], far[1] - CENTER[1]);
    expect(d).toBeCloseTo(200, 5);
  });

  it('빈 그림이면 모든 조각이 비어 있다', () => {
    const out = slice([], 8);
    expect(out.every((s) => s.strokes.length === 0)).toBe(true);
  });
});
