// 수정 1: 조각이 액자에 딱 붙어 보이는 문제.
//
// jsdom에는 진짜 캔버스가 없어 렌더링된 픽셀을 셀 수 없다(client.test.ts도 캔버스 컨텍스트를
// 통째로 가짜로 바꿔 그리기 호출을 삼킨다). 대신 drawSlice가 실제로 쓰는 확대 배율 계산을
// computeSliceZoom으로 빼내, 그 산수 자체를 테스트로 고정한다 — 패딩 값을 손대면 여기서
// 바로 깨진다.
import { describe, it, expect } from 'vitest';
import { CANVAS, RADIUS } from '../src/shared/drawing';
import { computeSliceZoom, SLICE_PADDING } from '../src/client/slice-view';

/** 스크린샷으로 오너가 실측한 조건: 8조각, 300x300 비트맵(디바이스 배율 0.3) */
const SLICE_COUNT = 8;
const DEVICE_SCALE = 300 / CANVAS; // el.width(300) / CANVAS(1000)

describe('조각 확대 배율의 여백 산수 (수정 1)', () => {
  it('패딩 값은 0.80이다 — 0.92는 실측 12px/9px로 잘려 보였다', () => {
    expect(SLICE_PADDING).toBe(0.80);
  });

  it('8조각 기준으로 높이가 배율의 병목이다(폭 쪽이 더 넉넉하다)', () => {
    const { zoom, boxW, boxH } = computeSliceZoom(SLICE_COUNT);
    expect(boxH).toBe(RADIUS); // 500
    expect(CANVAS / boxH).toBeLessThan(CANVAS / boxW);
    // zoom = padding * min(CANVAS/boxW, CANVAS/boxH) = 0.80 * (1000/500) = 1.6
    expect(zoom).toBeCloseTo(0.80 * (CANVAS / boxH), 10);
    expect(zoom).toBeCloseTo(1.6, 10);
  });

  it('0.80 패딩이면 1000유닛 캔버스에 위아래 각 100유닛(≈30 device px) 여백이 남는다', () => {
    const { zoom, boxH } = computeSliceZoom(SLICE_COUNT);
    const paintedHeight = boxH * zoom; // 조각이 실제로 차지하는 세로 폭 (1000유닛 좌표계)
    const marginUnits = (CANVAS - paintedHeight) / 2; // 위/아래로 똑같이 나뉜다(박스가 중앙 정렬)

    expect(paintedHeight).toBeCloseTo(800, 10);
    expect(marginUnits).toBeCloseTo(100, 10);

    const marginDevicePx = marginUnits * DEVICE_SCALE;
    expect(marginDevicePx).toBeCloseTo(30, 10);
    // 이전 0.92 패딩(=40유닛=12px)보다 확실히 넓다.
    expect(marginDevicePx).toBeGreaterThan(12);
  });

  it('이전 값(0.92)이었다면 위아래 12px 정도만 남았을 것이다 — 회귀 방지용 대조군', () => {
    const { zoom, boxH } = computeSliceZoom(SLICE_COUNT, 0.92);
    const marginUnits = (CANVAS - boxH * zoom) / 2;
    const marginDevicePx = marginUnits * DEVICE_SCALE;
    expect(marginDevicePx).toBeCloseTo(12, 10);
  });

  it('조각 수가 늘어도(폭이 좁아져도) 높이가 계속 병목이라 배율이 안 바뀐다', () => {
    // sliceCount가 커질수록 half가 작아져 boxW(=2*R*sin(half))는 줄어든다.
    // boxH는 sliceCount와 무관하게 항상 RADIUS라, min(CANVAS/boxW, CANVAS/boxH)는
    // 계속 CANVAS/boxH로 고정된다 — 즉 조각이 가늘어져도 세로 여백 비율은 그대로다.
    const a = computeSliceZoom(8);
    const b = computeSliceZoom(16);
    expect(a.zoom).toBeCloseTo(b.zoom, 10);
  });
});
