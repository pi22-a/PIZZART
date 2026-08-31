import { describe, it, expect } from 'vitest';
import { clipOutsideCapsule, eraseStrokes, distToSegment } from '../src/shared/eraser';
import { slice } from '../src/shared/slicer';
import type { Point, Stroke } from '../src/shared/drawing';

const line = (...xy: number[]): Point[] => {
  const pts: Point[] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
  return pts;
};

describe('clipOutsideCapsule', () => {
  it('멀리 떨어진 획은 손도 안 댄다', () => {
    const out = clipOutsideCapsule(line(100, 100, 200, 100), [800, 800], [900, 800], 18);
    expect(out).toEqual([line(100, 100, 200, 100)]);
  });

  it('안 지워진 획은 좌표가 한 톨도 안 바뀐다', () => {
    // at()이 양 끝에서 lerp를 안 태우는 이유다. 태우면 문지를 때마다 좌표가 조금씩
    // 떠내려가고, 백 번 문지르면 그림이 미묘하게 어긋난다.
    const src = line(123.456, 789.012, 321.654, 987.321, 555.111, 222.999);
    const out = clipOutsideCapsule(src, [10, 10], [20, 20], 5);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(src);
  });

  it('통째로 덮인 획은 사라진다', () => {
    expect(clipOutsideCapsule(line(500, 500, 520, 500), [480, 500], [540, 500], 50)).toEqual([]);
  });

  it('한가운데를 지우면 두 토막이 된다', () => {
    // 부분 지우개의 알맹이 — 획이 통째로 사라지지 않고 지나간 자리만 끊긴다
    const out = clipOutsideCapsule(line(100, 500, 900, 500), [500, 500], [500, 500], 50);
    expect(out.length).toBe(2);
    expect(out[0][0][0]).toBeCloseTo(100);
    expect(out[0][out[0].length - 1][0]).toBeCloseTo(450);
    expect(out[1][0][0]).toBeCloseTo(550);
    expect(out[1][out[1].length - 1][0]).toBeCloseTo(900);
  });

  it('캡슐의 옆면을 지나는 획도 정확히 잘린다', () => {
    // 지우개를 (400,500)→(600,500)으로 문지르면 x가 400~600인 구간에서 y 450~550이
    // 지워진다. x=500인 세로선은 그 **옆면**(평평한 변)으로 들어갔다 나온다 — 양 끝 원에는
    // 닿지도 않는다(거리가 100이라 반지름 50 밖이다). 옆면 직선 교차를 안 풀면 이 획은
    // 하나도 안 잘린 채로 남는다.
    const out = clipOutsideCapsule(line(500, 300, 500, 700), [400, 500], [600, 500], 50);
    expect(out.length).toBe(2);
    expect(out[0][out[0].length - 1][1]).toBeCloseTo(450);
    expect(out[1][0][1]).toBeCloseTo(550);
  });

  it('빨리 문질러도 사이가 안 남는다', () => {
    // 원으로만 찍어 지우면 샘플 사이에 안 지워진 얼룩이 남는다. 캡슐로 지우므로
    // (200,500)에서 (800,500)까지 한 번에 그은 것과 같아야 한다.
    const out = clipOutsideCapsule(line(100, 500, 900, 500), [200, 500], [800, 500], 30);
    expect(out.length).toBe(2);
    expect(out[0][out[0].length - 1][0]).toBeCloseTo(170);
    expect(out[1][0][0]).toBeCloseTo(830);
  });

  it('획이 지우개를 들락날락하면 남은 점은 전부 지우개 밖이다', () => {
    const zigzag = line(100, 400, 300, 600, 500, 400, 700, 600);
    const out = clipOutsideCapsule(zigzag, [0, 500], [1000, 500], 20);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      for (const p of piece) {
        expect(distToSegment(p, [0, 500], [1000, 500])).toBeGreaterThanOrEqual(20 - 1e-6);
      }
    }
  });
});

describe('eraseStrokes', () => {
  it('색은 토막마다 따라간다', () => {
    const strokes: Stroke[] = [
      { points: line(100, 500, 900, 500), color: '#e03131' },
      { points: line(100, 100, 200, 100), color: '#1971c2' },
    ];
    const after = eraseStrokes(strokes, [500, 500], [500, 500], 50)!;
    expect(after.map((s) => s.color)).toEqual(['#e03131', '#e03131', '#1971c2']);
  });

  it('아무것도 안 지워지면 null이다', () => {
    // 부르는 쪽이 헛일(다시 그리기, 판 다시 보내기)을 건너뛰는 데 쓴다
    const strokes: Stroke[] = [{ points: line(100, 100, 200, 100), color: '#1971c2' }];
    expect(eraseStrokes(strokes, [800, 800], [820, 800], 18)).toBe(null);
  });

  it('erasable을 주면 그 획만 지운다', () => {
    // 낙서판이 "내가 그은 것만"에 쓰는 길이다
    const strokes = [
      { by: 'me', points: line(100, 500, 900, 500) },
      { by: 'you', points: line(100, 500, 900, 500) },
    ];
    const after = eraseStrokes(strokes, [500, 500], [500, 500], 50, (s) => s.by === 'me')!;
    expect(after.filter((s) => s.by === 'me').length).toBe(2);
    expect(after.filter((s) => s.by === 'you').length).toBe(1);
    // 남의 획은 객체까지 그대로여야 한다 — 새로 만들면 쓸데없이 판이 흔들린다
    expect(after.find((s) => s.by === 'you')).toBe(strokes[1]);
  });

  it('지운 뒤에도 자르기가 멀쩡히 돈다', () => {
    // 지우개가 만든 토막들이 slicer로 그대로 넘어가야 한다. 두 층이 만나는 자리다.
    const strokes: Stroke[] = [{ points: line(100, 500, 900, 500), color: '#1f1b17' }];
    const after = eraseStrokes(strokes, [500, 500], [500, 500], 50)!;
    const slices = slice(after, 8);
    expect(slices.length).toBe(8);
    expect(slices.reduce((n, s) => n + s.strokes.length, 0)).toBeGreaterThan(0);
  });
});
