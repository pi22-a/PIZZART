import { describe, it, expect } from 'vitest';
import { planHint } from '../src/server/hint';

const first = () => 0;
const all = [0, 1, 2, 3];

describe('planHint', () => {
  it('숨은 조각이 있으면 하나를 전원에게 공개한다', () => {
    const seen = new Map([['a', new Set([0])], ['b', new Set([1])]]);
    const plan = planHint([2, 3], seen, all, first);
    expect(plan.publicSlice).toBe(2);
    expect(plan.perPlayer).toEqual([]);
  });

  it('숨은 조각이 없으면 각자에게 남의 조각을 하나씩 준다', () => {
    const seen = new Map([['a', new Set([0])], ['b', new Set([1])]]);
    const plan = planHint([], seen, [0, 1], first);
    expect(plan.publicSlice).toBe(null);
    expect(plan.perPlayer).toEqual([
      { playerId: 'a', sliceIndex: 1 },
      { playerId: 'b', sliceIndex: 0 },
    ]);
  });

  it('이미 본 조각은 다시 주지 않는다', () => {
    const seen = new Map([['a', new Set([0, 1, 2])]]);
    const plan = planHint([], seen, all, first);
    expect(plan.perPlayer).toEqual([{ playerId: 'a', sliceIndex: 3 }]);
  });

  it('줄 것이 없는 사람은 건너뛴다 — 판은 멈추지 않는다', () => {
    const seen = new Map([['a', new Set([0, 1, 2, 3])], ['b', new Set([0])]]);
    const plan = planHint([], seen, all, first);
    expect(plan.perPlayer).toEqual([{ playerId: 'b', sliceIndex: 1 }]);
  });

  it('아무에게도 줄 것이 없으면 빈 계획을 낸다', () => {
    const seen = new Map([['a', new Set(all)]]);
    const plan = planHint([], seen, all, first);
    expect(plan).toEqual({ publicSlice: null, perPlayer: [] });
  });

  it('무작위 선택기를 그대로 따른다', () => {
    const seen = new Map([['a', new Set([0])]]);
    const plan = planHint([1, 2, 3], seen, all, (n) => n - 1);
    expect(plan.publicSlice).toBe(3);
  });
});
