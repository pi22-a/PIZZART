import { describe, it, expect } from 'vitest';
import { guesserPoints, drawerPoints } from '../src/server/scorer';

const TABLE = [3, 2, 1];

describe('guesserPoints', () => {
  it('빨리 맞힐수록 높다', () => {
    expect(guesserPoints(1, TABLE)).toBe(3);
    expect(guesserPoints(2, TABLE)).toBe(2);
    expect(guesserPoints(3, TABLE)).toBe(1);
  });

  it('표를 벗어난 시도는 0점이다 — 판이 멈추는 것보다 낫다', () => {
    expect(guesserPoints(4, TABLE)).toBe(0);
    expect(guesserPoints(0, TABLE)).toBe(0);
  });
});

describe('drawerPoints', () => {
  it('맞힌 사람 수만큼 받는다', () => {
    expect(drawerPoints(2, 1)).toBe(2);
  });

  it('아무도 못 맞히면 0점이다', () => {
    expect(drawerPoints(0, 1)).toBe(0);
  });
});
