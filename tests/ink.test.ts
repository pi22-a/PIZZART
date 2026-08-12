// @vitest-environment jsdom
//
// 버그 1 회귀 테스트: 새 <canvas>는 브라우저 기본값 300x150을 갖는다.
// CSS 박스가 150x150이고 dpr이 2면 목표 픽셀 크기가 정확히 300이라, width만 보는
// 가드는 "이미 300이니 할 일 없다"고 착각해 height 150을 그대로 남긴다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fitCanvas } from '../src/client/ink';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fitCanvas는 가로뿐 아니라 세로도 검사한다 (버그 1)', () => {
  it('새 캔버스, CSS 150x150, dpr 2 → 300x300 정사각형이 된다', () => {
    const el = document.createElement('canvas');
    // 새로 만든 캔버스는 브라우저 기본값을 그대로 갖는다 — 버그의 핵심 전제
    expect(el.width).toBe(300);
    expect(el.height).toBe(150);

    Object.defineProperty(el, 'clientWidth', { value: 150, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 150, configurable: true });
    vi.stubGlobal('devicePixelRatio', 2);

    fitCanvas(el);

    expect(el.width).toBe(300);
    expect(el.height).toBe(300);
  });

  it('새 캔버스, CSS 150x150, dpr 1 → 150x150이 된다', () => {
    const el = document.createElement('canvas');
    Object.defineProperty(el, 'clientWidth', { value: 150, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 150, configurable: true });
    vi.stubGlobal('devicePixelRatio', 1);

    fitCanvas(el);

    expect(el.width).toBe(150);
    expect(el.height).toBe(150);
  });
});
