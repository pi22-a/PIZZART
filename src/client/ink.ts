import type { Point } from '../shared/drawing';

/**
 * 지금 밝은 모드인가.
 *
 * 캔버스는 CSS 변수를 못 쓰므로 색을 코드가 직접 골라야 한다. 안 그러면 밝은 모드에서
 * 흰 글씨가 흰 배경에 얹혀 통째로 사라진다 — 실제로 회차 숫자가 그랬다.
 */
export function isLight(): boolean {
  return document.documentElement.dataset.theme === 'light';
}
import { CANVAS } from '../shared/drawing';

/**
 * 잉크는 어디서 그리든 같은 굵기·같은 색이다.
 *
 * 예외는 대기 화면 낙서판 하나다 — 여럿이 같은 판에 갈기므로 사람마다 색이 달라야 한다.
 * 그래서 색과 굵기만 열어두고, 나머지 그리는 방식은 한 곳에 둔다.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Point[][],
  opts: { color?: string; width?: number } = {},
): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = opts.width ?? 8;
  ctx.strokeStyle = opts.color ?? '#2b2118';
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }
}

/**
 * 캔버스 픽셀 크기를 화면 크기와 dpr에 맞추고, 0~1000 좌표계로 그리기 위한 배율을 돌려준다.
 *
 * CSS에서 `aspect-ratio:1`로 정사각형을 잡아두므로 짧은 변을 기준으로 한다.
 * 이걸 안 하면 고해상도 화면에서 그림이 두 배로 늘어난다.
 */
export function fitCanvas(el: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(1, Math.min(el.clientWidth, el.clientHeight));
  const px = Math.round(size * dpr);
  // width만 검사하면 안 된다: 새로 만든 <canvas>는 기본값이 300x150이라,
  // CSS 150px에 dpr 2가 곱해져 목표 px가 정확히 300이 되는 흔한 경우
  // "이미 300이니 됐다"고 오판하고 height 150을 그대로 남긴다.
  // 그러면 정사각형이어야 할 비트맵이 300x150으로 눌린 채 그려진다.
  if (el.width !== px || el.height !== px) {
    el.width = px;
    el.height = px;
  }
  return el.width / CANVAS;
}

/**
 * 정사각형이 아닌 캔버스(대기 화면 낙서판)를 화면 폭에 맞춘다.
 *
 * fitCanvas는 짧은 변을 기준으로 잡아 정사각형만 다룬다. 낙서판은 가로로 긴 판이라
 * 같은 함수를 쓰면 세로가 잘린다.
 */
export function fitRect(el: HTMLCanvasElement, logicalW: number, logicalH: number): number {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, el.clientWidth);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssW * (logicalH / logicalW) * dpr);
  if (el.width !== w || el.height !== h) {
    el.width = w;
    el.height = h;
  }
  return el.width / logicalW;
}
