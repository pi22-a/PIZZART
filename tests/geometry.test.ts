import { describe, it, expect } from 'vitest';
import { clipHalfPlane, rotate } from '../src/shared/geometry';
import { CENTER, type Point } from '../src/shared/drawing';

const O: Point = [0, 0];
/** +x 방향 직선. 남는 쪽은 cross(dir, p-origin) >= 0 이므로 y > 0 쪽이다. */
const RIGHT: Point = [1, 0];

describe('clipHalfPlane', () => {
  it('완전히 안쪽에 있는 선은 그대로 남는다', () => {
    const out = clipHalfPlane([[0, 10], [10, 20]], O, RIGHT);
    expect(out).toEqual([[[0, 10], [10, 20]]]);
  });

  it('완전히 바깥에 있는 선은 사라진다', () => {
    const out = clipHalfPlane([[0, -10], [10, -20]], O, RIGHT);
    expect(out).toEqual([]);
  });

  it('경계를 넘어가는 선분은 교점에서 잘린다', () => {
    const out = clipHalfPlane([[0, 10], [0, -10]], O, RIGHT);
    expect(out.length).toBe(1);
    expect(out[0][0]).toEqual([0, 10]);
    expect(out[0][1][1]).toBeCloseTo(0);
  });

  it('경계를 두 번 넘나드는 선은 두 조각이 된다', () => {
    // 남는 쪽 → 잘리는 쪽 → 남는 쪽
    const out = clipHalfPlane([[0, 10], [10, -10], [20, 10]], O, RIGHT);
    expect(out.length).toBe(2);
  });

  it('경계 위에 딱 놓인 선은 남긴다', () => {
    const out = clipHalfPlane([[0, 0], [10, 0]], O, RIGHT);
    expect(out).toEqual([[[0, 0], [10, 0]]]);
  });

  it('경계 위 점에서 바깥으로 나가는 선은 조각을 남기지 않는다', () => {
    const out = clipHalfPlane([[0, 0], [0, -10]], O, RIGHT);
    expect(out).toEqual([]);
  });

  it('바깥에서 경계 위 점으로 들어오는 선은 조각을 남기지 않는다', () => {
    const out = clipHalfPlane([[0, -10], [0, 0]], O, RIGHT);
    expect(out).toEqual([]);
  });

  it('점이 하나뿐인 선은 그릴 것이 없으므로 사라진다', () => {
    expect(clipHalfPlane([[0, 10]], O, RIGHT)).toEqual([]);
  });

  it('원점이 아닌 곳을 지나는 직선도 처리한다', () => {
    const out = clipHalfPlane([[0, 110], [0, 90]], [0, 100], RIGHT);
    expect(out.length).toBe(1);
    expect(out[0][1][1]).toBeCloseTo(100);
  });
});

describe('rotate', () => {
  it('중심에 있는 점은 움직이지 않는다', () => {
    const out = rotate([CENTER], CENTER, Math.PI / 3);
    expect(out[0][0]).toBeCloseTo(500);
    expect(out[0][1]).toBeCloseTo(500);
  });

  it('90도 돌리면 오른쪽이 아래로 간다 (y가 아래로 자라는 화면 좌표계)', () => {
    const out = rotate([[600, 500]], CENTER, Math.PI / 2);
    expect(out[0][0]).toBeCloseTo(500);
    expect(out[0][1]).toBeCloseTo(600);
  });

  it('역회전하면 원본으로 돌아온다', () => {
    const src: Point[] = [[123, 456], [789, 111], [500, 999]];
    const back = rotate(rotate(src, CENTER, 1.234), CENTER, -1.234);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(src[i][0]);
      expect(p[1]).toBeCloseTo(src[i][1]);
    });
  });
});
