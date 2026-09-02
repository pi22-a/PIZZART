import { describe, it, expect } from 'vitest';
import { slice, sliceCount } from '../src/shared/slicer';
import { CENTER } from '../src/shared/drawing';
import type { Point, Stroke } from '../src/shared/drawing';

/** 중심에서 각도 a 방향으로 길이 200 뻗은 선. y는 아래로 자란다. */
function ray(a: number, color = '#e03131'): Stroke {
  const points: Point[] = [
    [CENTER[0] + Math.cos(a) * 20, CENTER[1] + Math.sin(a) * 20],
    [CENTER[0] + Math.cos(a) * 200, CENTER[1] + Math.sin(a) * 200],
  ];
  return { points, color };
}

const DEG = Math.PI / 180;

describe('sliceCount', () => {
  it('맞히는 사람이 적으면 최솟값을 쓴다', () => {
    expect(sliceCount(3, 8)).toBe(8);
  });

  it('맞히는 사람이 최솟값보다 많으면 인원에 맞춘다 — 1인 1조각을 보장한다', () => {
    expect(sliceCount(11, 8)).toBe(11);
  });

  it('min과 guesserCount가 둘 다 3 미만이어도 3 밑으로는 내려가지 않는다', () => {
    // slice()의 반평면 두 개 교집합 방식은 섹터 각도가 180° 미만이어야
    // 성립하므로 count는 항상 3 이상이어야 한다. min은 content/rules.json에서
    // 튜닝 가능한 값이라 플레이테스터가 낮출 수 있고, guesserCount도 이론상
    // 작을 수 있으니 이 바닥이 실제로 지켜지는지 확인한다.
    expect(sliceCount(1, 1)).toBe(3);
    expect(sliceCount(2, 2)).toBe(3);
    expect(sliceCount(0, 0)).toBe(3);
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

  it('경계에 걸치지 않는 대각선은 마주보는 두 섹터에만 들어간다', () => {
    // count=4일 때 섹터는 화면 사분면과 같다: 0=우하(x>500,y>500),
    // 1=좌하(x<500,y>500), 2=좌상(x<500,y<500), 3=우상(x>500,y<500).
    // (300,700)은 CENTER 기준 각도 135°로 섹터1(좌하) 안, (700,300)은
    // 각도 315°로 섹터3(우상) 안에 있고 둘 다 섹터 경계(0/90/180/270°)에서
    // 떨어져 있다. 두 점의 중점이 정확히 (500,500)=CENTER라 이 선은
    // 중심을 지나 섹터1→섹터3으로 곧장 넘어가며, 좌상(2)이나 우하(0)로는
    // 전혀 들어가지 않는다.
    const diagonal: Stroke = { points: [[300, 700], [700, 300]], color: '#1f1b17' };
    const out = slice([diagonal], 4);
    const sectorsWithInk = out.filter((s) => s.strokes.length > 0).map((s) => s.index);
    expect(sectorsWithInk).toEqual([1, 3]);
    expect(out[0].strokes.length).toBe(0);
    expect(out[2].strokes.length).toBe(0);
  });

  it('섹터 경계에 정확히 놓인 지름은 실측으로 확인된 두 섹터에만 들어간다', () => {
    // y=500인 수평 지름은 count=4의 섹터 경계(0°/180°)와 정확히 겹친다.
    // clipHalfPlane 자체는 경계를 양쪽 다 포함(>=0)하도록 설계돼 있어
    // "이론상으로는" 인접한 두 섹터 모두에 중복으로 들어가야 한다. 하지만
    // 실제로 돌려보면 Math.cos/Math.sin(90°, 180°, 270°, 360°)이 정확히
    // 0이 아니라 아주 작은 부동소수점 오차(±1e-16 수준)를 남기고, 그 오차의
    // 부호가 두 번째 반평면 클리핑에서 경계 위의 점을 아주 살짝 안쪽/바깥쪽
    // 으로 밀어버린다. 그 결과 이 입력에서는 오른쪽 절반이 섹터0에만,
    // 왼쪽 절반이 섹터2에만 남고 섹터1·3은 퇴화 조각(두 점이 같은 좌표)이
    // 되어 버려진다 — "양쪽 다 중복"이라는 주석의 설계 의도가 부동소수점
    // 앞에서 항상 지켜지지는 않는다는 것을 보여준다. 이 테스트는 그 실측된
    // 동작을 고정해 회귀를 잡는다.
    const across: Stroke = { points: [[100, 500], [900, 500]], color: '#1f1b17' };
    const out = slice([across], 4);
    const sectorsWithInk = out.filter((s) => s.strokes.length > 0).map((s) => s.index);
    expect(sectorsWithInk).toEqual([0, 2]);
    expect(out[1].strokes.length).toBe(0);
    expect(out[3].strokes.length).toBe(0);
  });

  it('모든 조각의 이등분선이 정확히 정중앙 위쪽(수직선)으로 회전되어 있다', () => {
    // 각 섹터의 이등분선 각도로 그은 선이, 회전 후 정확히 CENTER를 지나는
    // 수직선(x == CENTER[0], y < CENTER[1]) 위에 와야 한다. y < 500만 보면
    // "위쪽 어딘가"에 있다는 것만 증명될 뿐, 정확히 -90°로 돌았다는 것은
    // 증명되지 않는다 — 예를 들어 이등분선 대신 섹터 시작각을 기준으로
    // 회전해도(count=8일 때 항상 -67.5°) y < 500은 여전히 성립하지만
    // 모든 조각이 삐뚤어진다. x가 CENTER[0]에 딱 맞아야 각도가 정확히
    // -90°임이 확정된다.
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) * 45 * DEG;
      const out = slice([ray(a)], 8);
      const mine = out[i].strokes;
      expect(mine.length).toBe(1);
      for (const p of mine[0].points) {
        expect(p[1]).toBeLessThan(CENTER[1]);
        expect(p[0]).toBeCloseTo(CENTER[0]);
      }
    }
  });

  it('회전해도 중심으로부터의 거리는 보존된다', () => {
    const out = slice([ray(200 * DEG)], 8);
    const mine = out.find((s) => s.strokes.length > 0)!.strokes[0].points;
    const far = mine[mine.length - 1];
    const d = Math.hypot(far[0] - CENTER[0], far[1] - CENTER[1]);
    expect(d).toBeCloseTo(200, 5);
  });

  it('획의 색은 잘린 토막마다 따라간다', () => {
    // 색을 획 단위로 들고 있으면 클리핑이 쪼갠 토막들이 무슨 색이었는지 잃는다.
    // 경계를 가로지르는 선을 그어 여러 조각으로 쪼갠 뒤에도 색이 남는지 본다.
    const out = slice([ray(0, '#1971c2'), ray(180 * DEG, '#e64980')], 4);
    const seen = out.flatMap((sec) => sec.strokes.map((st) => st.color));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['#1971c2', '#e64980']));
  });

  it('빈 그림이면 모든 조각이 비어 있다', () => {
    const out = slice([], 8);
    expect(out.every((s) => s.strokes.length === 0)).toBe(true);
  });

  it('경계에 놓인 잉크는 사라지지 않는다', () => {
    // 모든 섹터 경계를 테스트한다. 각 경계를 지나는 선을 그어 슬라이싱하면,
    // 해당 경계의 인접한 두 섹터 중 적어도 하나에 잉크가 남아야 한다.
    // 부동소수점 오차로 정확히 어느 섹터에 들어갈지는 예측 불가능하지만,
    // 절대 사라지지 않는다는 것이 핵심 불변식이다.
    const count = 8;
    const step = (Math.PI * 2) / count;

    for (let i = 0; i < count; i++) {
      const boundaryAngle = (i + 1) * step;
      const out = slice([ray(boundaryAngle)], count);

      // 경계 각도의 양쪽 섹터
      const sector1 = i;
      const sector2 = (i + 1) % count;

      // 둘 중 적어도 하나에 잉크가 있어야 함
      const totalInk = out[sector1].strokes.length + out[sector2].strokes.length;
      expect(totalInk).toBeGreaterThan(0);
    }
  });
});
